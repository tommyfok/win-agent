import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SessionManager } from './session-manager.js';
import { update, insert as dbInsert, withTransaction } from '../db/repository.js';
import { MessageStatus } from '../db/types.js';
import { queryRelevantKnowledge, type KnowledgeEntry } from '../embedding/knowledge.js';
import { match } from 'ts-pattern';
import { withAbortableTimeout, withRetry } from './retry.js';
import { filterMessagesForRole } from './dispatch-filter.js';
import type { MessageRow } from './dispatch-filter.js';
import { buildDispatchPrompt, getTaskContext } from './prompt-builder.js';
import { Role } from './role-manager.js';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getModelForRole } from './role-model.js';
import { startDevSessionStallMonitor } from './dev-session-nudger.js';
import { createTraceId, withTrace } from './trace.js';

export type { MessageRow };

/** Options for dispatch functions */
export interface DispatchOptions {
  /** AbortSignal — if aborted, dispatch throws AbortError immediately */
  signal?: AbortSignal;
  /** Trace id created by the scheduler for this dispatch lifecycle. */
  traceId?: string;
  /** Callback invoked with sessionId once the session is resolved, before prompt is sent. */
  onSessionResolved?: (sessionId: string) => void;
}

const DEV_TASK_REQUIRED_MESSAGE_TYPES = new Set([
  'directive',
  'feedback',
  'cancel_task',
  'notification',
]);

/**
 * Dispatch a batch of unread messages to a role.
 *
 * 1. Filter messages (skip paused/blocked/cancelled tasks for DEV)
 * 2. Get or create session
 * 3. Query relevant knowledge
 * 4. Build & send prompt
 * 5. Mark messages as read
 * 6. Persist output for auditability
 */
export async function dispatchToRole(
  client: OpencodeClient,
  sessionManager: SessionManager,
  role: Role,
  messages: MessageRow[],
  options?: DispatchOptions
): Promise<{ sessionId: string | null; inputTokens: number; outputTokens: number }> {
  const traceId = options?.traceId ?? createTraceId('dispatch');
  return withTrace(traceId, () =>
    dispatchToRoleWithTrace(client, sessionManager, role, messages, traceId, options)
  );
}

async function dispatchToRoleWithTrace(
  client: OpencodeClient,
  sessionManager: SessionManager,
  role: Role,
  messages: MessageRow[],
  traceId: string,
  options?: DispatchOptions
): Promise<{ sessionId: string | null; inputTokens: number; outputTokens: number }> {
  const log = logger.child({ traceId, role });

  // 1. Filter messages (DEV skips paused/blocked/cancelled/done tasks)
  messages = filterMessagesForRole(role, messages);
  messages = filterInvalidDevFallbackMessages(role, messages, log, traceId);
  if (messages.length === 0) {
    log.warn({ role }, 'no messages to dispatch');
    return { sessionId: null, inputTokens: 0, outputTokens: 0 };
  }

  // 2. Get or create session
  const sessionId = await getSessionForRole(sessionManager, role, messages);
  if (!sessionId) {
    log.warn({ role }, 'no session found for role');
    return { sessionId: null, inputTokens: 0, outputTokens: 0 };
  }
  options?.onSessionResolved?.(sessionId);

  // 3. Query relevant knowledge
  const messageContent = messages.map((m) => m.content).join('\n');
  let knowledge: KnowledgeEntry[] = [];
  try {
    knowledge = await queryRelevantKnowledge(messageContent);
  } catch (e) {
    log.warn({ error: e }, 'knowledge injection failed');
  }

  // 4. Build and send prompt
  const taskContext =
    role === Role.DEV ? getTaskContext(messages, sessionManager.getWorkspace()) : null;
  const pendingContext = sessionManager.consumePendingContext(sessionId);
  const prompt =
    (pendingContext ? pendingContext + '\n\n---\n\n' : '') +
    buildDispatchPrompt(role, messages, knowledge, taskContext);
  const model = getModelForRole(role, sessionManager.getWorkspace());

  const stopStallMonitor =
    role === Role.DEV
      ? startDevSessionStallMonitor(client, sessionManager.getWorkspace(), sessionId)
      : () => undefined;
  const result = await withRetry(
    () =>
      withAbortableTimeout(
        (signal) =>
          client.session.prompt({
            path: { id: sessionId },
            signal,
            body: {
              ...(model ? { model } : {}),
              parts: [{ type: 'text', text: prompt }],
            },
          }),
        loadConfig(sessionManager.getWorkspace()).engine?.dispatchTimeoutMs ?? 10 * 60 * 1000,
        `${role} session.prompt`,
        options?.signal
      ),
    { maxAttempts: 3, label: `${role} dispatch`, signal: options?.signal }
  ).finally(stopStallMonitor);

  // 5+6. Extract token usage, then atomically: mark messages read + persist output + write log
  const inputTokens = result.data?.info?.tokens?.input ?? 0;
  const outputTokens = result.data?.info?.tokens?.output ?? 0;

  const textParts = result.data?.parts?.filter(
    (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
  );
  const outputText = textParts?.map((p) => p.text).join('\n') ?? '';

  if (outputText.length > 0) {
    const preview = outputText.slice(0, 200).replace(/\n/g, ' ');
    log.info({ inputTokens, outputTokens, preview }, 'dispatch complete');
  } else {
    log.info({ inputTokens, outputTokens }, 'dispatch complete — no text output');
  }

  withTransaction(() => {
    for (const msg of messages) {
      update('messages', { id: msg.id }, { status: MessageStatus.Read });
    }
    if (outputText.length > 0) {
      dbInsert('role_outputs', {
        role,
        session_id: sessionId,
        input_summary: prompt.slice(0, 500),
        output_text: outputText,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        related_task_id: messages[0]?.related_task_id ?? null,
        related_iteration_id: messages[0]?.related_iteration_id ?? null,
        trace_id: traceId,
      });
    }
    dbInsert('logs', {
      role,
      action: 'dispatch',
      content: `处理 ${messages.length} 条消息 (from: ${[...new Set(messages.map((m) => m.from_role))].join(',')})`,
      related_task_id: messages[0]?.related_task_id ?? null,
      trace_id: traceId,
    });
  });

  return { sessionId, inputTokens, outputTokens };
}

function filterInvalidDevFallbackMessages(
  role: Role,
  messages: MessageRow[],
  log: { warn: (obj: unknown, msg?: string) => void },
  traceId: string
): MessageRow[] {
  if (role !== Role.DEV) return messages;

  const valid: MessageRow[] = [];
  const invalid: MessageRow[] = [];
  for (const msg of messages) {
    if (!msg.related_task_id && DEV_TASK_REQUIRED_MESSAGE_TYPES.has(msg.type)) {
      invalid.push(msg);
    } else {
      valid.push(msg);
    }
  }

  if (invalid.length === 0) return valid;

  withTransaction(() => {
    for (const msg of invalid) {
      update('messages', { id: msg.id }, { status: MessageStatus.Read });
      dbInsert('messages', {
        from_role: Role.SYS,
        to_role: Role.PM,
        type: 'system',
        content:
          `DEV 消息 msg#${msg.id} 缺少 related_task_id，已跳过，避免污染 DEV fallback session。` +
          `请重新创建带 task 关联的 ${msg.type} 消息。`,
        status: MessageStatus.Unread,
      });
      dbInsert('logs', {
        role: Role.SYS,
        action: 'dev_message_missing_task',
        content: `Skipped DEV ${msg.type} message msg#${msg.id} without related_task_id`,
        trace_id: traceId,
      });
    }
  });

  log.warn(
    { invalidMessageIds: invalid.map((m) => m.id) },
    'skipped DEV task-bound messages without related_task_id'
  );
  return valid;
}

/**
 * Get the appropriate session for a role.
 * DEV: task-scoped session. PM: persistent session.
 */
async function getSessionForRole(
  sessionManager: SessionManager,
  role: Role,
  messages: MessageRow[]
): Promise<string | null> {
  return match(role)
    .with(Role.DEV, (devRole) => {
      const taskIds = new Set(messages.map((m) => m.related_task_id));
      if (taskIds.size > 1) {
        throw new Error(
          `dispatchToRole received messages from multiple tasks: ${[...taskIds].join(',')}`
        );
      }
      const taskId = messages[0].related_task_id;
      if (taskId) {
        return sessionManager.getTaskSession(taskId, devRole);
      } else {
        logger.warn(
          { role },
          'DEV received messages with no related_task_id, using fallback session'
        );
        return sessionManager.getTaskSession(-1, devRole);
      }
    })
    .with(Role.PM, (pmRole) => sessionManager.ensureSession(pmRole))
    .with(Role.USER, Role.SYS, Role.ASSISTANT, () => {
      logger.warn(
        { role },
        'Unsupported roles for dispatch session resolution: ' +
          [Role.USER, Role.SYS, Role.ASSISTANT].join(',')
      );
      return null;
    })
    .exhaustive();
}
