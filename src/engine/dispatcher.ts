import crypto from 'node:crypto';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SessionManager } from './session-manager.js';
import { update, insert as dbInsert, withTransaction } from '../db/repository.js';
import { MessageStatus } from '../db/types.js';
import { queryRelevantKnowledge, type KnowledgeEntry } from '../embedding/knowledge.js';
import { match } from 'ts-pattern';
import { withRetry, withTimeout } from './retry.js';
import { checkAndRotate } from './memory-rotator.js';
import { filterMessagesForRole } from './dispatch-filter.js';
import type { MessageRow } from './dispatch-filter.js';
import { buildDispatchPrompt, getTaskContext } from './prompt-builder.js';
import { Role } from './role-manager.js';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Re-export MessageRow for callers that previously imported from here
export type { MessageRow };

/** Options for dispatch functions */
export interface DispatchOptions {
  /** AbortSignal — if aborted, dispatch throws AbortError immediately */
  signal?: AbortSignal;
  /** Callback invoked with sessionId once the session is resolved, before prompt is sent. */
  onSessionResolved?: (sessionId: string) => void;
}

/**
 * Dispatch messages to a role, grouped by related_task_id.
 * Each task group is dispatched separately to ensure correct session & context.
 * Non-task messages (related_task_id = null) are dispatched together.
 */
export async function dispatchToRoleGrouped(
  client: OpencodeClient,
  sessionManager: SessionManager,
  role: Role,
  messages: MessageRow[],
  options?: DispatchOptions
): Promise<{ sessionId: string | null; inputTokens: number; outputTokens: number }> {
  const groups = new Map<number | null, MessageRow[]>();
  for (const msg of messages) {
    const key = msg.related_task_id;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(msg);
  }

  let lastSessionId: string | null = null;
  let totalInput = 0;
  let totalOutput = 0;

  for (const [taskKey, group] of groups) {
    const result = await dispatchToRole(client, sessionManager, role, group, options);
    if (result.sessionId) {
      await checkAndRotate(
        sessionManager,
        role,
        result.sessionId,
        result.inputTokens,
        result.outputTokens,
        taskKey ?? undefined
      );
      lastSessionId = result.sessionId;
    }
    totalInput += result.inputTokens;
    totalOutput += result.outputTokens;
  }

  return { sessionId: lastSessionId, inputTokens: totalInput, outputTokens: totalOutput };
}

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
  const traceId = crypto.randomUUID().slice(0, 8);
  const log = logger.child({ traceId, role });

  // 1. Filter messages (DEV skips paused/blocked/cancelled/done tasks)
  messages = filterMessagesForRole(role, messages);
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

  const result = await withRetry(
    () =>
      withTimeout(
        client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: 'text', text: prompt }],
          },
        }),
        loadConfig().engine?.dispatchTimeoutMs ?? 30 * 60 * 1000, // 30 minutes
        `${role} session.prompt`
      ),
    { maxAttempts: 3, label: `${role} dispatch`, signal: options?.signal }
  );

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
      });
    }
    dbInsert('logs', {
      role,
      action: 'dispatch',
      content: `处理 ${messages.length} 条消息 (from: ${[...new Set(messages.map((m) => m.from_role))].join(',')})`,
      related_task_id: messages[0]?.related_task_id ?? null,
    });
  });

  return { sessionId, inputTokens, outputTokens };
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
      const taskId = messages.find((m) => m.related_task_id)?.related_task_id;
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
    .with(Role.PM, (pmRole) => sessionManager.getSession(pmRole))
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
