import { select, insert, rawQuery, rawRun } from "../db/repository.js";
import { formatTokens } from "../utils/format.js";

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
 * 1. All tasks in an active iteration are done → mark completed + generate stats → PM
 * 2. Rejection rate > 30% in current iteration → generate stats → PM for early review
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
 * When tasks exist with iteration=0 (typically just created by PM), find or create
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
 * If so, mark iteration as completed, generate stats report, and notify PM.
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

    // Generate stats report (engine auto-generates, zero LLM cost)
    const statsReport = generateIterationStats(iter.id);

    // Create iteration-review workflow (simplified: stats → PM review → done)
    const { lastInsertRowid: workflowId } = insert("workflow_instances", {
      template: "iteration-review",
      phase: "review",
      status: "active",
      context: JSON.stringify({ iteration_id: iter.id }),
    });

    // Notify PM with engine-generated stats
    insert("messages", {
      from_role: "system",
      to_role: "PM",
      type: "system",
      content: [
        `📊 迭代 #${iter.id} 所有任务已完成，引擎已自动生成统计报告。`,
        "",
        statsReport,
        "",
        "请审阅以上统计数据，向用户汇报迭代完成情况，并提出改进建议（如有）。",
        `审阅完成后，将回顾摘要写入 memory 表，然后发消息告知引擎回顾完成（携带 related_workflow_id: ${workflowId}）。`,
      ].join("\n"),
      status: "unread",
      related_workflow_id: workflowId,
    });

    insert("logs", {
      role: "system",
      action: "auto_trigger",
      content: `迭代 #${iter.id} 全部任务完成，已生成统计报告并通知 PM (workflow #${workflowId})`,
    });

    console.log(
      `   🔄 自动触发: 迭代 #${iter.id} 回顾 (workflow #${workflowId})`,
    );
  }
}

/**
 * Check if the rejection rate in any active iteration exceeds 30%.
 * If so, generate stats and notify PM for early review.
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

    const statsReport = generateIterationStats(iter.id);

    const { lastInsertRowid: workflowId } = insert("workflow_instances", {
      template: "iteration-review",
      phase: "review",
      status: "active",
      context: JSON.stringify({
        iteration_id: iter.id,
        trigger: "rejection_rate",
        rate: Math.round(rate * 100),
      }),
    });

    insert("messages", {
      from_role: "system",
      to_role: "PM",
      type: "system",
      content: [
        `⚠️ 迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% 超过阈值 30%，需要关注。`,
        "",
        statsReport,
        "",
        "请分析打回原因，向用户汇报情况，并决定是否需要调整后续任务的策略。",
        `完成后发消息告知引擎回顾完成（携带 related_workflow_id: ${workflowId}）。`,
      ].join("\n"),
      status: "unread",
      related_workflow_id: workflowId,
    });

    insert("logs", {
      role: "system",
      action: "auto_trigger",
      content: `迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% 超阈值，已通知 PM (workflow #${workflowId})`,
    });

    console.log(
      `   ⚠️ 自动触发: 迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% (workflow #${workflowId})`,
    );
  }
}

/**
 * Generate iteration statistics report using SQL aggregation.
 * Replaces OPS role's metrics collection — zero LLM cost.
 */
function generateIterationStats(iterationId: number): string {
  const lines: string[] = [`## 迭代 #${iterationId} 统计报告`];

  // Task summary
  const taskStats = rawQuery(
    `SELECT status, COUNT(*) as cnt FROM tasks WHERE iteration = ? GROUP BY status ORDER BY status`,
    [iterationId],
  );
  const totalTasks = taskStats.reduce((s: number, r: any) => s + r.cnt, 0);
  lines.push(`\n### 任务概况 (共 ${totalTasks} 个)`);
  for (const row of taskStats) {
    lines.push(`- ${row.status}: ${row.cnt}`);
  }

  // Rejection stats from task_events (more accurate than current status)
  const rejections = rawQuery(
    `SELECT COUNT(*) as cnt FROM task_events te
     JOIN tasks t ON te.task_id = t.id
     WHERE t.iteration = ? AND te.to_status = 'rejected'`,
    [iterationId],
  );
  const rejectionCount = rejections[0]?.cnt ?? 0;
  const rejectionRate = totalTasks > 0 ? Math.round((rejectionCount / totalTasks) * 100) : 0;
  lines.push(`\n### 质量指标`);
  lines.push(`- 累计打回次数: ${rejectionCount}`);
  lines.push(`- 打回率: ${rejectionRate}%`);

  // Blocked stats
  const blockedEvents = rawQuery(
    `SELECT COUNT(DISTINCT te.task_id) as cnt FROM task_events te
     JOIN tasks t ON te.task_id = t.id
     WHERE t.iteration = ? AND te.to_status = 'blocked'`,
    [iterationId],
  );
  lines.push(`- 曾被阻塞的任务数: ${blockedEvents[0]?.cnt ?? 0}`);

  // Token consumption
  const tokenStats = rawQuery(
    `SELECT role,
            COUNT(*) as dispatches,
            SUM(input_tokens) as input_total,
            SUM(output_tokens) as output_total,
            SUM(input_tokens + output_tokens) as total
     FROM role_outputs
     WHERE related_workflow_id IN (
       SELECT id FROM workflow_instances
       WHERE context LIKE '%"iteration_id":${iterationId}%'
          OR id IN (SELECT DISTINCT workflow_id FROM tasks WHERE iteration = ?)
     )
     GROUP BY role ORDER BY total DESC`,
    [iterationId],
  );
  if (tokenStats.length > 0) {
    lines.push(`\n### Token 消耗`);
    let grandTotal = 0;
    for (const row of tokenStats) {
      const total = row.total ?? 0;
      grandTotal += total;
      lines.push(`- ${row.role}: ${formatTokens(total)} tokens (${row.dispatches} 次调度)`);
    }
    lines.push(`- 合计: ${formatTokens(grandTotal)} tokens`);
  }

  // Top rejected tasks (most rejected)
  const topRejected = rawQuery(
    `SELECT t.id, t.title, COUNT(*) as reject_count
     FROM task_events te
     JOIN tasks t ON te.task_id = t.id
     WHERE t.iteration = ? AND te.to_status = 'rejected'
     GROUP BY te.task_id
     ORDER BY reject_count DESC LIMIT 5`,
    [iterationId],
  );
  if (topRejected.length > 0) {
    lines.push(`\n### 打回次数最多的任务`);
    for (const row of topRejected) {
      lines.push(`- task#${row.id}「${row.title}」: 打回 ${row.reject_count} 次`);
    }
  }

  return lines.join("\n");
}

// formatTokens imported from ../utils/format.js
