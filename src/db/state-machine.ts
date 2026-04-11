import { update, insert } from './repository.js';
import type { TaskStatus } from './types.js';

/**
 * 合法的任务状态流转图
 *
 * 所有 "活跃" 状态均可被阻塞（blocked），阻塞后可恢复到任意活跃状态。
 * done / cancelled / paused 为终态或特殊态，不参与常规流转。
 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending_pm:     ['in_review', 'blocked', 'cancelled'],
  pending_dev:    ['in_dev', 'blocked', 'cancelled'],
  in_dev:         ['pending_review', 'rejected', 'blocked', 'cancelled'],
  pending_review: ['in_review', 'rejected', 'blocked', 'cancelled'],
  blocked:        ['pending_pm', 'pending_dev', 'in_dev', 'pending_review'],
  in_review:      ['done', 'rejected'],
  rejected:       ['pending_dev', 'cancelled'],
  done:           [],
  cancelled:      [],
  paused:         [],
};

/**
 * Validate and execute a task status transition.
 *
 * - Validates the transition against TASK_TRANSITIONS; throws on illegal transition.
 * - Updates tasks.status and tasks.pre_suspend_status atomically with a task_events record.
 * - Sets pre_suspend_status = from when transitioning TO blocked (for later restore).
 * - Clears pre_suspend_status = null when transitioning FROM blocked (or any other transition).
 *
 * NOTE: this function does NOT wrap writes in a transaction — the caller is responsible
 * for wrapping in withTransaction() if atomicity across multiple operations is needed.
 */
export function transitionTaskStatus(
  taskId: number,
  from: TaskStatus,
  to: TaskStatus,
  changedBy: string,
  reason: string
): void {
  const allowed = TASK_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new Error(`非法任务状态转换: ${from} → ${to} (task #${taskId})`);
  }
  update('tasks', { id: taskId }, {
    status: to,
    pre_suspend_status: to === 'blocked' ? from : null,
  });
  insert('task_events', {
    task_id: taskId,
    from_status: from,
    to_status: to,
    changed_by: changedBy,
    reason,
  });
}
