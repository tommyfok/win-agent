import { select, update, insert, rawQuery } from '../db/repository.js';
import { MessageStatus } from '../db/types.js';
import type { SessionManager } from './session-manager.js';
import { cleanExpiredMemories } from '../embedding/memory.js';
import { cleanExpiredOutputs } from './output-cleaner.js';

interface WorkflowRow {
  id: number;
  template: string;
  phase: string;
  status: string;
  updated_at: string;
  context?: string;
}

/**
 * Check all active workflow instances for completion conditions.
 * When a workflow's completion condition is met:
 * 1. Update workflow status to 'completed' and phase to 'done'
 * 2. Release task sessions for DEV
 * 3. Send a system message to PM to trigger final reporting
 */
export function checkWorkflowCompletion(sessionManager?: SessionManager | null): void {
  const activeWorkflows = select<WorkflowRow>('workflow_instances', { status: 'active' });

  for (const wf of activeWorkflows) {
    // Check phase advancement for multi-phase workflows before completion
    checkPhaseAdvancement(wf);

    const completed = checkCompletion(wf);
    if (completed) {
      // Update workflow status
      update('workflow_instances', { id: wf.id }, { status: 'completed', phase: 'done' });

      // Release task sessions for completed tasks
      if (sessionManager) {
        const tasks = select<{ id: number }>('tasks', { workflow_id: wf.id });
        for (const task of tasks) {
          sessionManager.releaseTaskSession(task.id);
        }
      }

      // Send notification to PM — skip for iteration-review since PM already
      // sent the review-completion message that triggered this transition.
      // Sending again would cause PM to re-archive and re-report redundantly.
      if (wf.template !== 'iteration-review') {
        insert('messages', {
          from_role: 'system',
          to_role: 'PM',
          type: 'system',
          content: buildCompletionMessage(wf),
          status: MessageStatus.Unread,
          related_workflow_id: wf.id,
        });
      }

      // Send reflection trigger to all participating roles
      sendReflectionTriggers(wf);

      // Clean up expired memories and outputs on iteration-review completion
      if (wf.template === 'iteration-review') {
        const cleaned = cleanExpiredMemories();
        if (cleaned > 0) {
          insert('logs', {
            role: 'system',
            action: 'memory_cleanup',
            content: `已清理 ${cleaned} 条过期记忆（90+ 天）`,
          });
          console.log(`   🧹 已清理 ${cleaned} 条过期记忆`);
        }
        const cleanedOutputs = cleanExpiredOutputs();
        if (cleanedOutputs > 0) {
          insert('logs', {
            role: 'system',
            action: 'output_cleanup',
            content: `已清理 ${cleanedOutputs} 条过期角色输出（90+ 天）`,
          });
          console.log(`   🧹 已清理 ${cleanedOutputs} 条过期角色输出`);
        }
      }

      insert('logs', {
        role: 'system',
        action: 'workflow_completed',
        content: `工作流 #${wf.id} (${wf.template}) 已完成`,
      });

      console.log(`   ✅ 工作流 #${wf.id} (${wf.template}) 已完成`);
    }
  }
}

/**
 * Check if a workflow's completion condition is met.
 */
function checkCompletion(wf: WorkflowRow): boolean {
  const template = wf.template;

  switch (template) {
    case 'new-feature':
    case 'bug-fix':
      return checkAllTasksDone(wf.id);

    case 'iteration-review':
      return checkIterationReviewDone(wf);

    default:
      // Unknown template — fall back to all-tasks-done check
      return checkAllTasksDone(wf.id);
  }
}

/**
 * For new-feature and bug-fix: all non-cancelled tasks must be done,
 * and at least one non-cancelled task must exist.
 */
function checkAllTasksDone(workflowId: number): boolean {
  const tasks = select<{ id: number; status: string }>('tasks', { workflow_id: workflowId });

  // No tasks yet — workflow not complete
  if (tasks.length === 0) return false;

  const active = tasks.filter((t) => t.status !== 'cancelled');
  return active.length > 0 && active.every((t) => t.status === 'done');
}

/**
 * For iteration-review: check if the phase has reached 'done'
 * (PM completes archival → engine advances phase to done).
 * Since the workflow itself transitions phases via messages,
 * we check if we're already in the done phase.
 */
function checkIterationReviewDone(wf: WorkflowRow): boolean {
  // The workflow is completed when it reaches the "done" phase
  // and PM has archived it. Since we check active workflows,
  // and the phase is updated by message handling, we look for
  // the done phase explicitly.
  return wf.phase === 'done';
}

/**
 * Check if a multi-phase workflow should advance to the next phase.
 * For iteration-review: PM sends a message with the workflow_id to signal review done → advance to done.
 */
function checkPhaseAdvancement(wf: WorkflowRow): void {
  if (wf.template !== 'iteration-review') return;

  const phase = wf.phase;

  // Simplified flow (OPS removed): review → done
  // PM sends any message with this workflow_id after reviewing stats → advance to done
  if (phase !== 'review') return;

  const triggerMessages = rawQuery(
    `SELECT id FROM messages
     WHERE related_workflow_id = ?
       AND from_role = 'PM'
       AND created_at >= ?
     LIMIT 1`,
    [wf.id, wf.updated_at]
  );

  if (triggerMessages.length === 0) return;

  // Advance to done
  update('workflow_instances', { id: wf.id }, { phase: 'done' });
  wf.phase = 'done';

  insert('logs', {
    role: 'system',
    action: 'phase_advanced',
    content: `工作流 #${wf.id} (${wf.template}) 阶段推进: review → done`,
  });

  console.log(`   ➡️  工作流 #${wf.id} (${wf.template}) 阶段: review → done`);
}

/**
 * Send self-reflection trigger messages to all roles that participated in a workflow.
 * Participating roles are determined by who sent/received messages related to the workflow.
 */
function sendReflectionTriggers(wf: WorkflowRow): void {
  // Find all roles that participated in this workflow via messages
  const messages = select<{ from_role: string; to_role: string }>('messages', {
    related_workflow_id: wf.id,
  });

  // Also check tasks assigned to roles
  const tasks = select<{ assigned_to: string | null }>('tasks', { workflow_id: wf.id });

  const participatingRoles = new Set<string>();
  for (const msg of messages) {
    if (msg.from_role !== 'system') participatingRoles.add(msg.from_role);
    if (msg.to_role !== 'system') participatingRoles.add(msg.to_role);
  }
  for (const task of tasks) {
    if (task.assigned_to) participatingRoles.add(task.assigned_to);
  }

  // Always include PM (owns all workflows) and exclude "user"
  participatingRoles.add('PM');
  participatingRoles.delete('user');

  for (const role of participatingRoles) {
    insert('messages', {
      from_role: 'system',
      to_role: role,
      type: 'reflection',
      content: buildReflectionPrompt(role, wf),
      status: MessageStatus.Unread,
      related_workflow_id: wf.id,
    });
  }

  insert('logs', {
    role: 'system',
    action: 'reflection_triggered',
    content: `工作流 #${wf.id} 完成，已向 ${[...participatingRoles].join(',')} 发送反思触发`,
  });
}

/**
 * Build a reflection prompt tailored to each role.
 */
function buildReflectionPrompt(role: string, wf: WorkflowRow): string {
  const base = `【自我反思】工作流 #${wf.id}（${wf.template}）已完成，请进行自我反思。`;

  const roleGuidance: Record<string, string> = {
    PM: '请回顾：需求理解是否准确？技术方案可行性如何？任务拆分粒度是否合理？验收标准是否清晰？沟通效率如何？',
    DEV: '请回顾：代码质量如何？验收测试是否充分？是否有遗漏的测试场景？有无被打回？被打回的根因是什么？',
  };

  const guidance = roleGuidance[role] ?? '请回顾本次工作中的经验教训。';

  return [
    base,
    '',
    guidance,
    '',
    '反思产出：',
    '1. 将经验教训写入 memory 表（必须）',
    '2. 如发现需要用户决策的系统性问题，写入 proposals 表（可选，有则写，无则不写）',
  ].join('\n');
}

/**
 * Build a completion notification message for PM.
 */
function buildCompletionMessage(wf: WorkflowRow): string {
  switch (wf.template) {
    case 'new-feature':
      return `🎉 工作流 #${wf.id}（新功能开发）所有任务已完成。请汇总验收报告，向用户汇报完成情况。`;

    case 'bug-fix':
      return `🐛 工作流 #${wf.id}（Bug 修复）修复任务已完成。请向用户反馈修复结果和验证报告。`;

    case 'iteration-review':
      return `📊 工作流 #${wf.id}（迭代回顾）已完成。请归档本轮迭代并通知用户。`;

    default:
      return `工作流 #${wf.id}（${wf.template}）已完成。`;
  }
}
