import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SessionManager } from './session-manager.js';
import type { DispatchIntent } from './stall-detector.js';
import { RoleManager } from './role-manager.js';
import { AbortError } from './retry.js';
import { insert } from '../db/repository.js';
import { checkAndUnblockDependencies } from './dependency-checker.js';
import {
  initDispatchState,
  promoteDeferredPmMessages,
  tryDispatchNormalRole,
} from './scheduler-dispatch.js';
import { SessionStateReconciler } from './session-reconciler.js';
import { StallDetector } from './stall-detector.js';
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
  const stallDetector = new StallDetector();

  logger.info('scheduler loop started');

  while (running) {
    try {
      await schedulerTick(client, sessionManager, roleManager, reconciler, stallDetector);
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

async function handleStuckSessions(
  intents: DispatchIntent[],
  client: OpencodeClient
): Promise<boolean> {
  let aborted = false;
  for (const intent of intents) {
    if (intent.reason !== 'stuck_session') continue;
    const sessionId = (intent.details as { sessionId: string })?.sessionId;
    if (!sessionId) continue;

    try {
      logger.info({ role: intent.role, sessionId }, 'handleStuckSessions: aborting stuck session');
      await client.session.abort({ path: { id: sessionId } });
      insert('logs', {
        role: Role.SYS,
        action: 'stuck_session_aborted',
        content: `${intent.role} session ${sessionId} was stuck and has been aborted`,
      });
      aborted = true;
    } catch (err) {
      logger.warn({ err, sessionId }, 'handleStuckSessions: abort failed');
    }
  }
  return aborted;
}

async function schedulerTick(
  client: OpencodeClient,
  sessionManager: SessionManager,
  roleManager: RoleManager,
  reconciler: SessionStateReconciler,
  stallDetector: StallDetector
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

  checkAndUnblockDependencies();
  promoteDeferredPmMessages(roleManager, states.get(Role.PM));

  const intents = await stallDetector.detect(states, roleManager, client);

  const abortedStuckSession = await handleStuckSessions(intents, client);
  if (abortedStuckSession) {
    return;
  }

  const dispatchIntents = intents.filter((intent) => intent.reason !== 'stuck_session');
  await tryDispatchNormalRole(
    client,
    sessionManager,
    roleManager,
    () => stallDetector.resetReminder(),
    states,
    dispatchIntents
  );
}
