import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  syncAgentSkills,
  getAgentSkillsStatus,
  AGENT_SKILLS_BUNDLE_VERSION,
  AGENT_SKILLS_UPSTREAM_REF,
} from '../sync-agent-skills.js';

let workspaceDir: string;

beforeAll(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-skills-'));
});

afterAll(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function skillsRoot(): string {
  return path.join(workspaceDir, '.win-agent', 'skills', 'agent-skills');
}

function sourcePath(): string {
  return path.join(skillsRoot(), 'SOURCE.md');
}

function interviewSkillPath(): string {
  return path.join(skillsRoot(), 'skills', 'interview-me', 'SKILL.md');
}

// Tests run sequentially in definition order and share the same workspace,
// which mirrors how `win-agent init` accumulates state across syncs.
describe('syncAgentSkills', () => {
  it('fresh sync copies SOURCE.md and core SKILL.md files', () => {
    const result = syncAgentSkills(workspaceDir);
    expect(result.skipped).toBe(false);
    expect(result.synced).toContain('SOURCE.md');
    expect(result.synced).toContain(path.join('skills', 'interview-me', 'SKILL.md'));

    expect(fs.existsSync(sourcePath())).toBe(true);
    expect(fs.existsSync(interviewSkillPath())).toBe(true);
  });

  it('writes SOURCE.md with today date and auditable bundle provenance', () => {
    const content = fs.readFileSync(sourcePath(), 'utf-8');
    const today = new Date().toISOString().slice(0, 10);
    expect(content).toContain('Adapted from: https://github.com/addyosmani/agent-skills');
    expect(content).toContain(`Upstream ref: ${AGENT_SKILLS_UPSTREAM_REF}`);
    expect(content).toContain(`Bundle version: ${AGENT_SKILLS_BUNDLE_VERSION}`);
    expect(content).toContain(`Synced at: ${today}`);
    expect(content).not.toContain('- Commit:');
    expect(content).not.toContain('<pinned-commit>');
    expect(content).not.toContain('<bundle-version>');
    expect(content).not.toContain('<upstream-ref>');
    expect(content).not.toContain('<synced-at>');
  });

  it('second sync without force is skipped and does not overwrite user edits', () => {
    const skillFile = interviewSkillPath();
    const original = fs.readFileSync(skillFile, 'utf-8');
    fs.writeFileSync(skillFile, 'USER_EDITED_MARKER\n' + original, 'utf-8');

    const result = syncAgentSkills(workspaceDir);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('already synced');
    expect(result.synced).toEqual([]);

    // User edit is preserved (no overwrite).
    expect(fs.readFileSync(skillFile, 'utf-8')).toContain('USER_EDITED_MARKER');
  });

  it('force=true overwrites skill files with the bundled content', () => {
    const skillFile = interviewSkillPath();
    expect(fs.readFileSync(skillFile, 'utf-8')).toContain('USER_EDITED_MARKER');

    const result = syncAgentSkills(workspaceDir, { force: true });
    expect(result.skipped).toBe(false);
    expect(result.synced).toContain(path.join('skills', 'interview-me', 'SKILL.md'));

    const after = fs.readFileSync(skillFile, 'utf-8');
    expect(after).not.toContain('USER_EDITED_MARKER');
    expect(after).toContain('interview-me');
  });

  it('status returns installed=true with the full skill list after sync', () => {
    const status = getAgentSkillsStatus(workspaceDir);
    expect(status.installed).toBe(true);
    expect(status.commit).toBe(AGENT_SKILLS_BUNDLE_VERSION);
    expect(status.bundleVersion).toBe(AGENT_SKILLS_BUNDLE_VERSION);
    expect(status.upstreamRef).toBe(AGENT_SKILLS_UPSTREAM_REF);
    expect(status.syncedAt).toBe(new Date().toISOString().slice(0, 10));
    expect(status.skills).toContain('interview-me');
    expect(status.skills.length).toBeGreaterThanOrEqual(14);
  });

  it('status returns installed=false when the pack is not synced', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-skills-empty-'));
    try {
      const status = getAgentSkillsStatus(emptyDir);
      expect(status.installed).toBe(false);
      expect(status.skills).toEqual([]);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('throws instead of writing SOURCE.md when the bundled skills directory is missing', () => {
    const badBundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-skills-bad-bundle-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-skills-bad-target-'));
    try {
      expect(() => syncAgentSkills(targetDir, { sourceDir: badBundleDir })).toThrow(
        /missing skills directory/
      );
      expect(
        fs.existsSync(path.join(targetDir, '.win-agent', 'skills', 'agent-skills', 'SOURCE.md'))
      ).toBe(false);
    } finally {
      fs.rmSync(badBundleDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('throws instead of writing SOURCE.md when the bundle contains no SKILL.md files', () => {
    const badBundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-skills-empty-bundle-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-skills-empty-target-'));
    try {
      fs.mkdirSync(path.join(badBundleDir, 'skills', 'empty-folder'), { recursive: true });

      expect(() => syncAgentSkills(targetDir, { sourceDir: badBundleDir })).toThrow(
        /no SKILL\.md files/
      );
      expect(
        fs.existsSync(path.join(targetDir, '.win-agent', 'skills', 'agent-skills', 'SOURCE.md'))
      ).toBe(false);
    } finally {
      fs.rmSync(badBundleDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('throws instead of writing SOURCE.md when required core skills are missing', () => {
    const badBundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-skills-partial-bundle-'));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-skills-partial-target-'));
    try {
      const partialSkillDir = path.join(badBundleDir, 'skills', 'interview-me');
      fs.mkdirSync(partialSkillDir, { recursive: true });
      fs.writeFileSync(path.join(partialSkillDir, 'SKILL.md'), '# interview-me\n', 'utf-8');

      expect(() => syncAgentSkills(targetDir, { sourceDir: badBundleDir })).toThrow(
        /missing skills/
      );
      expect(
        fs.existsSync(path.join(targetDir, '.win-agent', 'skills', 'agent-skills', 'SOURCE.md'))
      ).toBe(false);
    } finally {
      fs.rmSync(badBundleDir, { recursive: true, force: true });
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });
});
