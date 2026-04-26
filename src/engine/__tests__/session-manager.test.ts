import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Role } from '../role-manager.js';
import type * as SessionStore from '../session-store.js';

const createRoleSession = vi.fn();
const writeMemory = vi.fn();

vi.mock('../session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionStore>();
  return {
    ...actual,
    createRoleSession,
  };
});

vi.mock('../memory-writer.js', () => ({
  writeMemory,
}));

let tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('SessionManager', () => {
  it('persists DEV task session mappings after rotation', async () => {
    createRoleSession.mockResolvedValue('new-dev-session');
    writeMemory.mockResolvedValue(undefined);

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-session-manager-'));
    tempDirs.push(workspace);

    const { SessionManager } = await import('../session-manager.js');
    const manager = new SessionManager({} as never, workspace);

    const newSessionId = await manager.rotateSession(Role.DEV, 'old-dev-session', 42);

    expect(newSessionId).toBe('new-dev-session');
    const persisted = JSON.parse(
      fs.readFileSync(path.join(workspace, '.win-agent', 'sessions.json'), 'utf-8')
    ) as Record<string, string>;
    expect(persisted['task:42-DEV']).toBe('new-dev-session');
  });
});
