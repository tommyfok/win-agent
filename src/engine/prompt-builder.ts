import { select } from '../db/repository.js';
import { MessageStatus } from '../db/types.js';
import type { KnowledgeEntry } from '../embedding/knowledge.js';
import type { MessageRow } from './dispatch-filter.js';
import { Role } from './role-manager.js';
import path from 'node:path';
import fs from 'node:fs';

/** Task context injected into DEV dispatch prompts */
export interface TaskContext {
  id: number;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  acceptanceProcess: string | null;
  status: string;
  dependencies: Array<{ id: number; title: string; status: string }>;
  specContent: string | null;
  constitutionContent: string | null;
}

/**
 * Get task context for DEV role.
 * Returns task details and its dependency statuses, or null if no task is found.
 */
export function getTaskContext(messages: MessageRow[], workspace?: string): TaskContext | null {
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
    description: task.description,
    acceptanceCriteria: task.acceptance_criteria,
    acceptanceProcess: task.acceptance_process,
    status: task.status,
    dependencies,
    specContent: workspace ? getSpecContentForTask(task.description, task.title, workspace) : null,
    constitutionContent: workspace ? getConstitutionContent(workspace) : null,
  };
}

function getSpecContentForTask(
  description: string | null,
  title: string | null,
  workspace: string
): string | null {
  const specPathMatch =
    description?.match(/\.win-agent\/docs\/spec\/[\w-]+\.md/) ||
    title?.match(/\.win-agent\/docs\/spec\/[\w-]+\.md/);
  if (!specPathMatch) return null;
  try {
    const specPath = path.join(workspace, specPathMatch[0]);
    return fs.readFileSync(specPath, 'utf-8');
  } catch {
    return null;
  }
}

function getConstitutionContent(workspace: string): string | null {
  const constitutionPath = path.join(workspace, '.win-agent', 'docs', 'constitution.md');
  try {
    if (fs.existsSync(constitutionPath)) {
      return fs.readFileSync(constitutionPath, 'utf-8');
    }
  } catch {
    return null;
  }
  return null;
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
  role: Role,
  messages: MessageRow[],
  knowledge: KnowledgeEntry[],
  taskContext?: TaskContext | null
): string {
  const parts: string[] = [];

  // 1. Pending messages
  parts.push('## 待处理消息');
  for (const msg of messages) {
    const taskRef = msg.related_task_id ? ` (task#${msg.related_task_id})` : '';
    parts.push(`来自 ${msg.from_role} [type: ${msg.type}]${taskRef}：\n${msg.content}`);
  }

  // 2. Task context (for DEV)
  if (taskContext) {
    const depLines =
      taskContext.dependencies.length > 0
        ? taskContext.dependencies
            .map((d) => `  - task#${d.id} ${d.title} [${d.status}]`)
            .join('\n')
        : '  无前置依赖';
    parts.push(
      `## 当前任务 (task#${taskContext.id})\n` +
        `- 标题: ${taskContext.title}\n` +
        `- 状态: ${taskContext.status}\n` +
        (taskContext.description ? `- 描述: ${taskContext.description}\n` : '') +
        (taskContext.acceptanceCriteria ? `- 验收标准:\n${taskContext.acceptanceCriteria}\n` : '') +
        (taskContext.acceptanceProcess ? `- 验收流程:\n${taskContext.acceptanceProcess}\n` : '') +
        `- 前置依赖:\n${depLines}`
    );

    if (taskContext.specContent) {
      parts.push(`## Feature Spec（完整内容）\n${taskContext.specContent}`);
    }

    if (taskContext.constitutionContent) {
      parts.push(`## 项目约束（constitution）\n${taskContext.constitutionContent}`);
    }

    if (role === Role.DEV && taskContext.dependencies.some((d) => d.status === 'done')) {
      const completedDeps = taskContext.dependencies.filter((d) => d.status === 'done');
      const memoryRows = select<{ content: string }>('memory', {
        role: 'DEV',
        trigger: 'task_complete',
      });
      for (const dep of completedDeps) {
        const relevantMemories = memoryRows.filter((m) => m.content.includes(`task#${dep.id}`));
        if (relevantMemories.length > 0) {
          parts.push(`## 前置任务 task#${dep.id} 完成摘要\n${relevantMemories[0].content}`);
        }
      }
    }
  }

  // 3. Relevant knowledge
  if (knowledge.length > 0) {
    parts.push('## 相关知识库');
    for (const k of knowledge) {
      parts.push(`### ${k.title} (${k.category})\n${k.content}`);
    }
  }

  // 4. DEV pending queue (PM only) — dedup guard so PM doesn't resend
  //    directives already queued and waiting to be dispatched.
  if (role === Role.PM) {
    const pendingDevMsgs = select<MessageRow>(
      'messages',
      { to_role: Role.DEV, status: MessageStatus.Unread },
      { orderBy: 'created_at ASC' }
    );

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

  // 5. Action hints (role-specific)
  if (role === Role.DEV) {
    parts.push(
      '## ⚠️ 执行要求（严格遵守）\n' +
        '你必须严格按照 Phase 1 → 2 → 3 → 4 顺序执行，禁止跳过任何 Phase。\n\n' +
        '**Phase 1 — 环境感知（必须先完成再做任何事）：**\n' +
        '1. 执行 `git log --oneline -10` + `git status` 了解代码现状\n' +
        '2. 查看近期工作回忆（系统注入的或查询 memory 表）\n' +
        '3. 阅读上方注入的任务上下文（任务描述、验收标准）\n\n' +
        '**Phase 2 — 消息分派：** 根据消息 type 选择对应分支\n\n' +
        '**Phase 3 — 开发和自测：** 阅读 spec → 开发（按 development.md）→ 验证（按 validation.md），全部通过才能进入 Phase 4\n\n' +
        '**Phase 4 — 收尾：** git commit → 更新状态为 done → 写交接记忆 → 经验归档 → 发验收报告给 PM\n\n' +
        '**禁止行为：**\n' +
        '- 禁止跳过 Phase 1 直接开始编码\n' +
        '- 禁止跳过 Phase 3 的验证步骤（development.md + validation.md）直接提交验收\n' +
        '- 禁止在 validation.md 验证未通过时进入 Phase 4'
    );
  } else {
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
