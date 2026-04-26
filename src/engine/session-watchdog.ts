import type { OpencodeClient } from '@opencode-ai/sdk';
import type { RoleRuntimeState } from './session-reconciler.js';
import { AGENT_ROLES, type Role } from './role-manager.js';
import { getLatestSessionUpdateTime } from './dev-session-nudger.js';

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
      try {
        const lastUpdate = await Promise.race([
          getLatestSessionUpdateTime(client, sessionId),
          timeoutPromise,
        ]);
        return lastUpdate !== null && now - lastUpdate > STUCK_THRESHOLD_MS;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }
}
