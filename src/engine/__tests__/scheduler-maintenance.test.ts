import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { select } from '../../db/repository.js';
import { Role } from '../role-manager.js';
import { DEV_CONTINUE_PROMPT, resetDevSessionNudgeState } from '../dev-session-nudger.js';
import { SchedulerMaintenance } from '../scheduler-maintenance.js';
import type { RoleRuntimeState } from '../session-reconciler.js';

let workspace: string;
let now: number;
let mockNow: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setupTestDb();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-maintenance-'));
  fs.mkdirSync(path.join(workspace, '.win-agent'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.win-agent', 'config.json'),
    JSON.stringify({
      engine: {
        devSessionStalledThresholdMs: 300_000,
        devSessionNudgeCooldownMs: 300_000,
      },
    }),
    'utf-8'
  );
  now = Date.now();
  mockNow = vi.spyOn(Date, 'now').mockReturnValue(now);
  resetDevSessionNudgeState();
});

afterEach(() => {
  mockNow.mockRestore();
  fs.rmSync(workspace, { recursive: true, force: true });
  resetDevSessionNudgeState();
});

function state(role: Role, serverBusy: boolean, sessionId: string): RoleRuntimeState {
  return {
    role,
    sessionId,
    serverStatus: serverBusy ? { type: 'busy' } : { type: 'idle' },
    serverBusy,
    localBusy: serverBusy,
    drift: 'none',
  };
}

describe('SchedulerMaintenance', () => {
  it('nudges a stalled DEV session with only continue instead of aborting it', async () => {
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { time: { created: now - 6 * 60 * 1000 } }, parts: [] }],
        }),
        promptAsync: vi.fn().mockResolvedValue({ data: {} }),
        abort: vi.fn(),
      },
    };
    const states = new Map([
      [Role.PM, state(Role.PM, false, 'pm-session')],
      [Role.DEV, state(Role.DEV, true, 'dev-session')],
    ]);

    const maintenance = new SchedulerMaintenance(workspace);
    await expect(maintenance.maybeRun(client as never, states)).resolves.toEqual({
      recoveredStuckSession: true,
    });

    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: 'dev-session' },
        body: {
          parts: [{ type: 'text', text: DEV_CONTINUE_PROMPT }],
        },
      })
    );
    expect(select('logs', { action: 'stuck_dev_session_nudged' })).toHaveLength(1);
  });
});
