import fs from "node:fs";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { SessionManager } from "./session-manager.js";
import { select, update } from "../db/repository.js";
import {
  queryRelevantKnowledge,
  type KnowledgeEntry,
} from "../embedding/knowledge.js";
import { insert as dbInsert } from "../db/repository.js";
import { withRetry, withTimeout } from "./retry.js";

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

/** Workflow context injected into dispatch prompt */
interface WorkflowContext {
  template: string;
  phase: string;
  roleGuide: string;
}

/** Task context injected for DEV/QA roles */
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
 * 3. Get workflow context
 * 4. Build & send prompt
 * 5. Mark messages as read
 * 6. Return token usage for rotation check
 */
export async function dispatchToRole(
  client: OpencodeClient,
  sessionManager: SessionManager,
  role: string,
  messages: MessageRow[],
  workspace: string,
): Promise<{ sessionId: string; inputTokens: number }> {
  // 1. Get or create session
  const sessionId = await getSessionForRole(sessionManager, role, messages);

  // 2. Query relevant knowledge
  const messageContent = messages.map((m) => m.content).join("\n");
  let knowledge: KnowledgeEntry[] = [];
  try {
    knowledge = await queryRelevantKnowledge(messageContent);
  } catch {
    // Non-fatal — proceed without knowledge context
  }

  // 3. Get workflow context (from first message with workflow_id)
  const workflowContext = getWorkflowContext(messages, workspace);

  // 3b. Get task context for DEV/QA (task details + dependencies)
  const taskContext = (role === "DEV" || role === "QA")
    ? getTaskContext(messages)
    : null;

  // 4. Build and send prompt
  const prompt = buildDispatchPrompt(role, messages, knowledge, workflowContext, taskContext);

  // Debug: raw HTTP call to see actual server response
  console.log(`   [debug] testing raw HTTP call to opencode...`);
  try {
    const serverUrl = (client as any)._client?.getConfig?.()?.baseUrl ?? "";
    const rawRes = await fetch(`${serverUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "回复OK" }] }),
      signal: AbortSignal.timeout(120_000),
    });
    const rawHeaders: Record<string, string> = {};
    rawRes.headers.forEach((v, k) => { rawHeaders[k] = v; });
    const rawBody = await rawRes.text();
    console.log(`   [debug] raw response: status=${rawRes.status}, Content-Length=${rawRes.headers.get("Content-Length")}`);
    console.log(`   [debug] raw headers: ${JSON.stringify(rawHeaders)}`);
    console.log(`   [debug] raw body (first 500): ${rawBody.slice(0, 500)}`);
  } catch (err) {
    console.log(`   [debug] raw HTTP call failed: ${err}`);
  }

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
        `${role} session.prompt`,
      ),
    { maxAttempts: 3, label: `${role} dispatch` },
  );

  // 5. Mark messages as read
  for (const msg of messages) {
    update("messages", { id: msg.id }, { status: "read" });
  }

  // 6. Extract token usage and LLM output for traceability
  // Debug: dump full response structure
  console.log(`   [debug] result keys: ${Object.keys(result)}`);
  console.log(`   [debug] result.data keys: ${result.data ? Object.keys(result.data) : "null"}`);
  console.log(`   [debug] result.error: ${JSON.stringify(result.error ?? null)}`);
  console.log(`   [debug] result.data?.info: ${JSON.stringify(result.data?.info ?? null)}`);
  console.log(`   [debug] result.data?.parts count: ${result.data?.parts?.length ?? 0}`);
  if (result.data?.parts?.length) {
    for (const p of result.data.parts.slice(0, 3)) {
      console.log(`   [debug] part type=${p.type}, preview=${JSON.stringify(p).slice(0, 200)}`);
    }
  }

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

  return { sessionId, inputTokens };
}

/**
 * Get the appropriate session for a role.
 * DEV/QA: task-scoped session. PM/SA/OPS: persistent session.
 */
async function getSessionForRole(
  sessionManager: SessionManager,
  role: string,
  messages: MessageRow[],
): Promise<string> {
  if (role === "DEV" || role === "QA") {
    // Use the task ID from the first message that has one
    const taskId = messages.find((m) => m.related_task_id)?.related_task_id;
    if (taskId) {
      return sessionManager.getTaskSession(
        taskId,
        role as "DEV" | "QA",
      );
    }
    // Fallback: create task session with ID 0 (shouldn't happen in practice)
    return sessionManager.getTaskSession(0, role as "DEV" | "QA");
  }

  return sessionManager.getSession(role as "PM" | "SA" | "OPS");
}

/**
 * Extract workflow context from messages.
 * Looks up the workflow instance and loads the template to find the role's guide.
 */
function getWorkflowContext(
  messages: MessageRow[],
  workspace: string,
): WorkflowContext | null {
  // Find the first message with a workflow reference
  const workflowId =
    messages.find((m) => m.related_workflow_id)?.related_workflow_id;
  if (!workflowId) return null;

  const workflows = select("workflow_instances", { id: workflowId });
  if (workflows.length === 0) return null;

  const wf = workflows[0];
  const role = messages[0].to_role;

  // Load the template JSON
  const templatePath = path.join(
    workspace,
    ".win-agent",
    "workflows",
    `${wf.template}.json`,
  );
  if (!fs.existsSync(templatePath)) return null;

  try {
    const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
    const roleGuide = template.roles_guide?.[role]?.[wf.phase] ?? "";

    return {
      template: wf.template,
      phase: wf.phase,
      roleGuide,
    };
  } catch {
    return null;
  }
}

/**
 * Get task context for DEV/QA roles.
 * Includes task details and dependency status.
 */
function getTaskContext(messages: MessageRow[]): TaskContext | null {
  const taskId = messages.find((m) => m.related_task_id)?.related_task_id;
  if (!taskId) return null;

  const tasks = select("tasks", { id: taskId }) as Array<{
    id: number;
    title: string;
    description: string | null;
    acceptance_criteria: string | null;
    acceptance_process: string | null;
    status: string;
  }>;
  if (tasks.length === 0) return null;

  const task = tasks[0];

  // Get dependency tasks
  const deps = select("task_dependencies", { task_id: taskId }) as Array<{ depends_on: number }>;
  const dependencies: TaskContext["dependencies"] = [];
  for (const dep of deps) {
    const depTasks = select("tasks", { id: dep.depends_on }) as Array<{
      id: number;
      title: string;
      status: string;
    }>;
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
 * 2. 当前工作流 (workflow context, if any)
 * 3. 相关知识库 (relevant knowledge, if any)
 * 4. 操作提示 (action hints)
 */
export function buildDispatchPrompt(
  role: string,
  messages: MessageRow[],
  knowledge: KnowledgeEntry[],
  workflowContext: WorkflowContext | null,
  taskContext?: TaskContext | null,
): string {
  const parts: string[] = [];

  // 1. Pending messages
  parts.push("## 待处理消息");
  for (const msg of messages) {
    const taskRef = msg.related_task_id
      ? ` (task#${msg.related_task_id})`
      : "";
    parts.push(`**来自 ${msg.from_role}**${taskRef}：\n${msg.content}`);
  }

  // 2. Workflow context
  if (workflowContext) {
    parts.push(
      `## 当前工作流\n- 流程: ${workflowContext.template}\n- 阶段: ${workflowContext.phase}\n- 你在当前阶段的职责: ${workflowContext.roleGuide}`,
    );
  }

  // 3. Task context (for DEV/QA)
  if (taskContext) {
    const depLines = taskContext.dependencies.length > 0
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
      `- 前置依赖:\n${depLines}`,
    );
  }

  // 4. Relevant knowledge
  if (knowledge.length > 0) {
    parts.push("## 相关知识库");
    for (const k of knowledge) {
      parts.push(`### ${k.title} (${k.category})\n${k.content}`);
    }
  }

  // 5. Action hints
  parts.push(
    "## 提示\n处理完消息后，请通过 database_insert 写消息通知相关角色（如需要），并通过 database_update 更新任务状态（如适用）。",
  );

  return parts.join("\n\n");
}
