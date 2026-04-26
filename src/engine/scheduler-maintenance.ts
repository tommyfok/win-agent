import type { OpencodeClient } from '@opencode-ai/sdk';
import type { RoleRuntimeState } from './session-reconciler.js';
import { Role } from './role-manager.js';
import { checkAndUnblockDependencies } from './dependency-checker.js';
import { IdleNudger } from './idle-nudger.js';
import { SessionWatchdog } from './session-watchdog.js';
import { insert } from '../db/repository.js';
import { logger } from '../utils/logger.js';
import { nudgeDevSessionIfStalled } from './dev-session-nudger.js';

const MAINTENANCE_INTERVAL_MS = 30_000;

/**
 * Low-frequency maintenance. Dependency unblocking intentionally runs here
 * instead of every dispatch tick; newly unblocked work may wait up to 30s.
 */
export class SchedulerMaintenance {
  private lastRunAt = 0;
  private idleNudger = new IdleNudger();
  private sessionWatchdog = new SessionWatchdog();

  constructor(private workspace: string = process.cwd()) {}

  async maybeRun(
    client: OpencodeClient,
    states: ReadonlyMap<Role, RoleRuntimeState>
  ): Promise<{ recoveredStuckSession: boolean }> {
    const now = Date.now();
    if (now - this.lastRunAt < MAINTENANCE_INTERVAL_MS) {
      return { recoveredStuckSession: false };
    }
    this.lastRunAt = now;

    checkAndUnblockDependencies();
    this.idleNudger.detect(states);

    const stuckSessions = await this.sessionWatchdog.detectStuckSessions(states, client);
    const recoveredStuckSession = await this.recoverStuckSessions(stuckSessions, client);
    return { recoveredStuckSession };
  }

  resetPmReminder(): void {
    this.idleNudger.resetReminder();
  }

  private async recoverStuckSessions(
    stuckSessions: Array<{ role: Role; sessionId: string }>,
    client: OpencodeClient
  ): Promise<boolean> {
    let recovered = false;
    for (const stuckSession of stuckSessions) {
      try {
        if (stuckSession.role === Role.DEV) {
          const nudged = await nudgeDevSessionIfStalled(
            client,
            this.workspace,
            stuckSession.sessionId
          );
          if (nudged) {
            insert('logs', {
              role: Role.SYS,
              action: 'stuck_dev_session_nudged',
              content: `DEV session ${stuckSession.sessionId} was stalled and received a continue nudge`,
            });
            recovered = true;
          }
          continue;
        }

        logger.info(
          { role: stuckSession.role, sessionId: stuckSession.sessionId },
          'maintenance: aborting stuck session'
        );
        await client.session.abort({ path: { id: stuckSession.sessionId } });
        insert('logs', {
          role: Role.SYS,
          action: 'stuck_session_aborted',
          content: `${stuckSession.role} session ${stuckSession.sessionId} was stuck and has been aborted`,
        });
        recovered = true;
      } catch (err) {
        logger.warn(
          { err, sessionId: stuckSession.sessionId },
          'maintenance: stuck recovery failed'
        );
      }
    }
    return recovered;
  }
}
