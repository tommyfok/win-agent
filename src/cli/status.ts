import { checkEngineRunning, getDbPath } from '../config/index.js';
import { openDb, getDb } from '../db/connection.js';
import { select as dbSelect, rawQuery } from '../db/repository.js';
import { formatTokens } from '../utils/format.js';
import type { Role } from '../engine/role-manager.js';
import { TaskStatus } from '../db/types.js';

export async function statusCommand() {
  // 1. Check engine status
  const { running, pid } = checkEngineRunning();
  if (!running) {
    console.log('⚠️  win-agent 未运行');
    console.log('   请先执行: npx win-agent start');
    process.exit(1);
  }

  const workspace = process.cwd();

  // Open DB (the engine process has it open, but status runs as a separate process)
  const dbPath = getDbPath(workspace);
  try {
    getDb();
  } catch {
    openDb(dbPath);
  }

  // Engine info
  console.log(`\n🔄 win-agent 运行中 (PID: ${pid})`);
  console.log(`   工作空间: ${workspace}`);

  // 2. Active iterations
  const iterations = dbSelect<{
    id: number;
    name: string | null;
    status: string;
    created_at: string;
  }>('iterations', { status: 'active' }, { orderBy: 'created_at DESC' });
  console.log('\n📋 迭代:');
  if (iterations.length === 0) {
    console.log('   无活跃迭代');
  } else {
    for (const iter of iterations) {
      const elapsed = formatElapsed(iter.created_at);
      const name = iter.name ? ` ${iter.name}` : '';
      console.log(`   #${iter.id}${name} | 状态: ${iter.status} | 已进行: ${elapsed}`);
    }
  }

  // 3. Task statistics
  const taskStats = rawQuery<{ status: string; cnt: number }>(`
    SELECT status, COUNT(*) as cnt
    FROM tasks
    GROUP BY status
    ORDER BY status
  `);
  const statsMap: Record<string, number> = {};
  let totalTasks = 0;
  for (const row of taskStats) {
    statsMap[row.status] = row.cnt;
    totalTasks += row.cnt;
  }

  const doneCount = statsMap[TaskStatus.Done] ?? 0;

  console.log('\n📊 任务统计:');
  if (totalTasks === 0) {
    console.log('   无任务');
  } else {
    const parts: string[] = [];
    const statusLabels: Record<string, string> = {
      [TaskStatus.PendingDev]: '待开发',
      [TaskStatus.InDev]: '开发中',
      [TaskStatus.Done]: '已完成',
      [TaskStatus.Rejected]: '已打回',
      [TaskStatus.Paused]: '已暂停',
      [TaskStatus.Blocked]: '已阻塞',
      [TaskStatus.Cancelled]: '已取消',
    };
    for (const [status, label] of Object.entries(statusLabels)) {
      if (statsMap[status]) {
        parts.push(`${label}: ${statsMap[status]}`);
      }
    }
    console.log(`   ${parts.join('  ')}`);
    console.log(
      `   总进度: ${doneCount}/${totalTasks} (${Math.round((doneCount / totalTasks) * 100)}%)`
    );
  }

  // 4. Cost overview (token consumption per role)
  const costStats = rawQuery<{
    role: Role;
    dispatch_count: number;
    total_input: number;
    total_output: number;
    total_tokens: number;
  }>(`
    SELECT role,
           COUNT(*) as dispatch_count,
           SUM(input_tokens) as total_input,
           SUM(output_tokens) as total_output,
           SUM(input_tokens + output_tokens) as total_tokens
    FROM role_outputs
    GROUP BY role
    ORDER BY total_tokens DESC
  `);
  if (costStats.length > 0) {
    console.log('\n💰 Token 消耗:');
    let grandTotal = 0;
    for (const row of costStats) {
      const total = row.total_tokens ?? 0;
      grandTotal += total;
      console.log(
        `   ${row.role}: ${formatTokens(total)} tokens (输入 ${formatTokens(row.total_input ?? 0)} / 输出 ${formatTokens(row.total_output ?? 0)}) | ${row.dispatch_count} 次调度`
      );
    }
    console.log(`   合计: ${formatTokens(grandTotal)} tokens`);

    // Per-iteration cost (active iterations only)
    const iterCosts = rawQuery<{
      id: number;
      name: string | null;
      total_tokens: number;
      dispatch_count: number;
    }>(`
      SELECT i.id, i.name,
             SUM(r.input_tokens + r.output_tokens) as total_tokens,
             COUNT(r.id) as dispatch_count
      FROM iterations i
      JOIN role_outputs r ON r.related_iteration_id = i.id
      WHERE i.status = 'active'
      GROUP BY i.id
      ORDER BY total_tokens DESC
    `);
    if (iterCosts.length > 0) {
      console.log('   按迭代:');
      for (const ic of iterCosts) {
        const name = ic.name ? ` ${ic.name}` : '';
        console.log(
          `     #${ic.id}${name}: ${formatTokens(ic.total_tokens ?? 0)} tokens (${ic.dispatch_count} 次调度)`
        );
      }
    }
  }

  // 5. Recent messages
  const recentMessages = dbSelect<{
    id: number;
    from_role: Role;
    to_role: Role;
    content: string;
    created_at: string;
  }>('messages', undefined, {
    orderBy: 'created_at DESC',
    limit: 5,
  });
  console.log('\n💬 最近消息:');
  if (recentMessages.length === 0) {
    console.log('   无消息');
  } else {
    for (const msg of recentMessages) {
      const time = formatTime(msg.created_at);
      console.log(`   [${time}] ${msg.from_role} → ${msg.to_role}:`);
      console.log(
        msg.content
          .split('\n')
          .map((l) => '   ' + l)
          .join('\n')
      );
    }
  }

  console.log('');
}

function formatElapsed(createdAt: string): string {
  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h ${remainMinutes}m`;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
