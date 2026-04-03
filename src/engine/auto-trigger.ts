import { select, insert, rawQuery, rawRun } from "../db/repository.js";

/**
 * Track which auto-trigger conditions have already fired
 * to prevent duplicate triggers within the same engine lifecycle.
 *
 * Key format: "{type}:{id}" e.g. "all_done:3", "rejection_rate:2"
 */
const firedTriggers: Set<string> = new Set();

/**
 * Check auto-trigger conditions and generate system messages if needed.
 *
 * Conditions checked:
 * 0. Tasks with no iteration assigned → auto-create/assign iteration
 * 1. All tasks in an active iteration are done → mark completed + trigger OPS
 * 2. Rejection rate > 30% in current iteration → trigger OPS for early review
 */
export function checkAutoTriggers(): void {
  checkIterationAutoCreate();
  checkAllTasksDone();
  checkRejectionRate();
}

/**
 * Reset trigger state (called on engine restart).
 */
export function resetTriggers(): void {
  firedTriggers.clear();
}

/**
 * Auto-create an iteration and assign tasks that have no iteration (iteration=0).
 * When tasks exist with iteration=0 (typically just created by SA), find or create
 * an active iteration and assign them.
 */
function checkIterationAutoCreate(): void {
  // Find tasks with no iteration assigned
  const unassigned = rawQuery(
    "SELECT id FROM tasks WHERE iteration = 0 AND status != 'cancelled'",
    [],
  ) as Array<{ id: number }>;

  if (unassigned.length === 0) return;

  // Find or create active iteration
  const activeIterations = select("iterations", { status: "active" });
  let iterationId: number;

  if (activeIterations.length > 0) {
    iterationId = (activeIterations[0] as any).id;
  } else {
    const { lastInsertRowid } = insert("iterations", { status: "active" });
    iterationId = Number(lastInsertRowid);

    insert("logs", {
      role: "system",
      action: "iteration_created",
      content: `自动创建迭代 #${iterationId}`,
    });

    console.log(`   📋 自动创建迭代 #${iterationId}`);
  }

  // Assign unassigned tasks to the iteration
  for (const task of unassigned) {
    rawRun("UPDATE tasks SET iteration = ? WHERE id = ?", [
      iterationId,
      task.id,
    ]);
  }

  insert("logs", {
    role: "system",
    action: "iteration_assign",
    content: `已将 ${unassigned.length} 个任务分配到迭代 #${iterationId}`,
  });

  console.log(
    `   📋 已将 ${unassigned.length} 个任务分配到迭代 #${iterationId}`,
  );
}

/**
 * Check if all tasks in an active iteration are done.
 * If so, mark iteration as completed, create an iteration-review workflow and notify OPS.
 */
function checkAllTasksDone(): void {
  const activeIterations = select("iterations", { status: "active" });

  for (const iter of activeIterations) {
    const key = `all_done:${iter.id}`;
    if (firedTriggers.has(key)) continue;

    // Get all tasks assigned to this iteration
    const tasks = select("tasks", { iteration: iter.id }) as Array<{
      id: number;
      status: string;
    }>;

    if (tasks.length === 0) continue;

    const allDone = tasks.every((t) => t.status === "done");
    if (!allDone) continue;

    firedTriggers.add(key);

    // Mark iteration as completed
    rawRun(
      "UPDATE iterations SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [iter.id],
    );

    // Create iteration-review workflow
    const { lastInsertRowid: workflowId } = insert("workflow_instances", {
      template: "iteration-review",
      phase: "metrics",
      status: "active",
      context: JSON.stringify({ iteration_id: iter.id }),
    });

    // Notify OPS to start review
    insert("messages", {
      from_role: "system",
      to_role: "OPS",
      type: "system",
      content: `迭代 #${iter.id} 的所有任务已完成，请开始迭代回顾。统计本轮打回率、阻塞率等指标，分析问题并起草优化方案。工作流 #${workflowId}，当前阶段：metrics。`,
      status: "unread",
      related_workflow_id: workflowId,
    });

    // Log
    insert("logs", {
      role: "system",
      action: "auto_trigger",
      content: `迭代 #${iter.id} 全部任务完成（已标记 completed），自动触发 iteration-review workflow #${workflowId}`,
    });

    console.log(
      `   🔄 自动触发: 迭代 #${iter.id} 回顾 (workflow #${workflowId})`,
    );
  }
}

/**
 * Check if the rejection rate in any active iteration exceeds 30%.
 * If so, trigger an early OPS review.
 */
function checkRejectionRate(): void {
  const activeIterations = select("iterations", { status: "active" });

  for (const iter of activeIterations) {
    const key = `rejection_rate:${iter.id}`;
    if (firedTriggers.has(key)) continue;

    // Count tasks and rejections in this iteration
    const stats = rawQuery(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
      FROM tasks WHERE iteration = ?`,
      [iter.id],
    )[0] as { total: number; rejected: number };

    if (stats.total < 3) continue; // Need minimum tasks for meaningful rate
    const rate = stats.rejected / stats.total;
    if (rate <= 0.3) continue;

    firedTriggers.add(key);

    // Check if there's already an active iteration-review for this iteration
    const existingReview = select("workflow_instances", {
      template: "iteration-review",
      status: "active",
    }).filter((w: any) => {
      try {
        return JSON.parse(w.context)?.iteration_id === iter.id;
      } catch {
        return false;
      }
    });

    if (existingReview.length > 0) continue;

    // Create iteration-review workflow
    const { lastInsertRowid: workflowId } = insert("workflow_instances", {
      template: "iteration-review",
      phase: "metrics",
      status: "active",
      context: JSON.stringify({
        iteration_id: iter.id,
        trigger: "rejection_rate",
        rate: Math.round(rate * 100),
      }),
    });

    insert("messages", {
      from_role: "system",
      to_role: "OPS",
      type: "system",
      content: `⚠️ 迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% 超过阈值 30%，请立即进行分析和优化。`,
      status: "unread",
      related_workflow_id: workflowId,
    });

    insert("logs", {
      role: "system",
      action: "auto_trigger",
      content: `迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% 超阈值，自动触发 iteration-review workflow #${workflowId}`,
    });

    console.log(
      `   ⚠️ 自动触发: 迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% (workflow #${workflowId})`,
    );
  }
}
