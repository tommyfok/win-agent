import fs from 'node:fs';
import path from 'node:path';
import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { detectSubProjects } from '../workspace/init.js';

const execAsync = promisify(exec);

// ─── Types ──────────────────────────────────────────────────────────────────────

interface SkillCandidate {
  source: string; // e.g. "vercel-labs/agent-skills@vercel-react-best-practices"
  installs: number; // parsed install count
  keyword: string; // which search keyword found this
}

export interface SkillRecommendation {
  source: string;
  installs: number;
  reason: string;
}

// ─── Parse `npx skills find` output ─────────────────────────────────────────────

/**
 * Parse the colourful CLI output of `npx skills find <keyword>`.
 *
 * After stripping ANSI codes each result looks like:
 *   owner/repo@skill-name  229.8K installs
 *   └ https://skills.sh/...
 */
function parseSkillsFindOutput(raw: string, keyword: string): SkillCandidate[] {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const results: SkillCandidate[] = [];

  for (const line of clean.split('\n')) {
    const m = line.match(/^(\S+@\S+)\s+([\d.]+)(K?)\s+installs/);
    if (!m) continue;
    let installs = parseFloat(m[2]);
    if (m[3] === 'K') installs *= 1000;
    if (installs >= 2_000) {
      results.push({ source: m[1], installs, keyword });
    }
  }

  return results;
}

// ─── Search skills in parallel ──────────────────────────────────────────────────

async function searchSkillsByKeywords(keywords: string[]): Promise<SkillCandidate[]> {
  const results = await Promise.all(
    keywords.map(async (kw) => {
      try {
        const { stdout } = await execAsync(`npx skills find ${kw} 2>/dev/null`, {
          timeout: 15_000,
        });
        return parseSkillsFindOutput(stdout, kw);
      } catch {
        return [];
      }
    }),
  );

  // Deduplicate by source – keep the entry with highest installs
  const seen = new Map<string, SkillCandidate>();
  for (const c of results.flat()) {
    const existing = seen.get(c.source);
    if (!existing || c.installs > existing.installs) {
      seen.set(c.source, c);
    }
  }

  return [...seen.values()].sort((a, b) => b.installs - a.installs);
}

// ─── Installed-skills check ─────────────────────────────────────────────────────

function getInstalledSkillNames(): Set<string> {
  try {
    const json = execSync('npx skills list --json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const skills = JSON.parse(json || '[]') as Array<{ name: string }>;
    return new Set(skills.map((s) => s.name.toLowerCase()));
  } catch {
    return new Set();
  }
}

// ─── Tech stack scanning ────────────────────────────────────────────────────

/**
 * Scan workspace for package.json / requirements.txt / go.mod etc. and extract
 * dependency names. For monorepos, also checks sub-project directories.
 * Returns a deduplicated list of dependency names (lowercased).
 */
function collectDependencyNames(workspace: string): string[] {
  const deps = new Set<string>();

  const scanPackageJson = (dir: string) => {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      for (const section of ['dependencies', 'devDependencies']) {
        if (pkg[section] && typeof pkg[section] === 'object') {
          for (const name of Object.keys(pkg[section])) {
            // Strip scope prefix for matching (e.g. @tarojs/taro -> tarojs/taro)
            const clean = name.startsWith('@') ? name.slice(1) : name;
            deps.add(clean.toLowerCase());
          }
        }
      }
    } catch { /* malformed json, skip */ }
  };

  const scanRequirementsTxt = (dir: string) => {
    const reqPath = path.join(dir, 'requirements.txt');
    if (!fs.existsSync(reqPath)) return;
    try {
      const content = fs.readFileSync(reqPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const name = trimmed.split(/[>=<![;]/)[0].trim();
        if (name) deps.add(name.toLowerCase());
      }
    } catch { /* skip */ }
  };

  const scanPyprojectToml = (dir: string) => {
    const pyPath = path.join(dir, 'pyproject.toml');
    if (!fs.existsSync(pyPath)) return;
    try {
      const content = fs.readFileSync(pyPath, 'utf-8');
      // Simple extraction: lines like "package-name >= 1.0" under dependencies
      const depSection = content.match(/\[project\.dependencies\]\s*\n([\s\S]*?)(?:\n\[|$)/);
      if (depSection) {
        for (const line of depSection[1].split('\n')) {
          const m = line.match(/^\s*"?([a-zA-Z0-9_-]+)/);
          if (m) deps.add(m[1].toLowerCase());
        }
      }
    } catch { /* skip */ }
  };

  // Scan root
  scanPackageJson(workspace);
  scanRequirementsTxt(workspace);
  scanPyprojectToml(workspace);

  // Scan sub-projects (monorepo)
  for (const sub of detectSubProjects(workspace)) {
    const subDir = path.join(workspace, sub);
    scanPackageJson(subDir);
    scanRequirementsTxt(subDir);
    scanPyprojectToml(subDir);
  }

  return [...deps];
}

// ─── LLM helpers ────────────────────────────────────────────────────────────────

/**
 * Ask the LLM to extract concise search keywords from the project overview
 * and actual dependency list. Returns an array like ["nestjs", "typeorm", "react", ...].
 */
async function extractKeywords(
  client: OpencodeClient,
  sessionId: string,
  overviewContent: string,
  dependencyNames: string[],
): Promise<string[]> {
  const depsSection = dependencyNames.length > 0
    ? `\n## 项目实际依赖列表（从 package.json / requirements.txt 等扫描）\n${dependencyNames.join(', ')}`
    : '';

  const prompt = `根据以下项目概览和实际依赖列表，提取用于在 Skills 市场搜索的技术关键词（6-15个）。
关键词应为具体的技术名称（框架、语言、工具），例如 nestjs、react、tailwind、taro、golang 等。
优先提取核心框架和重要工具库的关键词，不要提取过于通用的词（如 lodash、utils 等工具库）。
注意：这是一个可能包含多个子项目的 monorepo，请确保覆盖所有子项目的主要技术栈。
只返回 JSON 数组，不要其他内容。

## 项目概览
${overviewContent}
${depsSection}

返回格式示例: ["nestjs", "typeorm", "typescript", "taro", "react-native"]`;

  const text = await promptSession(client, sessionId, prompt);
  const m = text.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as string[];
    return arr.filter((k) => typeof k === 'string' && k.length > 0).slice(0, 15);
  } catch {
    return [];
  }
}

/**
 * Ask the LLM to evaluate candidate skills and return ranked recommendations.
 * Scoring: install count 60% weight + project relevance 40% weight.
 */
async function evaluateSkills(
  client: OpencodeClient,
  sessionId: string,
  candidates: SkillCandidate[],
  overviewContent: string,
): Promise<SkillRecommendation[]> {
  const candidateList = candidates
    .map((c, i) => `${i + 1}. ${c.source}  (${formatInstalls(c.installs)} installs)`)
    .join('\n');

  const prompt = `你是技术评估专家。根据以下项目概览和候选 Skills 列表，推荐适合该项目的 Skills。

## 评分标准
- 安装量权重 60%：安装量越高，说明社区认可度越高
- 项目匹配度权重 40%：与项目技术栈和需求的匹配程度

## 项目概览
${overviewContent}

## 候选 Skills
${candidateList}

## 要求
1. 推荐所有与项目技术栈相关的 Skills（不限数量，宁多勿少——用户可以自己选择安装哪些）
2. 排除明显不相关的（如项目不用某技术就别推荐该技术的 skill）
3. 按推荐度从高到低排序
4. 返回 JSON 数组格式，不要包含其他内容：
[{"source": "完整的source字符串", "reason": "推荐理由（一句话）"}]`;

  const text = await promptSession(client, sessionId, prompt);
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];

  try {
    const parsed = JSON.parse(m[0]) as Array<{ source: string; reason: string }>;
    return parsed
      .map((r) => {
        const c = candidates.find((c) => c.source === r.source);
        return c ? { source: r.source, installs: c.installs, reason: r.reason } : null;
      })
      .filter((r): r is SkillRecommendation => r !== null);
  } catch {
    return [];
  }
}

/** Send a prompt to an opencode session and return the text response. */
async function promptSession(
  client: OpencodeClient,
  sessionId: string,
  prompt: string,
): Promise<string> {
  const result = await client.session.prompt({
    path: { id: sessionId },
    body: {
      agent: 'DEV',
      parts: [{ type: 'text', text: prompt }],
    },
  });
  const textParts = result.data?.parts?.filter(
    (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text',
  );
  return textParts?.map((p) => p.text).join('\n') ?? '';
}

// ─── Display & install ──────────────────────────────────────────────────────────

function formatInstalls(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
}

async function selectSkillsToInstall(
  recommendations: SkillRecommendation[],
): Promise<SkillRecommendation[]> {
  const { checkbox } = await import('@inquirer/prompts');
  const selected = await checkbox<string>({
    message: '选择要安装的 Skills（空格选择/取消，回车确认）：',
    pageSize: 25,
    loop: false,
    choices: recommendations.map((rec) => ({
      name: `${rec.source}  (${formatInstalls(rec.installs)} installs)\n     └ ${rec.reason}`,
      value: rec.source,
      checked: true,
    })),
  });
  return recommendations.filter((r) => selected.includes(r.source));
}

function installSkills(recommendations: SkillRecommendation[]): void {
  for (const rec of recommendations) {
    console.log(`   → 安装 ${rec.source} ...`);
    try {
      execSync(`npx skills add ${rec.source} -y`, {
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`   ✓ ${rec.source}`);
    } catch {
      console.log(`   ✗ ${rec.source} 安装失败`);
    }
  }
}

// ─── Main entry point ───────────────────────────────────────────────────────────

/**
 * Full skill-recommendation flow:
 * 1. Read overview.md → LLM extracts search keywords
 * 2. `npx skills find` in parallel for each keyword
 * 3. LLM evaluates candidates (installs 60% + relevance 40%)
 * 4. Print recommendations → user confirms → batch install
 */
export async function checkAndInstallSkills(
  workspace: string,
  client: OpencodeClient,
): Promise<void> {
  // Read overview.md
  const overviewPath = path.join(workspace, '.win-agent', 'docs', 'overview.md');
  if (!fs.existsSync(overviewPath)) {
    console.log('   ⚠️  未找到项目概览 (overview.md)，跳过 Skills 推荐');
    return;
  }
  const overviewContent = fs.readFileSync(overviewPath, 'utf-8');

  // Create a temporary session for LLM calls
  const session = await client.session.create({ body: { title: 'wa-skills-eval' } });
  const sessionId = session.data!.id;

  // Step 1: Scan actual dependencies + LLM extract keywords from overview
  console.log('   → 扫描项目依赖...');
  const dependencyNames = collectDependencyNames(workspace);
  if (dependencyNames.length > 0) {
    console.log(`   发现 ${dependencyNames.length} 个依赖`);
  }

  console.log('   → 分析项目技术栈...');
  const keywords = await extractKeywords(client, sessionId, overviewContent, dependencyNames);
  if (keywords.length === 0) {
    console.log('   未识别到技术关键词，跳过 Skills 推荐');
    return;
  }
  console.log(`   技术栈关键词: ${keywords.join(', ')}`);

  // Step 2: Search skills in parallel
  console.log('   → 搜索候选 Skills...');
  const allCandidates = await searchSkillsByKeywords(keywords);
  if (allCandidates.length === 0) {
    console.log('   未找到候选 Skills');
    return;
  }

  // Filter out already-installed skills
  const installed = getInstalledSkillNames();
  const candidates = allCandidates.filter((c) => {
    const name = c.source.includes('@') ? c.source.split('@').pop()! : c.source;
    return !installed.has(name.toLowerCase());
  });
  if (candidates.length === 0) {
    console.log('   ✓ 推荐的 Skills 均已安装');
    return;
  }

  // Limit to top candidates per keyword (avoid overwhelming the LLM)
  const topCandidates = candidates.slice(0, 30);

  // Step 3: LLM evaluates relevance
  console.log(`   → 评估 ${topCandidates.length} 个候选 Skills 的适配度...`);
  const recommendations = await evaluateSkills(client, sessionId, topCandidates, overviewContent);
  if (recommendations.length === 0) {
    console.log('   ✓ 无适合的 Skills 推荐');
    return;
  }

  // Step 4: Let user select which skills to install
  console.log(`\n💡 根据项目技术栈，找到 ${recommendations.length} 个推荐 Skills：\n`);
  const selected = await selectSkillsToInstall(recommendations);
  if (selected.length === 0) {
    console.log('   未选择任何 Skills，跳过安装');
    return;
  }

  installSkills(selected);
  console.log('\n   ✓ Skills 安装完成');
}
