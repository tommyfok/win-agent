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

  // 4. Build and send prompt
  const prompt = buildDispatchPrompt(role, messages, knowledge, workflowContext);

  const result = await client.session.prompt({
    path: { id: sessionId },
    body: {
      agent: role,
      parts: [{ type: "text", text: prompt }],
    },
  });

  // 5. Mark messages as read
  for (const msg of messages) {
    update("messages", { id: msg.id }, { status: "read" });
  }

  // 6. Extract token usage for rotation check
  const inputTokens = result.data?.info?.tokens?.input ?? 0;

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

  // 3. Relevant knowledge
  if (knowledge.length > 0) {
    parts.push("## 相关知识库");
    for (const k of knowledge) {
      parts.push(`### ${k.title} (${k.category})\n${k.content}`);
    }
  }

  // 4. Action hints
  parts.push(
    "## 提示\n处理完消息后，请通过 database_insert 写消息通知相关角色（如需要），并通过 database_update 更新任务状态（如适用）。",
  );

  return parts.join("\n\n");
}
