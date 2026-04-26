import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Role } from '../role-manager.js';
import { SessionWatchdog } from '../session-watchdog.js';
import type { RoleRuntimeState } from '../session-reconciler.js';

let baseTime: number;
let mockNow: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  baseTime = Date.now();
  mockNow = vi.spyOn(Date, 'now').mockReturnValue(baseTime);
});

afterEach(() => {
  mockNow.mockRestore();
  vi.useRealTimers();
});

function state(role: Role, serverBusy: boolean, sessionId = `${role}-session`): RoleRuntimeState {
  return {
    role,
    sessionId,
    serverStatus: serverBusy ? { type: 'busy' } : { type: 'idle' },
    serverBusy,
    localBusy: serverBusy,
    drift: 'none',
  };
}

function states(sessionId = 'dev-session'): Map<Role, RoleRuntimeState> {
  return new Map([
    [Role.PM, state(Role.PM, false, 'pm-session')],
    [Role.DEV, state(Role.DEV, true, sessionId)],
  ]);
}

function clientWithMessages(data: unknown[]) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data }),
    },
  };
}

describe('SessionWatchdog', () => {
  it('does not mark a session stuck when no completed/end timestamp exists', async () => {
    const watchdog = new SessionWatchdog();
    const client = clientWithMessages([{ info: {}, parts: [] }]);

    const stuck = await watchdog.detectStuckSessions(states(), client as never);

    expect(stuck).toEqual([]);
  });

  it('marks a busy session stuck when last update is older than threshold', async () => {
    const watchdog = new SessionWatchdog();
    const client = clientWithMessages([
      {
        info: { time: { completed: baseTime - 6 * 60 * 1000 } },
        parts: [],
      },
    ]);

    const stuck = await watchdog.detectStuckSessions(states(), client as never);

    expect(stuck).toEqual([{ role: Role.DEV, sessionId: 'dev-session' }]);
  });

  it('uses part end timestamps when they are the newest update', async () => {
    const watchdog = new SessionWatchdog();
    const client = clientWithMessages([
      {
        info: { time: { completed: baseTime - 10 * 60 * 1000 } },
        parts: [{ time: { end: baseTime - 30 * 1000 } }],
      },
    ]);

    const stuck = await watchdog.detectStuckSessions(states(), client as never);

    expect(stuck).toEqual([]);
  });

  it('throttles checks per session', async () => {
    const watchdog = new SessionWatchdog();
    const client = clientWithMessages([
      {
        info: { time: { completed: baseTime - 6 * 60 * 1000 } },
        parts: [],
      },
    ]);

    await watchdog.detectStuckSessions(states(), client as never);
    const second = await watchdog.detectStuckSessions(states(), client as never);

    expect(second).toEqual([]);
    expect(client.session.messages).toHaveBeenCalledTimes(1);
  });

  it('returns no stuck session when messages request times out', async () => {
    vi.useFakeTimers();
    const timeoutNow = 1_000_000;
    vi.setSystemTime(timeoutNow);
    mockNow.mockRestore();
    mockNow = vi.spyOn(Date, 'now').mockReturnValue(timeoutNow);

    const watchdog = new SessionWatchdog();
    const client = {
      session: {
        messages: vi.fn().mockReturnValue(new Promise(() => undefined)),
      },
    };

    const pending = watchdog.detectStuckSessions(states(), client as never);
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(pending).resolves.toEqual([]);
  });
});
