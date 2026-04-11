import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SessionManager } from './session-manager.js';
import type { RoleManager } from './role-manager.js';
import { ALL_ROLES } from './role-manager.js';
import { dispatchToRole, dispatchToRoleGrouped, type MessageRow } from './dispatcher.js';
import { AbortError } from './retry.js';
import { checkAndRotate } from './memory-rotator.js';
import { select, insert, update, rawRun, upsertProjectConfig } from '../db/repository.js';
import { MessageStatus } from '../db/types.js';
import { engineBus, EngineEvents } from './event-bus.js';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

/** Context of a currently active dispatch (for interrupt & resume) */
export interface DispatchContext {
  role: string;
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
export let lastDispatchedRole: string | null = null;

export function initDispatchState(client: OpencodeClient): void {
  storedClient = client;
  loadDispatchState();
}

function loadDispatchState(): void {
  try {
    const rows = select<{ key: string; value: string }>('project_config', {});
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (m['engine.lastDispatchedRole'] !== undefined)
      lastDispatchedRole = m['engine.lastDispatchedRole'] || null;
    if (m['engine.pmLastDispatchEnd'] !== undefined)
      pmLastDispatchEnd = parseInt(m['engine.pmLastDispatchEnd'], 10) || 0;
  } catch {
    /* non-fatal */
  }
}

function saveDispatchState(): void {
  try {
    upsertProjectConfig('engine.lastDispatchedRole', lastDispatchedRole ?? '');
    upsertProjectConfig('engine.pmLastDispatchEnd', String(pmLastDispatchEnd));
  } catch {
    /* non-fatal */
  }
}

export function setLastDispatchedRole(role: string): void {
  lastDispatchedRole = role;
}

export function setPmLastDispatchEnd(ts: number): void {
  pmLastDispatchEnd = ts;
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

/**
 * Promote deferred trigger messages when PM is idle and has no pending unread messages.
 * This ensures auto-trigger messages are dispatched in their own batch.
 */
export function promoteDeferredTriggers(roleManager: RoleManager): void {
  if (!roleManager.isBusy('PM')) {
    const pmUnread = select<MessageRow>('messages', {
      to_role: 'PM',
      status: MessageStatus.Unread,
    });
    if (pmUnread.length === 0) {
      rawRun(
        `UPDATE messages SET status = '${MessageStatus.Unread}' WHERE status = '${MessageStatus.Deferred}' AND to_role = 'PM'`
      );
    }
  }
}

/**
 * Try to dispatch user→PM messages (priority path).
 * Returns true if a dispatch happened (caller should skip normal dispatch).
 */
export async function tryDispatchUserMessages(
  client: OpencodeClient,
  sessionManager: SessionManager,
  roleManager: RoleManager
): Promise<boolean> {
  if (roleManager.isBusy('PM')) return false;

  const userMessages = select<MessageRow>(
    'messages',
    { from_role: 'user', to_role: 'PM', status: MessageStatus.Unread },
    { orderBy: 'created_at ASC' }
  );
  if (userMessages.length === 0) return false;

  logger.info({ role: 'PM', messageCount: userMessages.length }, 'dispatch start (user priority)');
  roleManager.setBusy('PM', true);
  const abortController = new AbortController();
  currentAbortController = abortController;
  const taskId = userMessages.find((m) => m.related_task_id)?.related_task_id ?? null;
  currentDispatch = { role: 'PM', taskId, sessionId: null, startedAt: new Date().toISOString() };

  try {
    const { sessionId, inputTokens, outputTokens } = await dispatchToRole(
      client,
      sessionManager,
      'PM',
      userMessages,
      {
        signal: abortController.signal,
        onSessionResolved: (sid) => {
          if (currentDispatch) currentDispatch.sessionId = sid;
        },
      }
    );
    if (sessionId) {
      await checkAndRotate(
        sessionManager,
        'PM',
        sessionId,
        inputTokens,
        outputTokens,
        taskId ?? undefined
      );
      engineBus.emit(EngineEvents.DISPATCH_COMPLETE, { role: 'PM', inputTokens, outputTokens });
    }
    logger.info({ role: 'PM' }, 'dispatch done (user priority)');
  } finally {
    currentDispatch = null;
    currentAbortController = null;
    roleManager.setBusy('PM', false);
    // User-priority messages do NOT trigger PM cooldown
    lastDispatchedRole = null;
    saveDispatchState();
  }

  return true;
}

/**
 * Try to dispatch normal role messages (round-robin across ALL_ROLES).
 * Dispatches at most one role per call (V1 serial strategy).
 */
export async function tryDispatchNormalRole(
  client: OpencodeClient,
  sessionManager: SessionManager,
  roleManager: RoleManager
): Promise<void> {
  const roleOrder =
    lastDispatchedRole && ALL_ROLES.includes(lastDispatchedRole as (typeof ALL_ROLES)[number])
      ? [...ALL_ROLES].sort((a, b) =>
          a === lastDispatchedRole ? 1 : b === lastDispatchedRole ? -1 : 0
        )
      : [...ALL_ROLES];

  for (const role of roleOrder) {
    if (roleManager.isBusy(role)) continue;

    if (role === 'PM' && Date.now() - pmLastDispatchEnd < getPmCooldownMs()) {
      continue;
    }

    const messages = select<MessageRow>(
      'messages',
      { to_role: role, status: MessageStatus.Unread },
      { orderBy: 'created_at ASC' }
    );
    if (messages.length === 0) continue;

    logger.info({ role, messageCount: messages.length }, 'dispatch start');
    roleManager.setBusy(role, true);
    const abortController = new AbortController();
    currentAbortController = abortController;
    const dispatchTaskId = messages.find((m) => m.related_task_id)?.related_task_id ?? null;
    currentDispatch = {
      role,
      taskId: dispatchTaskId,
      sessionId: null,
      startedAt: new Date().toISOString(),
    };

    try {
      const dispatch = role === 'DEV' ? dispatchToRoleGrouped : dispatchToRole;
      const { sessionId, inputTokens, outputTokens } = await dispatch(
        client,
        sessionManager,
        role,
        messages,
        {
          signal: abortController.signal,
          onSessionResolved: (sid) => {
            if (currentDispatch) currentDispatch.sessionId = sid;
          },
        }
      );
      if (role === 'PM' && sessionId) {
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
    } catch (err) {
      if (err instanceof AbortError) throw err;
      logger.error(
        { role, messageCount: messages.length, err },
        'dispatch failed — messages marked read to prevent replay'
      );
      for (const msg of messages) {
        update('messages', { id: msg.id }, { status: MessageStatus.Read });
      }
      insert('logs', {
        role: 'system',
        action: 'dispatch_failed',
        content: `${role} dispatch failed, ${messages.length} messages marked read: ${String(err).slice(0, 200)}`,
        related_task_id: dispatchTaskId,
      });
    } finally {
      currentDispatch = null;
      currentAbortController = null;
      roleManager.setBusy(role, false);
      lastDispatchedRole = role;
      if (role === 'PM') {
        pmLastDispatchEnd = Date.now();
      }
      saveDispatchState();
    }

    break; // V1: only one role per tick
  }
}
