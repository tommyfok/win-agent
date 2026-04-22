import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SessionManager } from './session-manager.js';
import type { RoleManager } from './role-manager.js';
import type { PmIdleMonitor } from './pm-idle-monitor.js';
import { AGENT_ROLES, Role } from './role-manager.js';
import { dispatchToRole, type MessageRow } from './dispatcher.js';
import { AbortError } from './retry.js';
import { checkAndRotate } from './memory-rotator.js';
import { select, insert, update, rawRun, rawQuery, upsertProjectConfig } from '../db/repository.js';
import { MessageStatus } from '../db/types.js';
import { engineBus, EngineEvents } from './event-bus.js';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

/** Context of a currently active dispatch (for interrupt & resume) */
export interface DispatchContext {
  role: Role;
  taskId: number | null;
  sessionId: string | null;
  startedAt: string;
}

// ── Shared mutable state ──

let currentDispatch: DispatchContext | null = null;
let currentAbortController: AbortController | null = null;
/** Stored opencode client ref for session.abort */
let storedClient: OpencodeClient | null = null;

/** Read PM cooldown from config, falling back to 3000ms. */
function getPmCooldownMs(): number {
  try {
    return loadConfig().engine?.pmCooldownMs ?? 3000;
  } catch {
    return 3000;
  }
}
export let pmLastDispatchEnd = 0;
export let devLastDispatchEnd = 0;
export let lastDispatchedRole: Role | null = null;

export function initDispatchState(client: OpencodeClient): void {
  storedClient = client;
  loadDispatchState();
}

function loadDispatchState(): void {
  try {
    const rows = select<{ key: string; value: string }>('project_config', {});
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (m['engine.lastDispatchedRole'] !== undefined) {
      const savedRole = m['engine.lastDispatchedRole'];
      lastDispatchedRole = savedRole ? (savedRole as Role) : null;
    }
    if (m['engine.pmLastDispatchEnd'] !== undefined)
      pmLastDispatchEnd = parseInt(m['engine.pmLastDispatchEnd'], 10) || 0;
    if (m['engine.devLastDispatchEnd'] !== undefined)
      devLastDispatchEnd = parseInt(m['engine.devLastDispatchEnd'], 10) || 0;
  } catch {
    /* non-fatal */
  }
}

function saveDispatchState(): void {
  try {
    upsertProjectConfig('engine.lastDispatchedRole', lastDispatchedRole ?? '');
    upsertProjectConfig('engine.pmLastDispatchEnd', String(pmLastDispatchEnd));
    upsertProjectConfig('engine.devLastDispatchEnd', String(devLastDispatchEnd));
  } catch {
    /* non-fatal */
  }
}

export function setLastDispatchedRole(role: Role): void {
  lastDispatchedRole = role;
}

export function setPmLastDispatchEnd(ts: number): void {
  pmLastDispatchEnd = ts;
}

/**
 * Get PM's last dispatch end timestamp.
 * Used by PmIdleMonitor to calculate PM idle duration for reminder logic.
 */
export function getPmLastDispatchEnd(): number {
  return pmLastDispatchEnd;
}

/**
 * Get DEV's last dispatch end timestamp.
 * Used by PmIdleMonitor to check DEV activity before sending PM reminder.
 */
export function getDevLastDispatchEnd(): number {
  return devLastDispatchEnd;
}

/**
 * Get the context of the currently in-flight dispatch, if any.
 */
export function getCurrentDispatchContext(): DispatchContext | null {
  return currentDispatch;
}

/**
 * Abort the currently in-flight dispatch and return its context.
 * Also calls session.abort on the opencode server to stop LLM processing.
 * Returns the dispatch context (for persisting interrupted state), or null if idle.
 */
export async function abortCurrentDispatch(): Promise<DispatchContext | null> {
  const ctx = currentDispatch;
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  // Tell opencode server to stop the in-flight LLM call
  if (ctx?.sessionId && storedClient) {
    try {
      await storedClient.session.abort({ path: { id: ctx.sessionId } });
    } catch {
      // Session may already be idle — non-fatal
    }
  }
  return ctx;
}

export function promoteDeferredPmMessages(roleManager: RoleManager): void {
  if (!roleManager.isBusy(Role.PM)) {
    const pmUnread = select<MessageRow>('messages', {
      to_role: Role.PM,
      status: MessageStatus.Unread,
    });
    if (pmUnread.length === 0) {
      rawRun(
        `UPDATE messages SET status = ? WHERE status = ? AND to_role = ?`,
        [MessageStatus.Unread, MessageStatus.Deferred, Role.PM]
      );
    }
  }
}

const MAX_DISPATCH_RETRIES = 3;
const DISPATCH_BACKOFF_MS = 30_000;

/**
 * Try to dispatch normal role messages (round-robin across AGENT_ROLES).
 * Dispatches at most one role per call (V1 serial strategy).
 * Each tick dispatches only one task group per role (Option B).
 */
export async function tryDispatchNormalRole(
  client: OpencodeClient,
  sessionManager: SessionManager,
  roleManager: RoleManager,
  pmIdleMonitor?: PmIdleMonitor
): Promise<void> {
  const roleOrder =
    lastDispatchedRole && AGENT_ROLES.includes(lastDispatchedRole)
      ? [...AGENT_ROLES].sort((a, b) =>
          a === lastDispatchedRole ? 1 : b === lastDispatchedRole ? -1 : 0
        )
      : [...AGENT_ROLES];

  for (const role of roleOrder) {
    if (roleManager.isBusy(role)) continue;

    if (role === Role.PM && Date.now() - pmLastDispatchEnd < getPmCooldownMs()) {
      continue;
    }

    const cutoff = Date.now() - DISPATCH_BACKOFF_MS;
    const messages = rawQuery<MessageRow>(
      `SELECT * FROM messages
       WHERE to_role = ? AND status = ?
         AND (last_retry_at IS NULL OR last_retry_at < ?)
       ORDER BY created_at ASC`,
      [role, MessageStatus.Unread, cutoff]
    );
    if (messages.length === 0) continue;

    const groupTaskId = messages[0].related_task_id;
    const batch = messages.filter((m) => m.related_task_id === groupTaskId);

    logger.info(
      { role, groupTaskId, batchSize: batch.length, totalUnread: messages.length },
      'dispatch start'
    );

    roleManager.setBusy(role, true);
    const abortController = new AbortController();
    currentAbortController = abortController;
    const dispatchTaskId = groupTaskId;
    currentDispatch = {
      role,
      taskId: dispatchTaskId,
      sessionId: null,
      startedAt: new Date().toISOString(),
    };

    let completedNormally = false;
    let dispatchSucceeded = false;

    try {
      const { sessionId, inputTokens, outputTokens } = await dispatchToRole(
        client,
        sessionManager,
        role,
        batch,
        {
          signal: abortController.signal,
          onSessionResolved: (sid) => {
            if (currentDispatch) currentDispatch.sessionId = sid;
          },
        }
      );
      if (role === Role.PM && sessionId) {
        await checkAndRotate(
          sessionManager,
          role,
          sessionId,
          inputTokens,
          outputTokens,
          dispatchTaskId ?? undefined
        );
      }
      if (sessionId) {
        engineBus.emit(EngineEvents.DISPATCH_COMPLETE, { role, inputTokens, outputTokens });
      }
      logger.info({ role }, 'dispatch done');
      completedNormally = true;
      dispatchSucceeded = true;
    } catch (err) {
      if (err instanceof AbortError) {
        throw err;
      }
      completedNormally = true;

      const now = Date.now();
      for (const msg of batch) {
        const next = (msg.retry_count ?? 0) + 1;
        if (next >= MAX_DISPATCH_RETRIES) {
          update('messages', { id: msg.id }, {
            status: MessageStatus.Read,
            retry_count: next,
            last_retry_at: now,
          });
        } else {
          update('messages', { id: msg.id }, {
            retry_count: next,
            last_retry_at: now,
          });
        }
      }

      insert('logs', {
        role: Role.SYS,
        action: 'dispatch_failed',
        content: `${role} dispatch failed (group=${dispatchTaskId ?? 'none'}), batch=${batch.length}: ${String(err).slice(0, 200)}`,
        related_task_id: dispatchTaskId,
      });
    } finally {
      currentDispatch = null;
      currentAbortController = null;
      roleManager.setBusy(role, false);
      if (completedNormally) {
        lastDispatchedRole = role;
        if (role === Role.PM) {
          pmLastDispatchEnd = Date.now();
        } else if (role === Role.DEV) {
          devLastDispatchEnd = Date.now();
        }
        saveDispatchState();
      }
      if (dispatchSucceeded && role === Role.PM && pmIdleMonitor) {
        pmIdleMonitor.resetReminder();
      }
    }

    break; // V1: at most one dispatch per tick
  }
}
