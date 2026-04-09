import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ─── Tech stack detection ────────────────────────────────────────────────────

interface DetectedTech {
  keyword: string; // key into RECOMMENDED_SKILLS + used for `npx skills find`
  label: string; // human-readable name
}

/**
 * Detect the project's tech stack by scanning config/dependency files.
 * Returns a deduplicated list of technology keywords.
 */
export function detectTechStack(workspace: string): DetectedTech[] {
  const techs: DetectedTech[] = [];
  const seen = new Set<string>();

  function add(keyword: string, label: string) {
    if (seen.has(keyword)) return;
    seen.add(keyword);
    techs.push({ keyword, label });
  }

  // ── JavaScript / TypeScript ecosystem ──
  const pkgPath = path.join(workspace, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      } as Record<string, string>;

      // Language
      if (allDeps['typescript'] || fs.existsSync(path.join(workspace, 'tsconfig.json'))) {
        add('typescript', 'TypeScript');
      }

      // Frameworks
      if (allDeps['react']) add('react', 'React');
      if (allDeps['next']) add('nextjs', 'Next.js');
      if (allDeps['vue']) add('vue', 'Vue');
      if (allDeps['nuxt'] || allDeps['nuxt3']) add('nuxt', 'Nuxt');
      if (allDeps['@angular/core']) add('angular', 'Angular');
      if (allDeps['svelte'] || allDeps['@sveltejs/kit']) add('svelte', 'Svelte');
      if (allDeps['@nestjs/core']) add('nestjs', 'NestJS');
      if (allDeps['express']) add('express', 'Express');
      if (allDeps['react-native'] || allDeps['expo']) add('react-native', 'React Native');

      // CSS frameworks
      if (allDeps['tailwindcss']) add('tailwind', 'Tailwind CSS');

      // Testing
      if (allDeps['jest'] || allDeps['@jest/core']) add('jest', 'Jest');
      if (allDeps['vitest']) add('vitest', 'Vitest');
      if (allDeps['playwright'] || allDeps['@playwright/test']) add('playwright', 'Playwright');
      if (allDeps['cypress']) add('cypress', 'Cypress');

      // Fallback: if no specific framework detected, mark as Node.js
      if (
        techs.length === 0 ||
        (techs.length === 1 && techs[0].keyword === 'typescript')
      ) {
        add('nodejs', 'Node.js');
      }
    } catch {
      // malformed package.json, skip
    }
  }

  // ── Monorepo: scan sub-project package.json files ──
  for (const dir of ['packages', 'apps', 'services', 'libs']) {
    const dirPath = path.join(workspace, dir);
    if (!fs.existsSync(dirPath)) continue;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subPkgPath = path.join(dirPath, entry.name, 'package.json');
        if (!fs.existsSync(subPkgPath)) continue;
        try {
          const subPkg = JSON.parse(fs.readFileSync(subPkgPath, 'utf-8'));
          const subDeps = {
            ...subPkg.dependencies,
            ...subPkg.devDependencies,
          } as Record<string, string>;
          if (subDeps['react']) add('react', 'React');
          if (subDeps['next']) add('nextjs', 'Next.js');
          if (subDeps['vue']) add('vue', 'Vue');
          if (subDeps['@angular/core']) add('angular', 'Angular');
          if (subDeps['@nestjs/core']) add('nestjs', 'NestJS');
          if (subDeps['tailwindcss']) add('tailwind', 'Tailwind CSS');
        } catch {
          // skip malformed
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  // ── Go ──
  if (fs.existsSync(path.join(workspace, 'go.mod'))) {
    add('golang', 'Go');
  }

  // ── Python ──
  if (
    fs.existsSync(path.join(workspace, 'pyproject.toml')) ||
    fs.existsSync(path.join(workspace, 'requirements.txt')) ||
    fs.existsSync(path.join(workspace, 'setup.py'))
  ) {
    add('python', 'Python');
  }

  // ── Rust ──
  if (fs.existsSync(path.join(workspace, 'Cargo.toml'))) {
    add('rust', 'Rust');
  }

  // ── Java / Kotlin ──
  if (
    fs.existsSync(path.join(workspace, 'pom.xml')) ||
    fs.existsSync(path.join(workspace, 'build.gradle')) ||
    fs.existsSync(path.join(workspace, 'build.gradle.kts'))
  ) {
    add('java', 'Java/Kotlin');
  }

  return techs;
}

// ─── Recommended skills per tech ─────────────────────────────────────────────

interface SkillRecommendation {
  source: string; // npx skills add <source>
  label: string; // human-readable name
}

/**
 * Curated mapping of tech keyword → recommended high-quality skills.
 * Only includes well-maintained, high-install-count skills.
 */
const RECOMMENDED_SKILLS: Record<string, SkillRecommendation[]> = {
  typescript: [
    { source: 'wshobson/agents@typescript-advanced-types', label: 'TypeScript Advanced Types' },
  ],
  react: [
    {
      source: 'vercel-labs/agent-skills@vercel-react-best-practices',
      label: 'React Best Practices (Vercel)',
    },
  ],
  nextjs: [
    {
      source: 'wshobson/agents@nextjs-app-router-patterns',
      label: 'Next.js App Router Patterns',
    },
  ],
  vue: [
    { source: 'hyf0/vue-skills@vue-best-practices', label: 'Vue Best Practices' },
    { source: 'antfu/skills@vue', label: 'Vue (antfu)' },
  ],
  nuxt: [
    { source: 'antfu/skills@nuxt', label: 'Nuxt (antfu)' },
  ],
  angular: [
    { source: 'analogjs/angular-skills@angular-component', label: 'Angular Component Patterns' },
  ],
  nestjs: [
    {
      source: 'kadajett/agent-nestjs-skills@nestjs-best-practices',
      label: 'NestJS Best Practices',
    },
  ],
  nodejs: [
    {
      source: 'sickn33/antigravity-awesome-skills@nodejs-best-practices',
      label: 'Node.js Best Practices',
    },
  ],
  'react-native': [
    {
      source: 'vercel-labs/agent-skills@vercel-react-native-skills',
      label: 'React Native (Vercel)',
    },
  ],
  tailwind: [
    { source: 'wshobson/agents@tailwind-design-system', label: 'Tailwind Design System' },
  ],
  golang: [
    { source: 'samber/cc-skills-golang@golang-design-patterns', label: 'Go Design Patterns' },
  ],
  python: [
    { source: '0xbigboss/claude-code@python-best-practices', label: 'Python Best Practices' },
  ],
};

// ─── Installed skills check ──────────────────────────────────────────────────

interface InstalledSkill {
  name: string;
  scope: string;
}

/**
 * Get project-level installed skills only.
 * Global skills are excluded because win-agent enforces workspace-level skill isolation.
 */
function getInstalledSkills(): InstalledSkill[] {
  try {
    const projectJson = execSync('npx skills list --json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return JSON.parse(projectJson || '[]');
  } catch {
    return [];
  }
}

/**
 * Extract the skill name from a source string like "owner/repo@skill-name".
 * The installed skill name is typically the part after @.
 */
function skillNameFromSource(source: string): string {
  const atIdx = source.indexOf('@');
  return atIdx >= 0 ? source.slice(atIdx + 1) : source;
}

// ─── Main check function ─────────────────────────────────────────────────────

export interface SkillCheckResult {
  detectedTechs: DetectedTech[];
  missing: Array<{ tech: DetectedTech; skills: SkillRecommendation[] }>;
}

/**
 * Detect project tech stack and check for recommended skills.
 * Returns detected techs and any missing recommended skills.
 */
export function checkRecommendedSkills(workspace: string): SkillCheckResult {
  const detectedTechs = detectTechStack(workspace);
  if (detectedTechs.length === 0) {
    return { detectedTechs, missing: [] };
  }

  const installed = getInstalledSkills();
  const installedNames = new Set(installed.map((s) => s.name.toLowerCase()));

  const missing: SkillCheckResult['missing'] = [];

  for (const tech of detectedTechs) {
    const recommended = RECOMMENDED_SKILLS[tech.keyword];
    if (!recommended) continue;

    const missingSkills = recommended.filter(
      (skill) => !installedNames.has(skillNameFromSource(skill.source).toLowerCase())
    );
    if (missingSkills.length > 0) {
      missing.push({ tech, skills: missingSkills });
    }
  }

  return { detectedTechs, missing };
}

/**
 * Print skill recommendations to console.
 * Returns true if there are missing skills.
 */
export function printSkillRecommendations(result: SkillCheckResult): boolean {
  if (result.missing.length === 0) return false;

  console.log('\n💡 根据项目技术栈，建议安装以下 Skills（项目级）以获得更好的开发指导：');
  console.log('   ⚠️  win-agent 仅加载项目级 Skills，请勿使用 -g 全局安装');
  console.log('');

  for (const { tech, skills } of result.missing) {
    for (const skill of skills) {
      console.log(`   npx skills add ${skill.source}`);
      console.log(`   # ${tech.label} → ${skill.label}`);
      console.log('');
    }
  }

  const techKeywords = result.detectedTechs.map((t) => t.keyword);
  console.log(`   💡 查找更多 Skills: npx skills find <关键词>`);
  console.log(`      检测到的技术栈: ${techKeywords.join(', ')}`);

  return true;
}
