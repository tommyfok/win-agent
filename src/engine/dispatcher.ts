import type { OpencodeClient } from "@opencode-ai/sdk";
import type { SessionManager } from "./session-manager.js";
import { select, update } from "../db/repository.js";
import { TaskStatus, MessageStatus } from "../db/types.js";
import { queryRelevantKnowledge, type KnowledgeEntry } from "../embedding/knowledge.js";
import { insert as dbInsert } from "../db/repository.js";
import { checkAndBlockUnmetDependencies } from "./dependency-checker.js";
import { withRetry, withTimeout } from "./retry.js";
import { checkAndRotate } from "./memory-rotator.js";
import type { Role } from "./role-manager.js";

/** Options for dispatch functions */
export interface DispatchOptions {
  /** AbortSignal — if aborted, dispatch throws AbortError immediately */
  signal?: AbortSignal;
  /** Callback invoked with sessionId once the session is resolved, before prompt is sent.
   *  Used by scheduler to track the in-flight session for abort/resume. */
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
  // Group messages by related_task_id
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

  // Dispatch each group separately; check rotation per group to avoid cross-task token accumulation
  let lastSessionId: string | null = null;
  let totalInput = 0;
  let totalOutput = 0;

  for (const [taskKey, group] of groups) {
    const result = await dispatchToRole(client, sessionManager, role, group, options);
    if (result.sessionId) {
      // Rotation check uses this group's own sessionId and taskId (not accumulated totals)
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

/** Message row from the messages table */
export interface MessageRow {
  id: number;
  from_role: string;
  to_role: string;
  type: string;
  content: string;
  status: string;
  related_task_id: number | null;
  related_workflow_id: number | null;
  attachments: string | null;
  created_at: string;
}

/** Task context injected for DEV role */
interface TaskContext {
  id: number;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  acceptanceProcess: string | null;
  status: string;
  dependencies: Array<{ id: number; title: string; status: string }>;
}

/**
 * Dispatch a batch of unread messages to a role.
 *
 * 1. Get or create session
 * 2. Query relevant knowledge
 * 3. Build & send prompt
 * 4. Mark messages as read
 * 5. Return token usage for rotation check
 */
export async function dispatchToRole(
  client: OpencodeClient,
  sessionManager: SessionManager,
  role: Role,
  messages: MessageRow[],
  options?: DispatchOptions
): Promise<{ sessionId: string | null; inputTokens: number; outputTokens: number }> {
  // 0. Filter out messages for paused/blocked/cancelled tasks (9.4 dispatch awareness)
  // cancel_task messages are always delivered so DEV can execute rollback/cleanup.
  if (role === "DEV") {
    const SKIP_STATUSES: TaskStatus[] = [TaskStatus.Paused, TaskStatus.Cancelled, TaskStatus.Blocked, TaskStatus.Done];
    const filtered: MessageRow[] = [];
    for (const msg of messages) {
      if (msg.related_task_id && msg.type !== "cancel_task") {
        const tasks = select<{ id: number; status: TaskStatus }>("tasks", { id: msg.related_task_id });
        const taskStatus = tasks[0]?.status;
        if (taskStatus && SKIP_STATUSES.includes(taskStatus)) {
          update("messages", { id: msg.id }, { status: MessageStatus.Read });
          continue;
        }
        // Check unmet dependencies before dispatching to DEV
        if (taskStatus) {
          const blocked = checkAndBlockUnmetDependencies(msg.related_task_id, taskStatus);
          if (blocked) {
            update("messages", { id: msg.id }, { status: MessageStatus.Read });
            continue;
          }
        }
      }
      filtered.push(msg);
    }
    messages = filtered;
    if (messages.length === 0) {
      return { sessionId: null, inputTokens: 0, outputTokens: 0 };
    }
  }

  // 1. Get or create session
  const sessionId = await getSessionForRole(sessionManager, role, messages);
  options?.onSessionResolved?.(sessionId);

  // 2. Query relevant knowledge
  const messageContent = messages.map((m) => m.content).join("\n");
  let knowledge: KnowledgeEntry[] = [];
  try {
    knowledge = await queryRelevantKnowledge(messageContent);
  } catch {
    // Non-fatal — proceed without knowledge context
  }

  // 3. Get task context for DEV (task details + dependencies)
  const taskContext = role === "DEV" ? getTaskContext(messages) : null;

  // 4. Build and send prompt
  const pendingContext = sessionManager.consumePendingContext(sessionId);
  const prompt =
    (pendingContext ? pendingContext + "\n\n---\n\n" : "") +
    buildDispatchPrompt(role, messages, knowledge, taskContext);

  // session.prompt with retry + timeout (5 min per attempt, 3 attempts)
  const result = await withRetry(
    () =>
      withTimeout(
        client.session.prompt({
          path: { id: sessionId },
          body: {
            agent: role,
            parts: [{ type: "text", text: prompt }],
          },
        }),
        5 * 60 * 1000,
        `${role} session.prompt`
      ),
    { maxAttempts: 3, label: `${role} dispatch`, signal: options?.signal }
  );

  // 5. Mark messages as read
  for (const msg of messages) {
    update("messages", { id: msg.id }, { status: MessageStatus.Read });
  }

  // 6. Extract token usage and LLM output for traceability
  const inputTokens = result.data?.info?.tokens?.input ?? 0;
  const outputTokens = result.data?.info?.tokens?.output ?? 0;

  // Extract text parts for logging and persistence
  const textParts = result.data?.parts?.filter(
    (p): p is Extract<typeof p, { type: "text" }> => p.type === "text"
  );
  const outputText = textParts?.map((p) => p.text).join("\n") ?? "";

  // Print LLM response summary to terminal for visibility
  if (outputText.length > 0) {
    const preview = outputText.slice(0, 200).replace(/\n/g, " ");
    console.log(`   💬 ${role} 回复: ${preview}${outputText.length > 200 ? "..." : ""}`);
  } else {
    console.log(`   ⚠️  ${role} 无文本回复 (tokens: in=${inputTokens} out=${outputTokens})`);
  }

  // Persist LLM output to role_outputs for auditability
  try {
    if (outputText.length > 0) {
      dbInsert("role_outputs", {
        role,
        session_id: sessionId,
        input_summary: prompt.slice(0, 500),
        output_text: outputText,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        related_task_id: messages[0]?.related_task_id ?? null,
        related_workflow_id: messages[0]?.related_workflow_id ?? null,
      });
    }
  } catch {
    // Non-fatal — output persistence failure shouldn't block dispatch
  }

  // Log dispatch
  dbInsert("logs", {
    role,
    action: "dispatch",
    content: `处理 ${messages.length} 条消息 (from: ${[...new Set(messages.map((m) => m.from_role))].join(",")})`,
    related_task_id: messages[0]?.related_task_id ?? null,
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
): Promise<string> {
  if (role === "DEV") {
    // Use the task ID from the first message that has one
    const taskId = messages.find((m) => m.related_task_id)?.related_task_id;
    if (taskId) {
      return sessionManager.getTaskSession(taskId, role);
    }
    // No task ID found — this shouldn't happen since DEV messages should always
    // carry a related_task_id. Log a warning and use a sentinel session to avoid
    // silently colliding with a real task session.
    console.warn(`   ⚠️  ${role} 收到无 related_task_id 的消息，使用 fallback session`);
    return sessionManager.getTaskSession(-1, role);
  }

  return sessionManager.getSession(role);
}

/**
 * Get task context for DEV role.
 * Includes task details and dependency status.
 */
function getTaskContext(messages: MessageRow[]): TaskContext | null {
  const taskId = messages.find((m) => m.related_task_id)?.related_task_id;
  if (!taskId) return null;

  interface TaskRow {
    id: number;
    title: string;
    description: string | null;
    acceptance_criteria: string | null;
    acceptance_process: string | null;
    status: string;
  }
  interface DepRow {
    task_id: number;
    depends_on: number;
  }

  const tasks = select<TaskRow>("tasks", { id: taskId });
  if (tasks.length === 0) return null;

  const task = tasks[0];

  // Get dependency tasks
  const deps = select<DepRow>("task_dependencies", { task_id: taskId });
  const dependencies: TaskContext["dependencies"] = [];
  for (const dep of deps) {
    const depTasks = select<TaskRow>("tasks", { id: dep.depends_on });
    if (depTasks.length > 0) {
      dependencies.push({
        id: depTasks[0].id,
        title: depTasks[0].title,
        status: depTasks[0].status,
      });
    }
  }

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptance_criteria,
    acceptanceProcess: task.acceptance_process,
    status: task.status,
    dependencies,
  };
}

/**
 * Build the dispatch prompt injected into the role's session.
 *
 * Sections:
 * 1. 待处理消息 (pending messages)
 * 2. 当前任务 (task context, DEV only)
 * 3. 相关知识库 (relevant knowledge, if any)
 * 4. DEV 待处理队列 (PM only, dedup guard)
 * 5. 操作提示 (action hints)
 */
export function buildDispatchPrompt(
  role: string,
  messages: MessageRow[],
  knowledge: KnowledgeEntry[],
  taskContext?: TaskContext | null
): string {
  const parts: string[] = [];

  // 1. Pending messages
  parts.push("## 待处理消息");
  for (const msg of messages) {
    const taskRef = msg.related_task_id ? ` (task#${msg.related_task_id})` : "";
    parts.push(`**来自 ${msg.from_role}**${taskRef}：\n${msg.content}`);
  }

  // 2. Task context (for DEV)
  if (taskContext) {
    const depLines =
      taskContext.dependencies.length > 0
        ? taskContext.dependencies
            .map((d) => `  - task#${d.id} ${d.title} [${d.status}]`)
            .join("\n")
        : "  无前置依赖";
    parts.push(
      `## 当前任务 (task#${taskContext.id})\n` +
        `- 标题: ${taskContext.title}\n` +
        `- 状态: ${taskContext.status}\n` +
        (taskContext.description ? `- 描述: ${taskContext.description}\n` : "") +
        (taskContext.acceptanceCriteria ? `- 验收标准:\n${taskContext.acceptanceCriteria}\n` : "") +
        (taskContext.acceptanceProcess ? `- 验收流程:\n${taskContext.acceptanceProcess}\n` : "") +
        `- 前置依赖:\n${depLines}`
    );
  }

  // 3. Relevant knowledge
  if (knowledge.length > 0) {
    parts.push("## 相关知识库");
    for (const k of knowledge) {
      parts.push(`### ${k.title} (${k.category})\n${k.content}`);
    }
  }

  // 4. DEV pending queue (PM only) — dedup guard so PM doesn't resend
  //    directives that are already queued and waiting to be dispatched.
  //    Includes both PM and system messages so PM is aware of system notifications.
  if (role === "PM") {
    const pendingDevMsgs = select<MessageRow>(
      "messages",
      { to_role: "DEV", status: MessageStatus.Unread },
      { orderBy: "created_at ASC" }
    );

    if (pendingDevMsgs.length > 0) {
      const lines: string[] = [];
      lines.push(`DEV 待处理队列（${pendingDevMsgs.length} 条未读，无需重发）：`);
      for (const m of pendingDevMsgs) {
        const ref = m.related_task_id ? ` (task#${m.related_task_id})` : "";
        lines.push(`  - [msg#${m.id}] from:${m.from_role}${ref} ${m.content.slice(0, 80).replace(/\n/g, " ")}…`);
      }
      parts.push(`## 已排队消息（勿重复发送）\n${lines.join("\n")}`);
    }
  }

  // 5. Action hints
  parts.push(
    "## 提示\n处理完消息后，请通过 database_insert 写消息通知相关角色（如需要），并通过 database_update 更新任务状态（如适用）。"
  );

  return parts.join("\n\n");
}
