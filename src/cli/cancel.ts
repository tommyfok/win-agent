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

export async function cancelCommand(workflowId: string) {
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

  const id = parseInt(workflowId, 10);
  if (isNaN(id)) {
    console.log(`⚠️  无效的工作流 ID: ${workflowId}`);
    process.exit(1);
  }

  // 2. Query target workflow
  const workflows = dbSelect<{ id: number; status: string; template: string; phase: string }>(
    'workflow_instances',
    { id }
  );
  if (workflows.length === 0) {
    console.log(`⚠️  未找到工作流 #${id}`);
    process.exit(1);
  }

  const wf = workflows[0];
  if (wf.status !== 'active') {
    console.log(`⚠️  工作流 #${id} 当前状态为 ${wf.status}，无法取消`);
    process.exit(1);
  }

  // 3. Show task overview
  const tasks = dbSelect<{ id: number; status: string; title: string }>('tasks', {
    workflow_id: id,
  });
  const inProgressStatuses = ['pending_dev', 'in_dev', 'paused', 'blocked'];
  const inProgressTasks = tasks.filter((t) => inProgressStatuses.includes(t.status));
  const doneTasks = tasks.filter((t) => t.status === 'done');

  const taskStatusCounts = rawQuery<{ status: string; cnt: number }>(
    `
    SELECT status, COUNT(*) as cnt
    FROM tasks
    WHERE workflow_id = ?
    GROUP BY status
  `,
    [id]
  );

  const parts = taskStatusCounts.map((r) => `${r.status}: ${r.cnt}`).join(', ');

  console.log(`\n⚠️  即将取消工作流 #${id} [${wf.template}]`);
  console.log(`   当前阶段: ${wf.phase}`);
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

  // 5. Update workflow status
  dbUpdate('workflow_instances', { id }, { status: 'cancelled' });

  // 6. Cancel in-progress tasks
  let cancelledCount = 0;
  for (const task of inProgressTasks) {
    dbUpdate('tasks', { id: task.id }, { status: 'cancelled' });
    cancelledCount++;
  }

  // Unblock downstream tasks whose only blocker was one of the cancelled tasks
  checkAndUnblockDependencies();

  // 7. Notify PM via system message
  dbInsert('messages', {
    from_role: 'system',
    to_role: 'PM',
    type: 'notification',
    content: `工作流 #${id} [${wf.template}] 已被用户取消。${cancelledCount} 个进行中任务已标记为 cancelled，${doneTasks.length} 个已完成任务保留。`,
    related_workflow_id: id,
  });

  console.log(`\n✅ 工作流 #${id} 已取消`);
  console.log(`   - 流程状态 → cancelled`);
  console.log(`   - ${cancelledCount} 个进行中任务 → cancelled`);
  console.log(`   - ${doneTasks.length} 个已完成任务 → 保留`);
}
