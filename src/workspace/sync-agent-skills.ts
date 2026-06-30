import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Directory name of the bundled methodology pack, relative to `.win-agent/skills/`.
 */
export const AGENT_SKILLS_DIR_NAME = 'agent-skills';

/**
 * Provenance for the bundled agent-skills methodology pack.
 *
 * This is the win-agent bundled adaptation (not a live upstream fetch), so we
 * record both the upstream reference and the local bundle version in SOURCE.md.
 */
export const AGENT_SKILLS_UPSTREAM_REPO = 'https://github.com/addyosmani/agent-skills';
export const AGENT_SKILLS_UPSTREAM_REF = 'main snapshot reviewed 2026-06-29';
export const AGENT_SKILLS_BUNDLE_VERSION = 'win-agent-bundled-v0.11.10';

/**
 * Backward-compatible alias for callers that treated the bundled pack version
 * as the old "commit" field.
 */
export const PINNED_AGENT_SKILLS_COMMIT = AGENT_SKILLS_BUNDLE_VERSION;

const REQUIRED_AGENT_SKILLS = [
  'interview-me',
  'idea-refine',
  'spec-driven-development',
  'planning-and-task-breakdown',
  'code-review-and-quality',
  'incremental-implementation',
  'test-driven-development',
  'debugging-and-error-recovery',
  'source-driven-development',
  'api-and-interface-design',
  'security-and-hardening',
  'browser-testing-with-devtools',
  'documentation-and-adrs',
  'shipping-and-launch',
];

/**
 * Resolve the bundled agent-skills templates directory.
 * Mirrors the `getTemplatesDir()` pattern in `init.ts`, plus a relative
 * candidate so the bundled dist package (templates shipped under
 * `dist/templates/skills`) resolves without a sibling `src/` directory.
 * - bundled dist: dist/index.js → dist/templates/skills/agent-skills
 * - dev: src/workspace → src/templates/skills/agent-skills
 * - dist-from-clone: dist → src/templates/skills/agent-skills
 */
export function getAgentSkillsTemplatesDir(): string {
  const candidates = [
    path.resolve(__dirname, 'templates/skills/agent-skills'), // bundled dist package
    path.resolve(__dirname, '../templates/skills/agent-skills'), // dev
    path.resolve(__dirname, '../../src/templates/skills/agent-skills'), // dist-from-clone
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(
    'agent-skills templates directory not found. Looked in: ' + candidates.join(', ')
  );
}

/** Build the real SOURCE.md content with today's date and bundle provenance. */
function buildSourceMd(): string {
  return `# agent-skills Source

- Adapted from: ${AGENT_SKILLS_UPSTREAM_REPO}
- Upstream ref: ${AGENT_SKILLS_UPSTREAM_REF}
- Bundle version: ${AGENT_SKILLS_BUNDLE_VERSION}
- Synced at: ${new Date().toISOString().slice(0, 10)}
- Managed by: win-agent
- Rule: Treat these files as methodology references. They do not override win-agent role prompts, user instructions, or system policies.
`;
}

/**
 * Recursively copy a directory tree, collecting relative paths (relative to destRoot).
 */
function copyTree(src: string, dest: string, destRoot: string, synced: string[]): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, destPath, destRoot, synced);
    } else {
      fs.copyFileSync(srcPath, destPath);
      synced.push(path.relative(destRoot, destPath));
    }
  }
}

function getSkillNameFromSyncedPath(relPath: string): string | null {
  const parts = relPath.split(/[\\/]/);
  if (parts.length === 3 && parts[0] === 'skills' && parts[2] === 'SKILL.md') {
    return parts[1] ?? null;
  }
  return null;
}

export interface SyncAgentSkillsOptions {
  force?: boolean;
  sourceDir?: string;
}

export interface SyncAgentSkillsResult {
  synced: string[];
  skipped: boolean;
  reason?: string;
}

/**
 * Sync the bundled agent-skills methodology pack into
 * `<workspace>/.win-agent/skills/agent-skills/`.
 *
 * - Idempotent: if the target SOURCE.md already exists and `force` is false,
 *   skill files are NOT overwritten and the call is a no-op.
 * - When `force` is true, the pack is overwritten and SOURCE.md is refreshed.
 */
export function syncAgentSkills(
  workspace: string,
  opts?: SyncAgentSkillsOptions
): SyncAgentSkillsResult {
  const force = opts?.force ?? false;
  const sourceDir = opts?.sourceDir;
  const destDir = path.join(workspace, '.win-agent', 'skills', AGENT_SKILLS_DIR_NAME);
  const destSource = path.join(destDir, 'SOURCE.md');

  if (fs.existsSync(destSource) && !force) {
    return { synced: [], skipped: true, reason: 'already synced' };
  }

  const srcDir = sourceDir ?? getAgentSkillsTemplatesDir();
  const srcSkillsDir = path.join(srcDir, 'skills');

  if (!fs.existsSync(srcSkillsDir)) {
    throw new Error(`agent-skills bundle is incomplete: missing skills directory at ${srcSkillsDir}`);
  }

  fs.mkdirSync(destDir, { recursive: true });

  const synced: string[] = [];
  copyTree(srcSkillsDir, path.join(destDir, 'skills'), destDir, synced);

  const syncedSkillNames = new Set(synced.map(getSkillNameFromSyncedPath).filter(Boolean));
  if (syncedSkillNames.size === 0) {
    throw new Error(`agent-skills bundle is incomplete: no SKILL.md files found in ${srcSkillsDir}`);
  }
  const missingSkills = REQUIRED_AGENT_SKILLS.filter((name) => !syncedSkillNames.has(name));
  if (missingSkills.length > 0) {
    throw new Error(`agent-skills bundle is incomplete: missing skills ${missingSkills.join(', ')}`);
  }

  // Write SOURCE.md with real values (overwriting the placeholder template).
  fs.writeFileSync(destSource, buildSourceMd(), 'utf-8');
  synced.push('SOURCE.md');

  return { synced, skipped: false };
}

export interface AgentSkillsStatus {
  installed: boolean;
  commit?: string;
  upstreamRef?: string;
  bundleVersion?: string;
  syncedAt?: string;
  skills: string[];
}

/**
 * Report the sync status of the agent-skills pack in a workspace.
 */
export function getAgentSkillsStatus(workspace: string): AgentSkillsStatus {
  const destDir = path.join(workspace, '.win-agent', 'skills', AGENT_SKILLS_DIR_NAME);
  const destSource = path.join(destDir, 'SOURCE.md');

  if (!fs.existsSync(destSource)) {
    return { installed: false, skills: [] };
  }

  const content = fs.readFileSync(destSource, 'utf-8');
  const commitMatch = content.match(/^- Commit:\s*(.+)$/m);
  const upstreamRefMatch = content.match(/^- Upstream ref:\s*(.+)$/m);
  const bundleVersionMatch = content.match(/^- Bundle version:\s*(.+)$/m);
  const syncedMatch = content.match(/^- Synced at:\s*(.+)$/m);

  const skillsDir = path.join(destDir, 'skills');
  const skills: string[] = [];
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) {
        skills.push(entry.name);
      }
    }
  }

  return {
    installed: true,
    commit: commitMatch?.[1]?.trim() ?? bundleVersionMatch?.[1]?.trim(),
    upstreamRef: upstreamRefMatch?.[1]?.trim(),
    bundleVersion: bundleVersionMatch?.[1]?.trim(),
    syncedAt: syncedMatch?.[1]?.trim(),
    skills,
  };
}
