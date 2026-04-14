import { select, insert, rawQuery, withTransaction } from '../db/repository.js';
import { MessageStatus, TaskStatus } from '../db/types.js';
import { transitionTaskStatus } from '../db/state-machine.js';
import { Role } from './role-manager.js';

export function checkAndBlockUnmetDependencies(taskId: number, currentStatus: TaskStatus): boolean {
  // Already blocked — don't overwrite pre_suspend_status (would create infinite loop)
  if (currentStatus === TaskStatus.Blocked) return true;

  const unmetDeps = rawQuery<{ id: number; title: string }>(
    `WITH RECURSIVE transitive_deps AS (
       SELECT depends_on FROM task_dependencies WHERE task_id = ?
       UNION ALL
       SELECT td.depends_on
       FROM task_dependencies td
       JOIN transitive_deps rec ON rec.depends_on = td.task_id
     )
     SELECT t.id, t.title FROM tasks t
     WHERE t.id IN (SELECT depends_on FROM transitive_deps)
       AND t.status != '${TaskStatus.Done}'`,
    [taskId]
  );
  if (unmetDeps.length > 0) {
    withTransaction(() => {
      transitionTaskStatus(
        taskId,
        currentStatus as TaskStatus,
        TaskStatus.Blocked,
        Role.SYS,
        `依赖未完成: ${unmetDeps.map((d) => `#${d.id} ${d.title}`).join(', ')}`
      );
    });
    return true;
  }
  return false;
}

export function checkAndUnblockDependencies(): void {
  const blockedTasks = select<{
    id: number;
    title: string;
    pre_suspend_status: TaskStatus | null;
    assigned_to: string | null;
  }>('tasks', { status: TaskStatus.Blocked });
  for (const task of blockedTasks) {
    const unmet = rawQuery(
      `WITH RECURSIVE transitive_deps AS (
         SELECT depends_on FROM task_dependencies WHERE task_id = ?
         UNION ALL
         SELECT td.depends_on
         FROM task_dependencies td
         JOIN transitive_deps rec ON rec.depends_on = td.task_id
       )
       SELECT 1 FROM tasks t
       WHERE t.id IN (SELECT depends_on FROM transitive_deps)
         AND t.status != '${TaskStatus.Done}'
       LIMIT 1`,
      [task.id]
    );
    if (unmet.length === 0) {
      const restoreStatus = task.pre_suspend_status || TaskStatus.PendingDev;
      // Dedup check outside transaction (read-only)
      // Check for ANY existing notification (any status), not just Unread
      // because DEV may have already read the message after processing
      const assignedRole = task.assigned_to;
      const existingNotify =
        assignedRole && assignedRole !== Role.PM
          ? select<{ id: number }>('messages', {
              from_role: Role.SYS,
              to_role: assignedRole,
              related_task_id: task.id,
            })
          : [];

      withTransaction(() => {
        transitionTaskStatus(
          task.id,
          TaskStatus.Blocked,
          restoreStatus as TaskStatus,
          Role.SYS,
          '依赖已全部完成，自动解除阻塞'
        );
        insert('messages', {
          from_role: Role.SYS,
          to_role: Role.PM,
          type: 'notification',
          content: `任务 #${task.id}「${task.title}」依赖已满足，已自动从 blocked 恢复为 ${restoreStatus}`,
          related_task_id: task.id,
          status: MessageStatus.Unread,
        });
        // Also notify the assigned role directly so DEV can resume without waiting for PM.
        if (assignedRole && assignedRole !== Role.PM && existingNotify.length === 0) {
          insert('messages', {
            from_role: Role.SYS,
            to_role: assignedRole,
            type: 'notification',
            content: `任务 #${task.id}「${task.title}」的依赖已全部完成，可以继续开发了。`,
            related_task_id: task.id,
            status: MessageStatus.Unread,
          });
        }
      });
    }
  }
}
