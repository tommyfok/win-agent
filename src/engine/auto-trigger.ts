import { select, insert, rawQuery, rawRun, withTransaction } from '../db/repository.js';
import { MessageStatus, TaskStatus } from '../db/types.js';
import { generateIterationStats } from './iteration-stats.js';
import { engineBus, EngineEvents } from './event-bus.js';
import { loadConfig } from '../config/index.js';
import { Role } from './role-manager.js';

interface ProjectConfigRow {
  key: string;
  value: string;
}

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
 * 1. 活跃迭代的所有任务已完成 → 标记完成 + 生成统计报告 → 通知 PM
 * 2. 当前迭代打回率 > 30% → 生成统计报告 → 通知 PM 提前复盘
 */
export function checkAutoTriggers(): void {
  checkScaffoldDone();
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
 * 检查脚手架任务是否已完成（0-to-1 项目）。
 * 脚手架完成后，通知 PM 执行工作空间分析生成 overview.md。
 */
function checkScaffoldDone(): void {
  const key = 'scaffold_done';
  if (firedTriggers.has(key)) return;

  // 仅在 greenfield 模式下检查
  const modeRow = select<ProjectConfigRow>('project_config', { key: 'project_mode' });
  if (modeRow.length === 0 || modeRow[0].value !== 'greenfield') return;

  // 查找已完成的脚手架任务（title 包含 [scaffold]）
  const scaffoldDone = rawQuery<{ id: number }>(
    `SELECT id FROM tasks WHERE title LIKE '%[scaffold]%' AND status = '${TaskStatus.Done}' LIMIT 1`,
    []
  );
  if (scaffoldDone.length === 0) return;

  firedTriggers.add(key);

  withTransaction(() => {
    insert('messages', {
      from_role: Role.SYS,
      to_role: Role.PM,
      type: 'system',
      content: `🏗️ 脚手架任务已完成。请执行以下操作：

1. **生成项目概览**：扫描当前工作空间，分析项目结构和技术栈，生成概览文档并写入 \`.win-agent/docs/overview.md\`。
   - 概览应包含：项目定位、技术栈、核心模块、架构要点
   - 直接以 Markdown 正文输出，以 ## 标题开头

2. **审阅 docs 文件**：检查 DEV 更新的 \`.win-agent/docs/development.md\` 和 \`.win-agent/docs/validation.md\` 是否完整准确。

3. 向用户汇报脚手架搭建完成情况，询问是否可以开始功能需求开发。`,
      status: MessageStatus.Deferred,
    });
    insert('logs', {
      role: Role.SYS,
      action: 'auto_trigger',
      content: '脚手架任务完成，已通知 PM 生成 overview.md',
    });
  });

  console.log('   🏗️ 自动触发: 脚手架完成，通知 PM 生成项目概览');
}

/**
 * 检查活跃迭代中所有任务是否已完成。
 * 若是，则将迭代标记为 completed，生成统计报告，并通知 PM 进行复盘。
 */
function checkAllTasksDone(): void {
  const activeIterations = select<{ id: number }>('iterations', { status: 'active' });

  for (const iter of activeIterations) {
    const key = `all_done:${iter.id}`;
    if (firedTriggers.has(key)) continue;

    // Get all tasks assigned to this iteration
    const tasks = select<{ id: number; status: string }>('tasks', { iteration_id: iter.id });

    if (tasks.length === 0) continue;

    const active = tasks.filter((t) => t.status !== TaskStatus.Cancelled);
    const allDone = active.length > 0 && active.every((t) => t.status === TaskStatus.Done);
    if (!allDone) continue;

    firedTriggers.add(key);

    // 统计报告在事务外生成（只读查询）
    const statsReport = generateIterationStats(iter.id);

    withTransaction(() => {
      rawRun(
        "UPDATE iterations SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
        [iter.id]
      );
      insert('messages', {
        from_role: Role.SYS,
        to_role: Role.PM,
        type: 'system',
        content: `📊 迭代 #${iter.id} 所有任务已完成，引擎已自动生成统计报告。\n\n${statsReport}\n\n请审阅以上统计数据，向用户汇报迭代完成情况，并提出改进建议（如有）。\n审阅完成后，将回顾摘要写入 memory 表，然后通过 database_update 将迭代 #${iter.id} 的 status 更新为 'reviewed'。`,
        status: MessageStatus.Deferred,
        related_iteration_id: iter.id,
      });
      insert('logs', {
        role: Role.SYS,
        action: 'auto_trigger',
        content: `迭代 #${iter.id} 全部任务完成，已生成统计报告并通知 PM`,
      });
    });

    console.log(`   🔄 自动触发: 迭代 #${iter.id} 回顾`);
  }
}

/**
 * 检查活跃迭代的打回率是否超过 30%。
 * 若超过，生成统计报告并通知 PM 提前介入复盘。
 */
function checkRejectionRate(): void {
  const activeIterations = select<{ id: number }>('iterations', { status: 'active' });

  for (const iter of activeIterations) {
    const key = `rejection_rate:${iter.id}`;
    if (firedTriggers.has(key)) continue;

    // 统计当前迭代的任务数与打回数
    const stats = rawQuery<{ total: number; rejected: number }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = '${TaskStatus.Rejected}' THEN 1 ELSE 0 END) as rejected
      FROM tasks WHERE iteration_id = ?`,
      [iter.id]
    )[0];

    const engineCfg = loadConfig().engine ?? {};
    const minTasks = engineCfg.minTasksForRejectionStats ?? 3;
    const rateThreshold = engineCfg.rejectionRateThreshold ?? 0.3;
    if (stats.total < minTasks) continue; // 任务数不足时打回率无统计意义
    const rate = stats.rejected / stats.total;
    if (rate <= rateThreshold) continue;

    firedTriggers.add(key);

    // 统计报告在事务外生成（只读查询）
    const statsReport = generateIterationStats(iter.id);

    withTransaction(() => {
      // 持久化到日志，引擎重启后仍可恢复，避免对同一活跃迭代重复触发
      insert('logs', { role: Role.SYS, action: 'trigger_fired', content: key });
      insert('messages', {
        from_role: Role.SYS,
        to_role: Role.PM,
        type: 'system',
        content: `⚠️ 迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% 超过阈值 ${Math.round(rateThreshold * 100)}%，需要关注。\n\n${statsReport}\n\n请分析打回原因，向用户汇报情况，并决定是否需要调整后续任务的策略。`,
        status: MessageStatus.Deferred,
        related_iteration_id: iter.id,
      });
      insert('logs', {
        role: Role.SYS,
        action: 'auto_trigger',
        content: `迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}% 超阈值，已通知 PM`,
      });
    });

    console.log(`   ⚠️ 自动触发: 迭代 #${iter.id} 打回率 ${Math.round(rate * 100)}%`);
  }
}

// Subscribe to dispatch events — auto-triggers are evaluated after every successful dispatch.
engineBus.on(EngineEvents.DISPATCH_COMPLETE, () => checkAutoTriggers());
