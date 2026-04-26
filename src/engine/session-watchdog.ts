import type { OpencodeClient } from '@opencode-ai/sdk';
import type { RoleRuntimeState } from './session-reconciler.js';
import { AGENT_ROLES, type Role } from './role-manager.js';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const STUCK_CHECK_INTERVAL_MS = 60 * 1000;
const STUCK_CHECK_TIMEOUT_MS = 5_000;

export interface StuckSession {
  role: Role;
  sessionId: string;
}

export class SessionWatchdog {
  private lastStuckCheckAt = new Map<string, number>();

  async detectStuckSessions(
    states: ReadonlyMap<Role, RoleRuntimeState>,
    client: OpencodeClient
  ): Promise<StuckSession[]> {
    const now = Date.now();
    const stuckSessions: StuckSession[] = [];

    for (const role of AGENT_ROLES) {
      const state = states.get(role);
      if (!state?.serverBusy || !state.sessionId) continue;

      const lastCheck = this.lastStuckCheckAt.get(state.sessionId) ?? 0;
      if (now - lastCheck < STUCK_CHECK_INTERVAL_MS) continue;

      this.lastStuckCheckAt.set(state.sessionId, now);
      const isStuck = await this.checkStuckSession(client, state.sessionId, now);
      if (isStuck) {
        stuckSessions.push({ role, sessionId: state.sessionId });
      }
    }

    return stuckSessions;
  }

  private async checkStuckSession(
    client: OpencodeClient,
    sessionId: string,
    now: number
  ): Promise<boolean> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('stuck check timeout')), STUCK_CHECK_TIMEOUT_MS);
      });
      let msgs: Awaited<ReturnType<typeof client.session.messages>>;
      try {
        msgs = await Promise.race([
          client.session.messages({
            path: { id: sessionId },
            query: { limit: 3 },
          }),
          timeoutPromise,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const messages = msgs.data ?? [];
      let lastUpdate = 0;
      for (const m of messages) {
        const info = m.info as { time?: { completed?: number } } | undefined;
        if (info?.time?.completed && info.time.completed > lastUpdate) {
          lastUpdate = info.time.completed;
        }
        const parts = m.parts as Array<{ time?: { end?: number } }>;
        for (const p of parts) {
          if (p.time?.end && p.time.end > lastUpdate) {
            lastUpdate = p.time.end;
          }
        }
      }
      return lastUpdate > 0 && now - lastUpdate > STUCK_THRESHOLD_MS;
    } catch {
      return false;
    }
  }
}
