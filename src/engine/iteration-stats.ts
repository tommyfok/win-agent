import { rawQuery } from '../db/repository.js';
import { formatTokens } from '../utils/format.js';

/**
 * Generate an iteration statistics report via SQL aggregation.
 * Zero LLM cost — computed directly by the engine.
 */
export function generateIterationStats(iterationId: number): string {
  const lines: string[] = [`## 迭代 #${iterationId} 统计报告`];

  // Task overview
  const taskStats = rawQuery<{ status: string; cnt: number }>(
    `SELECT status, COUNT(*) as cnt FROM tasks WHERE iteration_id = ? GROUP BY status ORDER BY status`,
    [iterationId]
  );
  const totalTasks = taskStats.reduce((s, r) => s + r.cnt, 0);
  lines.push(`\n### 任务概况 (共 ${totalTasks} 个)`);
  for (const row of taskStats) {
    lines.push(`- ${row.status}: ${row.cnt}`);
  }

  // Rejection count from task_events (more accurate than current status)
  const rejections = rawQuery<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM task_events te
     JOIN tasks t ON te.task_id = t.id
     WHERE t.iteration_id = ? AND te.to_status = 'rejected'`,
    [iterationId]
  );
  const rejectionCount = rejections[0]?.cnt ?? 0;
  const rejectionRate = totalTasks > 0 ? Math.round((rejectionCount / totalTasks) * 100) : 0;
  lines.push(`\n### 质量指标`);
  lines.push(`- 累计打回次数: ${rejectionCount}`);
  lines.push(`- 打回率: ${rejectionRate}%`);

  // Blocked task count
  const blockedEvents = rawQuery<{ cnt: number }>(
    `SELECT COUNT(DISTINCT te.task_id) as cnt FROM task_events te
     JOIN tasks t ON te.task_id = t.id
     WHERE t.iteration_id = ? AND te.to_status = 'blocked'`,
    [iterationId]
  );
  lines.push(`- 曾被阻塞的任务数: ${blockedEvents[0]?.cnt ?? 0}`);

  // Token consumption by role
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
     WHERE related_iteration_id = ?
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

  // Top rejected tasks
  const topRejected = rawQuery<{ id: number; title: string; reject_count: number }>(
    `SELECT t.id, t.title, COUNT(*) as reject_count
     FROM task_events te
     JOIN tasks t ON te.task_id = t.id
     WHERE t.iteration_id = ? AND te.to_status = 'rejected'
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

  return lines.join('\n');
}
