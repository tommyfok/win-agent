import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SessionManager } from './session-manager.js';
import { RoleManager } from './role-manager.js';
import { AbortError } from './retry.js';
import { insert } from '../db/repository.js';
import { checkAndUnblockDependencies } from './dependency-checker.js';
import { checkHealth } from './opencode-server.js';
import {
  initDispatchState,
  promoteDeferredTriggers,
  tryDispatchNormalRole,
} from './scheduler-dispatch.js';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Re-export for external callers (e.g. engine commands)
export type { DispatchContext } from './scheduler-dispatch.js';
export { getCurrentDispatchContext, abortCurrentDispatch } from './scheduler-dispatch.js';

/** Sleep helper */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Engine running flag — set to false to stop the main loop */
let running = false;

// ── Health check state ──
let healthFailCount = 0;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_HEALTH_FAILURES = 3;
let lastHealthCheckAt = 0;

/**
 * Start the scheduler main loop.
 *
 * V1 serial strategy:
 * - Each cycle iterates through ALL_ROLES (round-robin with PM cooldown)
 * - Only one role is dispatched per cycle
 * - After dispatch, check auto-triggers and iteration review
 * - Sleep 1s between cycles to avoid tight polling
 */
export async function startSchedulerLoop(
  client: OpencodeClient,
  sessionManager: SessionManager
): Promise<void> {
  running = true;
  initDispatchState(client);
  const roleManager = new RoleManager();

  logger.info('scheduler loop started');

  while (running) {
    try {
      await schedulerTick(client, sessionManager, roleManager);
    } catch (err) {
      if (err instanceof AbortError) {
        logger.info({ message: err.message }, 'dispatch aborted');
        break;
      }
      logger.error({ err }, 'scheduler error');
      try {
        insert('logs', {
          role: 'system',
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

/**
 * Stop the scheduler loop gracefully.
 */
export function stopSchedulerLoop(): void {
  running = false;
}

/**
 * Single tick of the scheduler.
 *
 * 1. Periodic opencode health check (may return early if unhealthy)
 * 2. Auto-unblock tasks whose dependencies are satisfied
 * 3. Promote deferred PM messages when PM is idle and has no unread inbox
 * 4. Round-robin dispatch (at most one role per tick)
 *
 * Auto-triggers fire on DISPATCH_COMPLETE; iteration review uses its own checker.
 */
async function schedulerTick(
  client: OpencodeClient,
  sessionManager: SessionManager,
  roleManager: RoleManager
): Promise<void> {
  // Periodic health check (every 30s); suspend dispatch after 3 consecutive failures
  if (Date.now() - lastHealthCheckAt > HEALTH_CHECK_INTERVAL_MS) {
    lastHealthCheckAt = Date.now();
    const healthy = await checkHealth(client);
    if (!healthy) {
      healthFailCount++;
      logger.error({ healthFailCount }, 'opencode server health check failed');
      if (healthFailCount >= MAX_HEALTH_FAILURES) {
        logger.error('opencode server unreachable, suspending dispatch');
        return;
      }
    } else {
      if (healthFailCount >= MAX_HEALTH_FAILURES) {
        logger.info('opencode server recovered, resuming dispatch');
      }
      healthFailCount = 0;
    }
  }

  checkAndUnblockDependencies();
  promoteDeferredTriggers(roleManager);

  await tryDispatchNormalRole(client, sessionManager, roleManager);
}
