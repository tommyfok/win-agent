import { confirm } from '@inquirer/prompts';
import { checkEngineRunning, getDbPath } from '../config/index.js';
import { openDb, getDb } from '../db/connection.js';
import {
  select as dbSelect,
  update as dbUpdate,
  insert as dbInsert,
  rawQuery,
} from '../db/repository.js';
import { checkAndUnblockDependencies } from '../engine/dependency-checker.js';
import { Role } from '../engine/role-manager.js';
import { TaskStatus } from '../db/types.js';

export async function cancelCommand(iterationId: string) {
  // 1. Check engine is running
  const { running } = checkEngineRunning();
  if (!running) {
    console.log('⚠️  win-agent 未运行');
    console.log('   请先执行: npx win-agent start');
    process.exit(1);
  }

  const workspace = process.cwd();

  // Open DB
  const dbPath = getDbPath(workspace);
  try {
    getDb();
  } catch {
    openDb(dbPath);
  }

  const id = parseInt(iterationId, 10);
  if (isNaN(id)) {
    console.log(`⚠️  无效的迭代 ID: ${iterationId}`);
    process.exit(1);
  }

  // 2. Query target iteration
  const iterations = dbSelect<{ id: number; status: string; name: string | null }>(
    'iterations',
    { id }
  );
  if (iterations.length === 0) {
    console.log(`⚠️  未找到迭代 #${id}`);
    process.exit(1);
  }

  const iter = iterations[0];
  if (iter.status !== 'active') {
    console.log(`⚠️  迭代 #${id} 当前状态为 ${iter.status}，无法取消`);
    process.exit(1);
  }

  // 3. Show task overview
  const tasks = dbSelect<{ id: number; status: TaskStatus; title: string }>('tasks', {
    iteration_id: id,
  });
  const inProgressStatuses = new Set<TaskStatus>([
    TaskStatus.PendingDev,
    TaskStatus.InDev,
    TaskStatus.Paused,
    TaskStatus.Blocked,
  ]);
  const inProgressTasks = tasks.filter((t) => inProgressStatuses.has(t.status));
  const doneTasks = tasks.filter((t) => t.status === TaskStatus.Done);

  const taskStatusCounts = rawQuery<{ status: string; cnt: number }>(
    `
    SELECT status, COUNT(*) as cnt
    FROM tasks
    WHERE iteration_id = ?
    GROUP BY status
  `,
    [id]
  );

  const parts = taskStatusCounts.map((r) => `${r.status}: ${r.cnt}`).join(', ');
  const name = iter.name ? ` ${iter.name}` : '';

  console.log(`\n⚠️  即将取消迭代 #${id}${name}`);
  console.log(`   关联任务: ${tasks.length} 个（${parts || '无'}）`);

  // 4. Confirm
  const yes = await confirm({
    message: '确认取消？已完成的任务将保留，进行中的任务将标记为 cancelled',
    default: false,
  });

  if (!yes) {
    console.log('   已取消操作');
    return;
  }

  // 5. Update iteration status
  dbUpdate('iterations', { id }, { status: 'cancelled' });

  // 6. Cancel in-progress tasks
  let cancelledCount = 0;
  for (const task of inProgressTasks) {
    dbUpdate('tasks', { id: task.id }, { status: TaskStatus.Cancelled });
    cancelledCount++;
  }

  // Unblock downstream tasks whose only blocker was one of the cancelled tasks
  checkAndUnblockDependencies();

  // 7. Notify PM via system message
  dbInsert('messages', {
    from_role: Role.SYS,
    to_role: Role.PM,
    type: 'notification',
    content: `迭代 #${id}${name} 已被用户取消。${cancelledCount} 个进行中任务已标记为 cancelled，${doneTasks.length} 个已完成任务保留。`,
    related_iteration_id: id,
  });

  console.log(`\n✅ 迭代 #${id} 已取消`);
  console.log(`   - 迭代状态 → cancelled`);
  console.log(`   - ${cancelledCount} 个进行中任务 → cancelled`);
  console.log(`   - ${doneTasks.length} 个已完成任务 → 保留`);
}
