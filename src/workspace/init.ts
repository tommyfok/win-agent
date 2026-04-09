import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/connection.js';
import { createAllTables, patchMissingTables } from '../db/schema.js';
import { seedPermissions } from '../db/permissions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the templates directory (works both in src/ dev and dist/ production)
function getTemplatesDir(): string {
  // In production (dist/), templates are alongside the built files
  // We need to look for them relative to the project root
  const candidates = [
    path.resolve(__dirname, '../templates'), // dev: src/workspace -> src/templates
    path.resolve(__dirname, '../src/templates'), // dist: dist/ -> src/templates
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error('Templates directory not found. Looked in: ' + candidates.join(', '));
}

const WIN_AGENT_DIRS = [
  '', // .win-agent/
  'roles', // .win-agent/roles/
  'attachments', // .win-agent/attachments/
  'backups', // .win-agent/backups/
];

export interface InitResult {
  created: boolean; // true if newly created, false if already existed
  patched: string[]; // list of tables that were patched (missing → created)
}

export function initWorkspace(workspace: string): InitResult {
  const winAgentDir = path.join(workspace, '.win-agent');
  const dbPath = path.join(winAgentDir, 'win-agent.db');
  const alreadyExists = fs.existsSync(dbPath);

  // 1. Create directory structure
  for (const sub of WIN_AGENT_DIRS) {
    const dir = path.join(winAgentDir, sub);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // 2. Copy role prompt templates
  const templatesDir = getTemplatesDir();
  copyTemplates(path.join(templatesDir, 'roles'), path.join(winAgentDir, 'roles'), '.md');

  // 3. Initialize database
  const db = openDb(dbPath);

  if (alreadyExists) {
    // Patch mode: only add missing tables
    const patched = patchMissingTables(db);
    // Ensure permissions exist (INSERT OR IGNORE)
    seedPermissions(db);
    return { created: false, patched };
  }

  // Fresh init: create all tables + seed
  createAllTables(db);
  seedPermissions(db);

  return { created: true, patched: [] };
}

// ─── Code Detection ──────────────────────────────────────────────────────────

const CODE_INDICATORS = [
  'package.json',
  'tsconfig.json',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'requirements.txt',
  'pyproject.toml',
  'Makefile',
  'CMakeLists.txt',
  'src',
  'lib',
  'app',
];

function isCodeEntry(name: string): boolean {
  return (
    CODE_INDICATORS.includes(name) ||
    name.endsWith('.ts') ||
    name.endsWith('.js') ||
    name.endsWith('.py')
  );
}

/**
 * Detect whether a workspace contains existing code.
 * Checks root level and one level of subdirectories (monorepo support).
 */
export function detectExistingCode(workspace: string): boolean {
  const entries = fs.readdirSync(workspace);
  if (entries.some(isCodeEntry)) return true;
  return detectSubProjects(workspace).length > 0;
}

/**
 * Detect sub-projects in a monorepo workspace.
 * Returns directory names of subdirectories that contain code indicators.
 */
export function detectSubProjects(workspace: string): string[] {
  const entries = fs.readdirSync(workspace);
  const subProjects: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const subDir = path.join(workspace, entry);
    try {
      if (!fs.statSync(subDir).isDirectory()) continue;
      const subEntries = fs.readdirSync(subDir);
      if (subEntries.some(isCodeEntry)) subProjects.push(entry);
    } catch {
      /* permission error or symlink, skip */
    }
  }
  return subProjects;
}

function copyTemplates(srcDir: string, destDir: string, ext: string): void {
  if (!fs.existsSync(srcDir)) return;

  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(ext));
  for (const file of files) {
    const destFile = path.join(destDir, file);
    // Only copy if not already present (don't overwrite user edits)
    if (!fs.existsSync(destFile)) {
      fs.copyFileSync(path.join(srcDir, file), destFile);
    }
  }
}
