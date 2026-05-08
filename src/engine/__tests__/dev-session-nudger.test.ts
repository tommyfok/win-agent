import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_CONTINUE_PROMPT,
  getLatestSessionUpdateTime,
  nudgeDevSessionIfStalled,
  resetDevSessionNudgeState,
  startDevSessionStallMonitor,
} from '../dev-session-nudger.js';

let workspace: string;
let now: number;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-dev-nudger-'));
  fs.mkdirSync(path.join(workspace, '.win-agent'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.win-agent', 'config.json'),
    JSON.stringify({
      engine: {
        devSessionStalledThresholdMs: 300_000,
        devSessionNudgeCooldownMs: 300_000,
        devSessionStallCheckIntervalMs: 1_000,
      },
    }),
    'utf-8'
  );
  now = Date.now();
  resetDevSessionNudgeState();
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  resetDevSessionNudgeState();
  vi.useRealTimers();
});

function clientWithMessages(data: unknown[]) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data }),
      promptAsync: vi.fn().mockResolvedValue({ data: {} }),
    },
  };
}

type MockClient = ReturnType<typeof clientWithMessages> & {
  session: ReturnType<typeof clientWithMessages>['session'] & {
    status?: ReturnType<typeof vi.fn>;
  };
};

describe('dev session nudger', () => {
  it('uses message and part timestamps to find the latest update', async () => {
    const client = clientWithMessages([
      {
        info: { time: { created: now - 10_000 } },
        parts: [{ time: { end: now - 1_000 } }],
      },
    ]);

    await expect(getLatestSessionUpdateTime(client as never, 'dev-session')).resolves.toBe(
      now - 1_000
    );
  });

  it('sends a safe continue prompt when a DEV session is stalled', async () => {
    const client = clientWithMessages([
      {
        info: { time: { created: now - 6 * 60 * 1000 } },
        parts: [],
      },
    ]);

    await expect(
      nudgeDevSessionIfStalled(client as never, workspace, 'dev-session', now)
    ).resolves.toBe(true);

    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: 'dev-session' },
        body: {
          parts: [{ type: 'text', text: DEV_CONTINUE_PROMPT }],
        },
      })
    );
  });

  it('does not nudge when session.status reports the DEV session is busy', async () => {
    const client: MockClient = clientWithMessages([
      {
        info: { time: { created: now - 6 * 60 * 1000 } },
        parts: [],
      },
    ]);
    client.session.status = vi.fn().mockResolvedValue({
      data: { 'dev-session': { type: 'busy' } },
    });

    await expect(
      nudgeDevSessionIfStalled(client as never, workspace, 'dev-session', now)
    ).resolves.toBe(false);

    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it('does not nudge when recent messages show unfinished assistant work', async () => {
    const client = clientWithMessages([
      {
        info: { role: 'assistant', time: { created: now - 6 * 60 * 1000 } },
        parts: [],
      },
    ]);

    await expect(
      nudgeDevSessionIfStalled(client as never, workspace, 'dev-session', now)
    ).resolves.toBe(false);

    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it('does not send duplicate continue nudges within the cooldown', async () => {
    const client = clientWithMessages([
      {
        info: { time: { created: now - 6 * 60 * 1000 } },
        parts: [],
      },
    ]);

    await nudgeDevSessionIfStalled(client as never, workspace, 'dev-session', now);
    await nudgeDevSessionIfStalled(client as never, workspace, 'dev-session', now + 60_000);

    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('sends at most one nudge during a single DEV dispatch monitor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const client = clientWithMessages([
      {
        info: { time: { created: now - 6 * 60 * 1000, completed: now - 6 * 60 * 1000 } },
        parts: [],
      },
    ]);

    const stop = startDevSessionStallMonitor(client as never, workspace, 'dev-session');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    stop();

    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
  });
});
