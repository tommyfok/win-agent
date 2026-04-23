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
        const currentTaskId = role === Role.DEV ? getCurrentDispatchContext()?.taskId ?? undefined : undefined;
        states.set(role, {
          role,
          sessionId: sessionManager.getRoleSessionId(role, currentTaskId),
          serverStatus: 'unknown',
          serverBusy: localBusy,
          localBusy,
          drift: 'none',
        });
      }
      return { states, healthy: false };
    }

    for (const role of AGENT_ROLES) {
      const currentTaskId = role === Role.DEV ? getCurrentDispatchContext()?.taskId ?? undefined : undefined;
      const sessionId = sessionManager.getRoleSessionId(role, currentTaskId);
      const localBusy = roleManager.isBusy(role);

      let serverStatus: SessionStatus | 'no-session' | 'unknown';
      if (!sessionId) {
        serverStatus = 'no-session';
      } else if (sessionId in statusMap) {
        serverStatus = statusMap[sessionId];
      } else {
        serverStatus = 'no-session';
      }

      const serverBusy = isServerBusy(serverStatus);

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
