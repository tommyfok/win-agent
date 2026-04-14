import { update, insert } from './repository.js';
import { TaskStatus } from './types.js';
import type { Role } from '../engine/role-manager.js';

/**
 * 合法的任务状态流转图
 *
 * 所有 "活跃" 状态均可被阻塞（blocked），阻塞后可恢复到任意活跃状态。
 * done / cancelled / paused 为终态或特殊态，不参与常规流转。
 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.PendingPm]: [TaskStatus.InReview, TaskStatus.Blocked, TaskStatus.Cancelled],
  [TaskStatus.PendingDev]: [TaskStatus.InDev, TaskStatus.Blocked, TaskStatus.Cancelled],
  [TaskStatus.InDev]: [
    TaskStatus.PendingReview,
    TaskStatus.Rejected,
    TaskStatus.Blocked,
    TaskStatus.Cancelled,
  ],
  [TaskStatus.PendingReview]: [
    TaskStatus.InReview,
    TaskStatus.Rejected,
    TaskStatus.Blocked,
    TaskStatus.Cancelled,
  ],
  [TaskStatus.Blocked]: [
    TaskStatus.PendingPm,
    TaskStatus.PendingDev,
    TaskStatus.InDev,
    TaskStatus.PendingReview,
  ],
  [TaskStatus.InReview]: [TaskStatus.Done, TaskStatus.Rejected],
  [TaskStatus.Rejected]: [TaskStatus.PendingDev, TaskStatus.Cancelled],
  [TaskStatus.Done]: [],
  [TaskStatus.Cancelled]: [],
  [TaskStatus.Paused]: [],
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
  changedBy: Role,
  reason: string
): void {
  const allowed = TASK_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new Error(`非法任务状态转换: ${from} → ${to} (task #${taskId})`);
  }
  update('tasks', { id: taskId }, {
    status: to,
    pre_suspend_status: to === TaskStatus.Blocked ? from : null,
  });
  insert('task_events', {
    task_id: taskId,
    from_status: from,
    to_status: to,
    changed_by: changedBy,
    reason,
  });
}
