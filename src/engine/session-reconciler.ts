import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SessionStatus } from '@opencode-ai/sdk';
import type { SessionManager } from './session-manager.js';
import type { RoleManager } from './role-manager.js';
import { AGENT_ROLES, Role } from './role-manager.js';
import { getCurrentDispatchContext } from './scheduler-dispatch.js';
import { logger } from '../utils/logger.js';

const RECONCILE_TIMEOUT_MS = 3_000;

export interface RoleRuntimeState {
  role: Role;
  sessionId: string | null;
  serverStatus: SessionStatus | 'no-session' | 'unknown';
  serverBusy: boolean;
  localBusy: boolean;
  drift: 'none' | 'stale-busy' | 'phantom-busy';
}

function isServerBusy(status: SessionStatus | 'no-session' | 'unknown'): boolean {
  if (status === 'no-session' || status === 'unknown') return false;
  return status.type === 'busy' || status.type === 'retry';
}

export interface ReconcileResult {
  states: Map<Role, RoleRuntimeState>;
  healthy: boolean;
}

export class SessionStateReconciler {
  private lastStatusMap: Record<string, SessionStatus> | null = null;

  async reconcile(
    client: OpencodeClient,
    sessionManager: SessionManager,
    roleManager: RoleManager
  ): Promise<ReconcileResult> {
    const states = new Map<Role, RoleRuntimeState>();

    let statusMap: Record<string, SessionStatus>;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('reconcile timeout')), RECONCILE_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([
          client.session.status(),
          timeoutPromise,
        ]);
        statusMap = result.data ?? {};
        this.lastStatusMap = statusMap;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (err) {
      logger.warn({ err }, 'reconcile: session.status() failed, degrading to local state');
      for (const role of AGENT_ROLES) {
        const localBusy = roleManager.isBusy(role);
        const currentTaskId =
          role === Role.DEV ? getCurrentDispatchContext()?.taskId ?? undefined : undefined;
        const sessionId =
          sessionManager.getRoleSessionId(role, currentTaskId) ??
          sessionManager.getAllRoleSessionIds(role)[0] ??
          null;
        states.set(role, {
          role,
          sessionId,
          serverStatus: 'unknown',
          serverBusy: localBusy,
          localBusy,
          drift: 'none',
        });
      }
      return { states, healthy: false };
    }

    for (const role of AGENT_ROLES) {
      const localBusy = roleManager.isBusy(role);

      // Enumerate every known session for this role so a DEV task session that
      // is busy on the server is still surfaced when no dispatch is in-flight
      // in this process. Falls back to the current-dispatch session for PM and
      // for the "no sessions registered" case.
      const allSessionIds = sessionManager.getAllRoleSessionIds(role);
      const currentTaskId =
        role === Role.DEV ? getCurrentDispatchContext()?.taskId ?? undefined : undefined;
      const fallbackSessionId = sessionManager.getRoleSessionId(role, currentTaskId);

      let sessionId: string | null = null;
      let serverStatus: SessionStatus | 'no-session' | 'unknown' = 'no-session';
      let serverBusy = false;

      if (allSessionIds.length === 0) {
        sessionId = fallbackSessionId;
        if (!sessionId) {
          serverStatus = 'no-session';
        } else if (sessionId in statusMap) {
          serverStatus = statusMap[sessionId];
          serverBusy = isServerBusy(serverStatus);
        } else {
          serverStatus = 'no-session';
        }
      } else {
        // Prefer a busy/retry session as the representative; fall back to the
        // first idle one so UI/logs still show something sensible.
        let busyId: string | null = null;
        let busyStatus: SessionStatus | null = null;
        let idleId: string | null = null;
        let idleStatus: SessionStatus | 'no-session' | 'unknown' = 'no-session';
        for (const sid of allSessionIds) {
          const status = sid in statusMap ? statusMap[sid] : null;
          if (status && isServerBusy(status)) {
            busyId = sid;
            busyStatus = status;
            break;
          }
          if (status && !idleId) {
            idleId = sid;
            idleStatus = status;
          }
        }
        if (busyId && busyStatus) {
          sessionId = busyId;
          serverStatus = busyStatus;
          serverBusy = true;
        } else if (idleId) {
          sessionId = idleId;
          serverStatus = idleStatus;
        } else {
          sessionId = allSessionIds[0];
          serverStatus = 'no-session';
        }
      }

      let drift: RoleRuntimeState['drift'] = 'none';
      if (localBusy && !serverBusy) {
        drift = 'stale-busy';
        roleManager.setBusy(role, false);
        logger.info({ role, sessionId }, 'reconcile: stale-busy — clearing local busy flag');
      } else if (!localBusy && serverBusy) {
        drift = 'phantom-busy';
        roleManager.setBusy(role, true);
        logger.info({ role, sessionId, serverStatus }, 'reconcile: phantom-busy — setting local busy flag');
      }

      states.set(role, {
        role,
        sessionId,
        serverStatus,
        serverBusy,
        localBusy: drift === 'stale-busy' ? false : drift === 'phantom-busy' ? true : localBusy,
        drift,
      });
    }

    return { states, healthy: true };
  }

  getLastStatusMap(): Record<string, SessionStatus> | null {
    return this.lastStatusMap;
  }
}
