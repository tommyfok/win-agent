import { select, update, insert, rawQuery } from "../db/repository.js";
import { MessageStatus } from "../db/types.js";

export function checkAndBlockUnmetDependencies(taskId: number, currentStatus: string): boolean {
  // Already blocked — don't overwrite pre_suspend_status (would create infinite loop)
  if (currentStatus === "blocked") return true;

  const unmetDeps = rawQuery<{ id: number; title: string }>(
    `SELECT t.id, t.title FROM task_dependencies td
     JOIN tasks t ON t.id = td.depends_on
     WHERE td.task_id = ? AND t.status != 'done'`,
    [taskId]
  );
  if (unmetDeps.length > 0) {
    update("tasks", { id: taskId }, { status: "blocked", pre_suspend_status: currentStatus });
    insert("task_events", {
      task_id: taskId,
      from_status: currentStatus,
      to_status: "blocked",
      changed_by: "system",
      reason: `依赖未完成: ${unmetDeps.map((d) => `#${d.id} ${d.title}`).join(", ")}`,
    });
    return true;
  }
  return false;
}

export function checkAndUnblockDependencies(): void {
  const blockedTasks = select<{
    id: number;
    title: string;
    pre_suspend_status: string | null;
    assigned_to: string | null;
  }>("tasks", { status: "blocked" });
  for (const task of blockedTasks) {
    const unmet = rawQuery(
      `SELECT 1 FROM task_dependencies td
       JOIN tasks t ON t.id = td.depends_on
       WHERE td.task_id = ? AND t.status != 'done' LIMIT 1`,
      [task.id]
    );
    if (unmet.length === 0) {
      const restoreStatus = task.pre_suspend_status || "pending_dev";

      update("tasks", { id: task.id }, { status: restoreStatus, pre_suspend_status: null });
      insert("task_events", {
        task_id: task.id,
        from_status: "blocked",
        to_status: restoreStatus,
        changed_by: "system",
        reason: "依赖已全部完成，自动解除阻塞",
      });
      insert("messages", {
        from_role: "system",
        to_role: "PM",
        type: "notification",
        content: `任务 #${task.id}「${task.title}」依赖已满足，已自动从 blocked 恢复为 ${restoreStatus}`,
        related_task_id: task.id,
        status: MessageStatus.Unread,
      });
      // Also notify the assigned role directly so DEV/QA can resume without waiting for PM.
      // Dedup: skip if there's already an unread system notification for this task+role.
      const assignedRole = task.assigned_to;
      if (assignedRole && assignedRole !== "PM") {
        const existing = select<{ id: number }>("messages", {
          from_role: "system",
          to_role: assignedRole,
          related_task_id: task.id,
          status: MessageStatus.Unread,
        });
        if (existing.length === 0) {
          insert("messages", {
            from_role: "system",
            to_role: assignedRole,
            type: "notification",
            content: `任务 #${task.id}「${task.title}」的依赖已全部完成，可以继续开发了。`,
            related_task_id: task.id,
            status: MessageStatus.Unread,
          });
        }
      }
    }
  }
}
