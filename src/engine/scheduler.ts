import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SessionManager } from './session-manager.js';
import { RoleManager } from './role-manager.js';
import { AbortError } from './retry.js';
import { insert } from '../db/repository.js';
import {
  initDispatchState,
  promoteDeferredPmMessages,
  tryDispatchNormalRole,
} from './scheduler-dispatch.js';
import { SessionStateReconciler } from './session-reconciler.js';
import { SchedulerMaintenance } from './scheduler-maintenance.js';
import { findRolesReadyForDispatch } from './message-scheduler.js';
import { Role } from './role-manager.js';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Re-export for external callers (e.g. engine commands)
export type { DispatchContext } from './scheduler-dispatch.js';
export { getCurrentDispatchContext, abortCurrentDispatch } from './scheduler-dispatch.js';
export { getPmLastDispatchEnd } from './scheduler-dispatch.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let running = false;

let healthFailCount = 0;
const MAX_HEALTH_FAILURES = 30;

export async function startSchedulerLoop(
  client: OpencodeClient,
  sessionManager: SessionManager
): Promise<void> {
  running = true;
  initDispatchState(client);
  const roleManager = new RoleManager();
  const reconciler = new SessionStateReconciler();
  const maintenance = new SchedulerMaintenance(sessionManager.getWorkspace());

  logger.info('scheduler loop started');

  while (running) {
    try {
      await schedulerTick(client, sessionManager, roleManager, reconciler, maintenance);
    } catch (err) {
      if (err instanceof AbortError) {
        logger.info({ message: err.message }, 'dispatch aborted');
        break;
      }
      logger.error({ err }, 'scheduler error');
      try {
        insert('logs', {
          role: Role.SYS,
          action: 'scheduler_error',
          content: `调度器异常: ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch {
        // DB write failed too — nothing more we can do
      }
    }

    if (!running) break;
    await sleep(loadConfig().engine?.tickIntervalMs ?? 1000);
  }

  logger.info('scheduler loop stopped');
}

export function stopSchedulerLoop(): void {
  running = false;
}

async function schedulerTick(
  client: OpencodeClient,
  sessionManager: SessionManager,
  roleManager: RoleManager,
  reconciler: SessionStateReconciler,
  maintenance: SchedulerMaintenance
): Promise<void> {
  const { states, healthy } = await reconciler.reconcile(client, sessionManager, roleManager);

  if (!healthy) {
    healthFailCount++;
    logger.error({ healthFailCount }, 'opencode server health check failed (via reconcile)');
    return;
  } else {
    if (healthFailCount >= MAX_HEALTH_FAILURES) {
      logger.info('opencode server recovered, resuming dispatch');
    }
    healthFailCount = 0;
  }

  promoteDeferredPmMessages(roleManager, states.get(Role.PM));

  const { recoveredStuckSession } = await maintenance.maybeRun(client, states);
  if (recoveredStuckSession) {
    return;
  }

  const rolesReadyForDispatch = findRolesReadyForDispatch(states);
  await tryDispatchNormalRole(
    client,
    sessionManager,
    roleManager,
    () => maintenance.resetPmReminder(),
    states,
    rolesReadyForDispatch
  );
}
