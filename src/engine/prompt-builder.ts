import { select } from '../db/repository.js';
import { MessageStatus, TaskStatus } from '../db/types.js';
import type { KnowledgeEntry } from '../embedding/knowledge.js';
import type { MessageRow } from './dispatch-filter.js';
import {
  formatMessageProtocolForPrompt,
  parseMessageProtocolAttachment,
} from './message-protocol.js';
import { Role } from './role-manager.js';
import { selectWorkflowHints } from './workflow-hints.js';

/** Task context injected into DEV dispatch prompts */
export interface TaskContext {
  id: number;
  title: string;
  status: string;
  dependencies: Array<{ id: number; title: string; status: string }>;
  /** Resolved spec file path (relative to workspace) — DEV is expected to Read it on demand. */
  specPath: string | null;
}

/** Cap on a single handoff memory section injected into the prompt. */
const HANDOFF_SUMMARY_CAP = 480;

/** Cap on each knowledge entry preview when the index-mode block is emitted. */
const KNOWLEDGE_PREVIEW_CAP = 0;

const DEV_NON_ACTIONABLE_STATUSES = new Set<TaskStatus>([
  TaskStatus.Paused,
  TaskStatus.Cancelled,
  TaskStatus.Blocked,
  TaskStatus.Done,
]);

/**
 * Get task context for DEV role.
 * Returns task metadata + dependency statuses + spec path (no file content).
 * The full description/acceptance is already in the PM directive message body, so we
 * deliberately do NOT echo them here — the dispatch prompt only adds machine-readable
 * metadata that the message body would not naturally carry.
 */
export function getTaskContext(messages: MessageRow[]): TaskContext | null {
  const taskId = messages.find((m) => m.related_task_id)?.related_task_id;
  if (!taskId) return null;

  interface TaskRow {
    id: number;
    title: string;
    description: string | null;
    status: string;
  }
  interface DepRow {
    task_id: number;
    depends_on: number;
  }

  const tasks = select<TaskRow>('tasks', { id: taskId });
  if (tasks.length === 0) return null;

  const task = tasks[0];
  const deps = select<DepRow>('task_dependencies', { task_id: taskId });
  const dependencies: TaskContext['dependencies'] = [];
  for (const dep of deps) {
    const depTasks = select<TaskRow>('tasks', { id: dep.depends_on });
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
    status: task.status,
    dependencies,
    specPath: extractSpecPath(task.description, task.title),
  };
}

function extractSpecPath(description: string | null, title: string | null): string | null {
  const match =
    description?.match(/\.win-agent\/docs\/spec\/[\w-]+\.md/) ||
    title?.match(/\.win-agent\/docs\/spec\/[\w-]+\.md/);
  return match ? match[0] : null;
}

/**
 * Build the dispatch prompt injected into the role's session.
 *
 * Design philosophy:
 *   This prompt carries ONLY what the message body cannot — machine-readable task
 *   metadata, structured dependency snapshot, knowledge pointers. Role-level workflow
 *   (Phase 1→4, subagent rules, escalation paths) lives in the role's system prompt
 *   (DEV.md / PM.md); spec content / constitution / handoff details are referenced
 *   by path and read on demand. Repeating any of those here would inflate every
 *   dispatch by thousands of tokens for zero added information.
 *
 * Sections:
 * 1. 本次派发消息 (messages for this dispatch — authoritative PM-authored content)
 * 2. 任务元数据 (DEV only — task id/status/deps; description/acceptance live in §1)
 * 3. 前置 task 关键产出 (DEV only — truncated handoff summary)
 * 4. 可按需查阅 (spec path + knowledge index — DEV opens them on demand)
 * 5. DEV 待处理队列 (PM only, dedup guard)
 * 6. 提示 (PM only, action hints)
 */
export function buildDispatchPrompt(
  role: Role,
  messages: MessageRow[],
  knowledge: KnowledgeEntry[],
  taskContext?: TaskContext | null
): string {
  const parts: string[] = [];

  // 1. Messages delivered in this dispatch (authoritative human-readable content)
  parts.push('## 本次派发消息');
  for (const msg of messages) {
    const taskRef = msg.related_task_id ? ` (task#${msg.related_task_id})` : '';
    const attachmentContext = formatAttachmentsForPrompt(msg.attachments);
    parts.push(
      `来自 ${msg.from_role} [type: ${msg.type}]${taskRef}：\n${msg.content}` +
        (attachmentContext ? `\n\n${attachmentContext}` : '')
    );
  }

  // 2. Task metadata (DEV only) — structured pointers; description/acceptance are in §1
  if (taskContext) {
    const depSummary =
      taskContext.dependencies.length === 0
        ? '无'
        : taskContext.dependencies.map((d) => `task#${d.id} [${d.status}]`).join(', ');
    parts.push(
      `## 任务元数据 (task#${taskContext.id} · ${taskContext.status})\n` +
        `- 标题: ${taskContext.title}\n` +
        `- 前置依赖: ${depSummary}\n` +
        `- 完整描述 / 验收标准 / 验收流程：见上方 PM directive 消息正文`
    );

    // 3. Handoff summary from completed dependencies (truncated)
    if (role === Role.DEV) {
      const completedDeps = taskContext.dependencies.filter((d) => d.status === 'done');
      if (completedDeps.length > 0) {
        const memoryRows = select<{ content: string }>('memory', {
          role: 'DEV',
          trigger: 'task_complete',
        });
        for (const dep of completedDeps) {
          const relevantMemories = memoryRows.filter((m) => m.content.includes(`task#${dep.id}`));
          if (relevantMemories.length > 0) {
            const summary = truncateHandoff(relevantMemories[0].content);
            parts.push(`## 前置 task#${dep.id} 关键产出\n${summary}`);
          }
        }
      }
    }
  }

  // Workflow hints — short skill checklist (PM/DEV). Computed once; inserted near
  // the end so it doesn't disrupt the authoritative message/metadata sections.
  const workflowHints = selectWorkflowHints(role, messages, taskContext);

  // 4. On-demand references — spec path + knowledge index (DEV opens on demand)
  const refLines: string[] = [];
  if (taskContext?.specPath) {
    refLines.push(`- Spec: \`${taskContext.specPath}\`（用 Read 自取，无需此处内联）`);
  }
  for (const k of knowledge) {
    const preview =
      KNOWLEDGE_PREVIEW_CAP > 0
        ? ` — ${k.content.slice(0, KNOWLEDGE_PREVIEW_CAP).replace(/\n/g, ' ')}…`
        : '';
    refLines.push(
      `- 知识 [${k.category}] ${k.title}${preview}` + ` — \`database_query knowledge id=${k.id}\``
    );
  }
  if (refLines.length > 0) {
    parts.push(`## 可按需查阅\n${refLines.join('\n')}`);
  }

  // 4.5 Workflow hints — DEV: append after 可按需查阅 (DEV has no role-specific 提示 block).
  if (role === Role.DEV && workflowHints.length > 0) {
    parts.push(`## 工作流提示\n${workflowHints.join('\n')}`);
  }

  // 5. DEV pending queue (PM only) — dedup guard so PM doesn't resend
  //    directives already queued and waiting to be dispatched.
  if (role === Role.PM) {
    const pendingDevMsgs = select<MessageRow>(
      'messages',
      { to_role: Role.DEV, status: MessageStatus.Unread },
      { orderBy: 'created_at ASC' }
    ).filter(isActionableDevPendingMessage);

    if (pendingDevMsgs.length > 0) {
      const currentTaskIds = new Set(
        messages.filter((m) => m.related_task_id).map((m) => m.related_task_id)
      );

      const currentTaskMsgs = pendingDevMsgs.filter(
        (m) => m.related_task_id && currentTaskIds.has(m.related_task_id)
      );
      const otherCount = pendingDevMsgs.length - currentTaskMsgs.length;

      const lines: string[] = [];
      lines.push(`DEV 待处理队列（共 ${pendingDevMsgs.length} 条未读）：`);

      if (currentTaskMsgs.length > 0) {
        const taskRefs = [...currentTaskIds]
          .filter(Boolean)
          .map((id) => `task#${id}`)
          .join(', ');
        lines.push(`  当前 ${taskRefs} 相关（${currentTaskMsgs.length} 条）：`);
        for (const m of currentTaskMsgs) {
          const ref = m.related_task_id ? ` (task#${m.related_task_id})` : '';
          lines.push(
            `    - [msg#${m.id}] from:${m.from_role}${ref} ${m.content.slice(0, 80).replace(/\n/g, ' ')}…`
          );
        }
      }

      if (otherCount > 0) {
        lines.push(`  其他 task 共 ${otherCount} 条，无需关注`);
      }

      parts.push(`## 已排队消息（勿重复发送）\n${lines.join('\n')}`);
    }
  }

  // 6. Action hints — PM only. DEV's workflow lives in DEV.md system prompt;
  //    repeating it on every dispatch added ~1.5KB of zero-information overhead.
  if (role === Role.PM) {
    // Workflow hints — PM: insert before the role-specific 提示 block (提示 stays last).
    if (workflowHints.length > 0) {
      parts.push(`## 工作流提示\n${workflowHints.join('\n')}`);
    }
    parts.push(
      '## 提示\n处理完消息后，请通过 database_insert 写消息通知相关角色（如需要）。任务状态更新仅限以下场景：\n' +
        '- 取消任务：将未开始任务（pending_dev）设为 cancelled\n' +
        '- 验收审核：将 InReview 任务设为 done 或 rejected\n' +
        '- 阻塞处理：必要时将任务设为 blocked\n' +
        '**禁止将任务设为 in_dev**，该状态由 DEV 收到 directive 后自行设置。'
    );
  }

  return parts.join('\n\n');
}

/**
 * Truncate a handoff memory entry to the cap, preserving the leading task summary line.
 * Memory entries follow the convention "task#N 完成：<one-liner>。<details...>", so the
 * leading clause is the most useful signal; longer detail tails are cut to keep the
 * dispatch prompt focused.
 */
function truncateHandoff(content: string): string {
  if (content.length <= HANDOFF_SUMMARY_CAP) return content;
  return content.slice(0, HANDOFF_SUMMARY_CAP).trimEnd() + '…（完整内容见 memory 表）';
}

function formatAttachmentsForPrompt(attachments: string | null): string | null {
  if (!attachments) return null;

  const protocol = parseMessageProtocolAttachment(attachments);
  if (protocol.ok) {
    return formatMessageProtocolForPrompt(protocol.payload);
  }

  try {
    const parsed = JSON.parse(attachments) as unknown;
    return `attachments（非 ${protocolName()} 协议 JSON，原样保留）:\n${JSON.stringify(parsed, null, 2)}`;
  } catch {
    return `attachments（非 JSON，原样保留）:\n${attachments}`;
  }
}

function protocolName(): string {
  return 'win-agent.message.v1';
}

function isActionableDevPendingMessage(message: MessageRow): boolean {
  if (!message.related_task_id || message.type === 'cancel_task' || message.type === 'feedback') {
    return true;
  }

  const task = select<{ status: TaskStatus }>('tasks', { id: message.related_task_id })[0];
  return !task || !DEV_NON_ACTIONABLE_STATUSES.has(task.status);
}
