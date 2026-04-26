import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm, select } from '@inquirer/prompts';
import { openDb, closeDb, getDb } from '../db/connection.js';
import { select as dbSelect } from '../db/repository.js';
import { getDbPath } from '../config/index.js';
import { syncAgents, deployTools } from '../workspace/sync-agents.js';
import { startOpencodeServer, removeServerInfo } from '../engine/opencode-server.js';
import {
  snapshotRoleMtimes,
  cleanOverviewOutput,
  buildDevelopmentDocPrompt,
  buildValidationDocPrompt,
  buildAgentsMd,
} from './init.js';
import { detectExistingCode, detectSubProjects } from '../workspace/init.js';
import { AGENTS_MD_FILENAME, LEGACY_AGENT_MD_FILENAME } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the package templates directory.
 * Mirrors the logic in src/workspace/init.ts getTemplatesDir().
 */
function getTemplatesDir(): string {
  const candidates = [
    path.resolve(__dirname, '../templates'), // dev: src/workspace/ -> src/templates/
    path.resolve(__dirname, '../src/templates'), // dist: dist/ -> src/templates/
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error('找不到包内模板目录，已尝试:\n' + candidates.map((c) => `  ${c}`).join('\n'));
}

import { buildWorkspaceAnalysisPrompt } from './init.js';

const PROJECT_CONTEXT_SENTINEL =
  /<!-- win-agent:project-context -->[\s\S]*?<!-- \/win-agent:project-context -->\n?/;

export async function updateCommand() {
  try {
    await _updateCommand();
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.name === 'ExitPromptError' || err.message?.includes('User force closed'))
    ) {
      console.log('\n👋 已取消');
      process.exit(0);
    }
    throw err;
  }
}

async function _updateCommand() {
  const workspace = process.cwd();
  const rolesDir = path.join(workspace, '.win-agent', 'roles');

  if (!fs.existsSync(rolesDir)) {
    console.log('⚠️  工作空间未初始化，请先执行: npx win-agent init');
    process.exit(1);
  }

  let templatesDir: string;
  try {
    templatesDir = path.join(getTemplatesDir(), 'roles');
  } catch (err: unknown) {
    console.log(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Ensure DB is open
  const dbPath = getDbPath(workspace);
  try {
    getDb();
  } catch {
    openDb(dbPath);
  }

  console.log('\n📦 win-agent update\n');

  // ── Step 1: 更新文档 (overview / development / validation) ──
  await updateDocs(workspace);

  // ── Step 2: 检查角色文件中的 overview 引用 ──
  ensureOverviewReference(workspace);

  // ── Step 3: AI 融合角色模板 ──
  await mergeRoleTemplates(workspace, templatesDir);

  // Validate role configs and deploy tools
  syncAgents(workspace);
  deployTools(workspace);

  // Update mtime snapshot
  snapshotRoleMtimes(workspace);

  closeDb();
  console.log('\n✅ 更新完成');
  console.log('   如引擎正在运行，重启后生效: npx win-agent stop && npx win-agent start');
}

// ─── Step 1: 更新文档 ────────────────────────────────────────────────────────

interface DocSpec {
  file: string;
  label: string;
  header: string;
  headerNote: string;
  buildPrompt: (subProjects: string[]) => string;
}

const DOC_SPECS: DocSpec[] = [
  {
    file: 'overview.md',
    label: '项目概览',
    header: '# 项目概览',
    headerNote: '',
    buildPrompt: buildWorkspaceAnalysisPrompt,
  },
  {
    file: 'development.md',
    label: '开发流程规范',
    header: '# 开发流程规范',
    headerNote: '，请审阅并补充标记为 TODO 的部分',
    buildPrompt: buildDevelopmentDocPrompt,
  },
  {
    file: 'validation.md',
    label: '自测与验收规范',
    header: '# 自测与验收规范',
    headerNote: '，请审阅并补充标记为 TODO 的部分',
    buildPrompt: buildValidationDocPrompt,
  },
];

async function updateDocs(workspace: string) {
  console.log('1️⃣  更新项目文档');

  const hasCode = detectExistingCode(workspace);
  if (!hasCode) {
    console.log('   空目录，跳过');
    return;
  }

  const docsDir = path.join(workspace, '.win-agent', 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  // Ask which docs to regenerate
  const toUpdate: DocSpec[] = [];
  for (const spec of DOC_SPECS) {
    const filePath = path.join(docsDir, spec.file);
    const exists = fs.existsSync(filePath);
    const doIt = await confirm({
      message: exists ? `重新生成 ${spec.file}？` : `生成 ${spec.file}？`,
      default: !exists,
    });
    if (doIt) toUpdate.push(spec);
  }

  if (toUpdate.length === 0) {
    console.log('   已跳过');
    return;
  }

  const subProjects = detectSubProjects(workspace);
  let serverHandle: Awaited<ReturnType<typeof startOpencodeServer>> | null = null;
  try {
    serverHandle = await startOpencodeServer(workspace);
    const { client } = serverHandle;

    const session = await client.session.create({ body: { title: 'wa-update-docs' } });
    const sessionId = session.data!.id;

    for (const spec of toUpdate) {
      const filePath = path.join(docsDir, spec.file);
      console.log(`   → 生成${spec.label} (${spec.file})...`);

      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: spec.buildPrompt(subProjects) }],
        },
      });

      const textParts = result.data?.parts?.filter(
        (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
      );
      const content = cleanOverviewOutput(textParts?.map((p) => p.text).join('\n') ?? '');

      // Backup existing file
      if (fs.existsSync(filePath)) {
        const backupsDir = path.join(workspace, '.win-agent', 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const baseName = path.basename(spec.file, '.md');
        fs.copyFileSync(filePath, path.join(backupsDir, `${baseName}.${timestamp}.md`));
      }

      fs.writeFileSync(
        filePath,
        `${spec.header}\n\n_由 \`win-agent update\` 自动生成${spec.headerNote}_\n\n${content}`,
        'utf-8'
      );
      console.log(`   ✓ 已写入 .win-agent/docs/${spec.file}`);

      // When overview.md is regenerated, also update root AGENTS.md
      if (spec.file === 'overview.md') {
        const projectName =
          dbSelect<{ key: string; value: string }>('project_config', { key: 'projectName' })[0]
            ?.value ?? '';
        const projectDescription =
          dbSelect<{ key: string; value: string }>('project_config', {
            key: 'projectDescription',
          })[0]?.value ?? '';
        const agentMdPath = path.join(workspace, AGENTS_MD_FILENAME);
        const legacyAgentMdPath = path.join(workspace, LEGACY_AGENT_MD_FILENAME);
        const backupRootAgentMd = (filePath: string, backupPrefix: string) => {
          const agentBackupsDir = path.join(workspace, '.win-agent', 'backups');
          fs.mkdirSync(agentBackupsDir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          fs.copyFileSync(filePath, path.join(agentBackupsDir, `${backupPrefix}.${ts}.md`));
        };
        if (fs.existsSync(agentMdPath)) {
          backupRootAgentMd(agentMdPath, 'AGENTS');
        }
        if (fs.existsSync(legacyAgentMdPath)) {
          backupRootAgentMd(legacyAgentMdPath, 'AGENT');
          fs.unlinkSync(legacyAgentMdPath);
        }
        fs.writeFileSync(
          agentMdPath,
          buildAgentsMd(projectName, projectDescription, content),
          'utf-8'
        );
        console.log(`   ✓ 已同步更新 ${AGENTS_MD_FILENAME}（根目录）`);
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'INSTALL_FAILED') {
      throw err;
    }
    console.log(`   ⚠️  文档生成失败，跳过: ${err}`);
  } finally {
    if (serverHandle?.owned) {
      serverHandle.close();
      removeServerInfo(workspace);
    }
  }
}

// ─── Step 2: 检查 overview 引用 ──────────────────────────────────────────────

function ensureOverviewReference(workspace: string) {
  console.log('\n2️⃣  检查角色文件中的 overview 引用');

  const rolesDir = path.join(workspace, '.win-agent', 'roles');
  const overviewPath = path.join(workspace, '.win-agent', 'docs', 'overview.md');
  const overviewExists = fs.existsSync(overviewPath);

  if (!overviewExists) {
    console.log('   overview.md 不存在，跳过引用检查');
    return;
  }

  const projectName =
    dbSelect<{ key: string; value: string }>('project_config', { key: 'projectName' })[0]?.value ??
    '';
  const projectDescription =
    dbSelect<{ key: string; value: string }>('project_config', { key: 'projectDescription' })[0]
      ?.value ?? '';

  let fixed = 0;
  for (const file of fs.readdirSync(rolesDir)) {
    if (!file.endsWith('.md')) continue;
    if (/^(PM|DEV)-/i.test(file)) continue; // role auxiliary files don't need project context
    const filePath = path.join(rolesDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');

    if (PROJECT_CONTEXT_SENTINEL.test(content)) {
      // Check if the existing block has the overview reference line
      const match = content.match(PROJECT_CONTEXT_SENTINEL);
      if (match && match[0].includes('overview.md')) {
        continue; // Already has reference
      }
      // Has project context block but missing overview reference — update it
      const block = buildProjectContextBlock(projectName, projectDescription);
      const updated = content.replace(PROJECT_CONTEXT_SENTINEL, block);
      fs.writeFileSync(filePath, updated, 'utf-8');
      console.log(`   ✓ ${file}: 已补充 overview 引用`);
      fixed++;
    } else {
      // No project context block at all — inject one
      const block = buildProjectContextBlock(projectName, projectDescription);
      const firstNewline = content.indexOf('\n') + 1;
      const updated = content.slice(0, firstNewline) + '\n' + block + content.slice(firstNewline);
      fs.writeFileSync(filePath, updated, 'utf-8');
      console.log(`   ✓ ${file}: 已注入项目上下文（含 overview 引用）`);
      fixed++;
    }
  }

  if (fixed === 0) {
    console.log('   ✓ 所有角色文件已包含 overview 引用');
  }
}

function buildProjectContextBlock(projectName: string, projectDescription: string): string {
  return [
    '<!-- win-agent:project-context -->',
    '## 项目背景',
    `- **项目名称**: ${projectName}`,
    `- **项目描述**: ${projectDescription}`,
    '- **技术概览**: 详见 `.win-agent/docs/overview.md`',
    '<!-- /win-agent:project-context -->',
    '',
  ].join('\n');
}

// ─── Step 3: AI 融合角色模板 ─────────────────────────────────────────────────

interface RoleDiff {
  file: string;
  templateContent: string;
  workspaceContent: string;
}

async function mergeRoleTemplates(workspace: string, templatesDir: string) {
  console.log('\n3️⃣  角色模板融合');

  const rolesDir = path.join(workspace, '.win-agent', 'roles');
  const templateFiles = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.md'));

  const newFiles: string[] = [];
  const upToDate: string[] = [];
  const diffs: RoleDiff[] = [];

  for (const file of templateFiles) {
    const templatePath = path.join(templatesDir, file);
    const workspacePath = path.join(rolesDir, file);
    const templateContent = fs.readFileSync(templatePath, 'utf-8');

    // Role auxiliary files (PM-xxx.md, DEV-xxx.md) are not user-editable — always overwrite
    if (/^(PM|DEV)-/i.test(file)) {
      fs.copyFileSync(templatePath, workspacePath);
      upToDate.push(file);
      continue;
    }

    if (!fs.existsSync(workspacePath)) {
      // New role file — just copy it
      fs.copyFileSync(templatePath, workspacePath);
      newFiles.push(file);
    } else {
      const workspaceContent = fs.readFileSync(workspacePath, 'utf-8');
      // Strip project-context block before comparing (it's injected, not part of template)
      const strippedWorkspace = workspaceContent.replace(PROJECT_CONTEXT_SENTINEL, '').trim();
      const strippedTemplate = templateContent.replace(PROJECT_CONTEXT_SENTINEL, '').trim();

      if (strippedTemplate === strippedWorkspace) {
        upToDate.push(file);
      } else {
        diffs.push({ file, templateContent, workspaceContent });
      }
    }
  }

  if (newFiles.length > 0) {
    console.log(`   ＋ 新增角色: ${newFiles.join(', ')}`);
  }
  if (upToDate.length > 0) {
    console.log(`   ✅ 已是最新: ${upToDate.join(', ')}`);
  }

  if (diffs.length === 0) {
    console.log('   🎉 所有角色模板均已是最新版本');
    return;
  }

  console.log(`\n   📝 发现 ${diffs.length} 个角色文件与最新模板不同:`);
  for (const d of diffs) {
    const oldLines = d.workspaceContent.split('\n').length;
    const newLines = d.templateContent.split('\n').length;
    const delta = newLines - oldLines;
    const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
    console.log(`      ≠ ${d.file}  (${oldLines} 行 → ${newLines} 行, ${deltaStr})`);
  }

  const mode = await select({
    message: '如何处理差异文件？',
    choices: [
      { name: 'AI 智能融合（推荐：分析差异，保留项目定制，合入模板更新）', value: 'ai-merge' },
      { name: '全部覆盖（丢弃所有自定义修改）', value: 'overwrite' },
      { name: '逐个确认覆盖', value: 'one-by-one' },
      { name: '跳过', value: 'skip' },
    ],
  });

  if (mode === 'skip') {
    console.log('   已跳过');
    return;
  }

  const backupsDir = path.join(workspace, '.win-agent', 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  if (mode === 'ai-merge') {
    await aiMergeRoles(workspace, diffs, backupsDir, timestamp);
    return;
  }

  // overwrite / one-by-one
  let updated = 0;
  let skipped = 0;

  for (const d of diffs) {
    if (mode === 'one-by-one') {
      let yes: boolean;
      try {
        yes = await confirm({ message: `覆盖 ${d.file}？`, default: false });
      } catch {
        console.log('\n已取消');
        break;
      }
      if (!yes) {
        console.log(`   ⏭  跳过: ${d.file}`);
        skipped++;
        continue;
      }
    }

    // Backup
    const backupName = `${path.basename(d.file, '.md')}.${timestamp}.md`;
    fs.writeFileSync(path.join(backupsDir, backupName), d.workspaceContent, 'utf-8');

    // Overwrite
    const destPath = path.join(workspace, '.win-agent', 'roles', d.file);
    fs.writeFileSync(destPath, d.templateContent, 'utf-8');
    console.log(`   ✓ 已覆盖: ${d.file}`);
    updated++;
  }

  if (updated > 0 || skipped > 0) {
    console.log(`   完成: ${updated} 个已更新` + (skipped > 0 ? `，${skipped} 个已跳过` : ''));
  }
}

async function aiMergeRoles(
  workspace: string,
  diffs: RoleDiff[],
  backupsDir: string,
  timestamp: string
) {
  console.log('\n   → 启动 AI 融合分析...');

  let serverHandle: Awaited<ReturnType<typeof startOpencodeServer>> | null = null;
  try {
    serverHandle = await startOpencodeServer(workspace);
    const { client } = serverHandle;

    for (const d of diffs) {
      console.log(`\n   📄 融合 ${d.file}...`);

      // Backup before merge
      const backupName = `${path.basename(d.file, '.md')}.${timestamp}.md`;
      fs.writeFileSync(path.join(backupsDir, backupName), d.workspaceContent, 'utf-8');

      const session = await client.session.create({
        body: { title: `wa-update-merge-${d.file}` },
      });
      const sessionId = session.data!.id;

      const mergePrompt = buildMergePrompt(d);

      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: mergePrompt }],
        },
      });

      const textParts = result.data?.parts?.filter(
        (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
      );
      const merged = extractMergedContent(textParts?.map((p) => p.text).join('\n') ?? '');

      if (!merged) {
        console.log(`   ⚠️  ${d.file}: AI 未返回有效融合结果，跳过`);
        continue;
      }

      // Show summary and confirm
      const mergedLines = merged.split('\n').length;
      console.log(`   → ${d.file}: 融合结果 ${mergedLines} 行`);

      const accept = await confirm({
        message: `   接受 ${d.file} 的融合结果？（备份已保存）`,
        default: true,
      });

      if (accept) {
        const destPath = path.join(workspace, '.win-agent', 'roles', d.file);
        fs.writeFileSync(destPath, merged, 'utf-8');
        console.log(`   ✓ ${d.file}: 已更新`);
      } else {
        console.log(`   ⏭  ${d.file}: 已跳过`);
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'INSTALL_FAILED') {
      throw err;
    }
    console.log(`   ⚠️  AI 融合失败: ${err}`);
    console.log('   可重新运行 update 并选择「全部覆盖」或「逐个确认」');
  } finally {
    if (serverHandle?.owned) {
      serverHandle.close();
      removeServerInfo(workspace);
    }
  }
}

function buildMergePrompt(diff: RoleDiff): string {
  return `你是一个角色文件融合专家。你需要将 win-agent 的最新角色模板与用户已定制的角色文件进行智能融合。

## 融合原则

1. **保留用户定制内容**：用户对角色文件的修改（如新增的章节、调整的规则、项目特有的约定）必须保留
2. **合入模板更新**：新版模板中新增的功能、修改的流程、优化的措辞应当合入
3. **解决冲突**：同一段落模板和用户都有修改时，优先保留用户的定制意图，但融入模板的结构性改进
4. **保持完整性**：融合后的文件必须是完整可用的角色定义，不能有遗漏或断裂
5. **项目上下文块不处理**：\`<!-- win-agent:project-context -->\` 包裹的内容由系统自动管理，融合时原样保留工作空间中的版本

## 当前工作空间的角色文件（${diff.file}）

\`\`\`markdown
${diff.workspaceContent}
\`\`\`

## 最新模板的角色文件（${diff.file}）

\`\`\`markdown
${diff.templateContent}
\`\`\`

## 输出要求

1. 先简要分析两个版本的差异（2-3 句话）
2. 然后输出融合后的完整角色文件，用以下标记包裹：

\`\`\`merged
（完整的融合后角色文件内容）
\`\`\`

只输出分析和融合结果，不需要其他解释。`;
}

function extractMergedContent(response: string): string | null {
  // Extract content between ```merged and ```
  const match = response.match(/```merged\n([\s\S]*?)```/);
  if (match) return match[1].trimEnd() + '\n';

  // Fallback: try generic markdown code block
  const fallback = response.match(/```markdown\n([\s\S]*?)```/);
  if (fallback) return fallback[1].trimEnd() + '\n';

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
