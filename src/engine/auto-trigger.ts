import { select, insert, rawQuery, rawRun } from "../db/repository.js";
import { MessageStatus } from "../db/types.js";
import { formatTokens } from "../utils/format.js";

/**
 * 记录本次引擎生命周期内已触发过的自动触发条件，防止重复触发。
 *
 * Key 格式："{type}:{id}"，例如 "all_done:3"、"rejection_rate:2"
 */
const firedTriggers: Set<string> = new Set();

/**
 * 检查自动触发条件，按需生成系统消息。
 *
 * 检查顺序：
 * 0. 存在未分配迭代的任务 → 自动创建/分配迭代
 * 1. 活跃迭代的所有任务已完成 → 标记完成 + 生成统计报告 → 通知 PM
 * 2. 当前迭代打回率 > 30% → 生成统计报告 → 通知 PM 提前复盘
 */
export function checkAutoTriggers(): void {
  checkIterationAutoCreate();
  checkAllTasksDone();
  checkRejectionRate();
}

/**
 * 重置触发状态，并从日志中恢复已持久化的 rejection_rate 触发记录。
 * 在引擎重启时调用，防止对仍处于 active 状态的迭代重复通知 PM。
 */
export function resetTriggers(): void {
  firedTriggers.clear();
  // 恢复已触发的 rejection_rate 记录，避免引擎重启后对同一迭代再次通知
  const rows = rawQuery<{ content: string }>(
    "SELECT content FROM logs WHERE action = 'trigger_fired' AND content LIKE 'rejection_rate:%'",
    []
  );
  for (const row of rows) {
    firedTriggers.add(row.content);
  }
}

/**
 * 对尚未分配迭代的任务（iteration=0）自动创建迭代并完成分配。
 * 通常发生在 PM 刚创建任务后，引擎自动将其纳入当前活跃迭代。
 */
function checkIterationAutoCreate(): void {
  // 只处理没有关联工作流的纯迭代任务；
  // 由 new-feature/bug-fix 工作流创建的任务有 workflow_id，不应被自动合并进当前迭代。
  const unassigned = rawQuery<{ id: number }>(
    "SELECT id FROM tasks WHERE iteration = 0 AND status != 'cancelled' AND workflow_id IS NULL",
    []
  );

  if (unassigned.length === 0) return;

  // Find or create active iteration
  const activeIterations = select<{ id: number }>("iterations", { status: "active" });
  let iterationId: number;

  if (activeIterations.length > 0) {
    iterationId = activeIterations[0].id;
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
    rawRun("UPDATE tasks SET iteration = ? WHERE id = ?", [iterationId, task.id]);
  }

  insert("logs", {
    role: "system",
    action: "iteration_assign",
    content: `已将 ${unassigned.length} 个任务分配到迭代 #${iterationId}`,
  });

  console.log(`   📋 已将 ${unassigned.length} 个任务分配到迭代 #${iterationId}`);
}

/**
 * 检查活跃迭代中所有任务是否已完成。
 * 若是，则将迭代标记为 completed，生成统计报告，并通知 PM 进行复盘。
 */
function checkAllTasksDone(): void {
  const activeIterations = select<{ id: number }>("iterations", { status: "active" });

  for (const iter of activeIterations) {
    const key = `all_done:${iter.id}`;
    if (firedTriggers.has(key)) continue;

    // Get all tasks assigned to this iteration
    const tasks = select<{ id: number; status: string }>("tasks", { iteration: iter.id });

    if (tasks.length === 0) continue;

    const active = tasks.filter((t) => t.status !== "cancelled");
    const allDone = active.length > 0 && active.every((t) => t.status === "done");
    if (!allDone) continue;

    firedTriggers.add(key);

    // Mark iteration as completed
    rawRun(
      "UPDATE iterations SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [iter.id]
    );

    // 引擎直接生成统计报告，无需调用 LLM
    const statsReport = generateIterationStats(iter.id);

    // 创建 iteration-review 工作流（stats → PM 复盘 → 完成）
    const { lastInsertRowid: workflowId } = insert("workflow_instances", {
      template: "iteration-review",
      phase: "review",
      status: "active",
      context: JSON.stringify({ iteration_id: iter.id }),
    });

    // 将引擎生成的统计报告通知 PM
    insert("messages", {
      from_role: "system",
      to_role: "PM",
      type: "system",
      content: `📊 迭代 #${iter.id} 所有任务已完成，引擎已自动生成统计报告。\n\n${statsReport}\n\n请审阅以上统计数据，向用户汇报迭代完成情况，并提出改进建议（如有）。\n审阅完成后，将回顾摘要写入 memory 表，然后发消息告知引擎回顾完成（携带 related_workflow_id: ${workflowId}）。`,
      status: MessageStatus.Deferred,
      related_workflow_id: workflowId,
    });

    insert("logs", {
      role: "system",
      action: "auto_trigger",
      content: `迭代 #${iter.id} 全部任务完成，已生成统计报告并通知 PM (workflow #${workflowId})`,
    });

    console.log(`   🔄 自动触发: 迭代 #${iter.id} 回顾 (workflow #${workflowId})`);
  }
}

/**
 * 检查活跃迭代的打回率是否超过 30%。
 * 若超过，生成统计报告并通知 PM 提前介入复盘。
 */
function checkRejectionRate(): void {
  const activeIterations = select<{ id: number }>("iterations", { status: "active" });

  for (const iter of activeIterations) {
    const key = `rejection_rate:${iter.id}`;
    if (firedTriggers.has(key)) continue;

    // 统计当前迭代的任务数与打回数
    const stats = rawQuery<{ total: number; rejected: number }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
      FROM tasks WHERE iteration = ?`,
      [iter.id]
    )[0];

    if (stats.total < 3) continue; // 任务数不足时打回率无统计意义
    const rate = stats.rejected / stats.total;
    if (rate <= 0.3) continue;

    firedTriggers.add(key);
    // 持久化到日志，引擎重启后仍可恢复，避免对同一活跃迭代重复触发
    insert("logs", { role: "system", action: "trigger_fired", content: key });

    // 若该迭代已存在活跃的 iteration-review 工作流，则跳过
    const existingReview = select<{ context?: string }>("workflow_instances", {
      template: "iteration-review",
      status: "active",
    }).filter((w) => {
      try {
        return JSON.parse(w.context ?? "null")?.iteration_id === iter.id;
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
      content: `⚠️ 迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% 超过阈值 30%，需要关注。\n\n${statsReport}\n\n请分析打回原因，向用户汇报情况，并决定是否需要调整后续任务的策略。\n完成后发消息告知引擎回顾完成（携带 related_workflow_id: ${workflowId}）。`,
      status: MessageStatus.Deferred,
      related_workflow_id: workflowId,
    });

    insert("logs", {
      role: "system",
      action: "auto_trigger",
      content: `迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% 超阈值，已通知 PM (workflow #${workflowId})`,
    });

    console.log(
      `   ⚠️ 自动触发: 迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% (workflow #${workflowId})`
    );
  }
}

/**
 * 通过 SQL 聚合生成迭代统计报告。
 * 由引擎直接计算，替代 OPS 角色的指标收集，零 LLM 成本。
 */
function generateIterationStats(iterationId: number): string {
  const lines: string[] = [`## 迭代 #${iterationId} 统计报告`];

  // 任务概况
  const taskStats = rawQuery<{ status: string; cnt: number }>(
    `SELECT status, COUNT(*) as cnt FROM tasks WHERE iteration = ? GROUP BY status ORDER BY status`,
    [iterationId]
  );
  const totalTasks = taskStats.reduce((s, r) => s + r.cnt, 0);
  lines.push(`\n### 任务概况 (共 ${totalTasks} 个)`);
  for (const row of taskStats) {
    lines.push(`- ${row.status}: ${row.cnt}`);
  }

  // 从 task_events 统计打回次数（比直接看当前状态更准确）
  const rejections = rawQuery<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM task_events te
     JOIN tasks t ON te.task_id = t.id
     WHERE t.iteration = ? AND te.to_status = 'rejected'`,
    [iterationId]
  );
  const rejectionCount = rejections[0]?.cnt ?? 0;
  const rejectionRate = totalTasks > 0 ? Math.round((rejectionCount / totalTasks) * 100) : 0;
  lines.push(`\n### 质量指标`);
  lines.push(`- 累计打回次数: ${rejectionCount}`);
  lines.push(`- 打回率: ${rejectionRate}%`);

  // 阻塞统计
  const blockedEvents = rawQuery<{ cnt: number }>(
    `SELECT COUNT(DISTINCT te.task_id) as cnt FROM task_events te
     JOIN tasks t ON te.task_id = t.id
     WHERE t.iteration = ? AND te.to_status = 'blocked'`,
    [iterationId]
  );
  lines.push(`- 曾被阻塞的任务数: ${blockedEvents[0]?.cnt ?? 0}`);

  // Token 消耗统计
  const tokenStats = rawQuery<{
    role: string;
    dispatches: number;
    input_total: number;
    output_total: number;
    total: number;
  }>(
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
    [iterationId]
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

  // 打回次数最多的任务
  const topRejected = rawQuery<{ id: number; title: string; reject_count: number }>(
    `SELECT t.id, t.title, COUNT(*) as reject_count
     FROM task_events te
     JOIN tasks t ON te.task_id = t.id
     WHERE t.iteration = ? AND te.to_status = 'rejected'
     GROUP BY te.task_id
     ORDER BY reject_count DESC LIMIT 5`,
    [iterationId]
  );
  if (topRejected.length > 0) {
    lines.push(`\n### 打回次数最多的任务`);
    for (const row of topRejected) {
      lines.push(`- task#${row.id}「${row.title}」: 打回 ${row.reject_count} 次`);
    }
  }

  return lines.join("\n");
}
