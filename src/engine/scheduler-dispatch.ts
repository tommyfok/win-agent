import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SessionManager } from './session-manager.js';
import type { RoleManager } from './role-manager.js';
import type { RoleRuntimeState } from './session-reconciler.js';
import type { DispatchIntent } from './stall-detector.js';
import { AGENT_ROLES, Role } from './role-manager.js';
import { dispatchToRole, type MessageRow } from './dispatcher.js';
import { AbortError } from './retry.js';
import { checkAndRotate } from './memory-rotator.js';
import { select, insert, update, rawRun, rawQuery, upsertProjectConfig } from '../db/repository.js';
import { MessageStatus } from '../db/types.js';
import { engineBus, EngineEvents } from './event-bus.js';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

export interface DispatchContext {
  role: Role;
  taskId: number | null;
  sessionId: string | null;
  startedAt: string;
}

let currentDispatch: DispatchContext | null = null;
let currentAbortController: AbortController | null = null;
let storedClient: OpencodeClient | null = null;

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

export function getPmLastDispatchEnd(): number {
  return pmLastDispatchEnd;
}

export function getDevLastDispatchEnd(): number {
  return devLastDispatchEnd;
}

export function getCurrentDispatchContext(): DispatchContext | null {
  return currentDispatch;
}

export async function abortCurrentDispatch(): Promise<DispatchContext | null> {
  const ctx = currentDispatch;
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  if (ctx?.sessionId && storedClient) {
    try {
      await storedClient.session.abort({ path: { id: ctx.sessionId } });
    } catch {
      // Session may already be idle — non-fatal
    }
  }
  return ctx;
}

export function promoteDeferredPmMessages(
  roleManager: RoleManager,
  pmState?: RoleRuntimeState
): void {
  const pmIdle = pmState ? !pmState.serverBusy : !roleManager.isBusy(Role.PM);
  if (pmIdle) {
    const pmUnread = select<MessageRow>('messages', {
      to_role: Role.PM,
      status: MessageStatus.Unread,
    });
    if (pmUnread.length === 0) {
      rawRun(`UPDATE messages SET status = ? WHERE status = ? AND to_role = ?`, [
        MessageStatus.Unread,
        MessageStatus.Deferred,
        Role.PM,
      ]);
    }
  }
}

const MAX_DISPATCH_RETRIES = 3;
const DISPATCH_BACKOFF_MS = 30_000;

const INTENT_PRIORITY: Record<DispatchIntent['reason'], number> = {
  unread_messages: 0,
  stuck_session: 1,
  pending_work: 2,
};

function rotateRolesAfterLastDispatched(roles: Role[]): Role[] {
  if (!lastDispatchedRole) return roles;
  const idx = roles.indexOf(lastDispatchedRole);
  if (idx === -1) return roles;
  return [...roles.slice(idx + 1), ...roles.slice(0, idx + 1)];
}

function orderRolesForDispatch(intents?: DispatchIntent[]): Role[] {
  if (!intents || intents.length === 0) {
    return rotateRolesAfterLastDispatched([...AGENT_ROLES]);
  }

  const ordered: Role[] = [];
  const priorities = [...new Set(intents.map((i) => INTENT_PRIORITY[i.reason]))].sort(
    (a, b) => a - b
  );

  for (const priority of priorities) {
    const rolesAtPriority = [
      ...new Set(intents.filter((i) => INTENT_PRIORITY[i.reason] === priority).map((i) => i.role)),
    ];
    ordered.push(...rotateRolesAfterLastDispatched(rolesAtPriority));
  }

  return ordered;
}

export async function tryDispatchNormalRole(
  client: OpencodeClient,
  sessionManager: SessionManager,
  roleManager: RoleManager,
  onPmDispatchSuccess?: () => void,
  states?: Map<Role, RoleRuntimeState>,
  intents?: DispatchIntent[]
): Promise<void> {
  const intentRoles = orderRolesForDispatch(intents);

  for (const role of intentRoles) {
    const state = states?.get(role);
    const isBusy = state ? state.serverBusy : roleManager.isBusy(role);
    if (isBusy) continue;

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
          update(
            'messages',
            { id: msg.id },
            {
              status: MessageStatus.Read,
              retry_count: next,
              last_retry_at: now,
            }
          );
        } else {
          update(
            'messages',
            { id: msg.id },
            {
              retry_count: next,
              last_retry_at: now,
            }
          );
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
      if (dispatchSucceeded && role === Role.PM && onPmDispatchSuccess) {
        onPmDispatchSuccess();
      }
    }

    break;
  }
}
