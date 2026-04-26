import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_CONTINUE_PROMPT,
  getLatestSessionUpdateTime,
  nudgeDevSessionIfStalled,
  resetDevSessionNudgeState,
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

  it('sends only a minimal continue prompt when a DEV session is stalled', async () => {
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
});
