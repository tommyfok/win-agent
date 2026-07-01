import { execSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installMandatorySkills } from '../skills.js';

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(),
}));

const execSyncMock = vi.mocked(execSync);

describe('installMandatorySkills', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  it('installs mandatory workflow skills for OpenCode PM/DEV sessions', () => {
    execSyncMock.mockImplementation((cmd) => {
      if (String(cmd).startsWith('npx skills list')) return '[]';
      return '';
    });

    const installed = installMandatorySkills();

    expect(installed).toBeGreaterThan(0);
    const installCommands = execSyncMock.mock.calls
      .map(([cmd]) => String(cmd))
      .filter((cmd) => cmd.startsWith('npx skills add'));

    expect(installCommands).toContain(
      'npx skills add addyosmani/agent-skills --agent opencode --skill using-agent-skills -y'
    );
    expect(installCommands).toContain(
      'npx skills add addyosmani/agent-skills --agent opencode --skill incremental-implementation -y'
    );
    expect(installCommands.every((cmd) => !cmd.includes('@incremental-implementation'))).toBe(true);
  });
});
