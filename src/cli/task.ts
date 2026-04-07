import { checkEngineRunning, getDbPath } from "../config/index.js";
import { openDb, getDb } from "../db/connection.js";
import {
  select as dbSelect,
  update as dbUpdate,
  insert as dbInsert,
  rawQuery,
  rawRun,
} from "../db/repository.js";
import type { Command } from "commander";

interface TaskRow {
  id: number;
  status: string;
  title: string;
  priority: string;
  description?: string | null;
  acceptance_criteria?: string | null;
  assigned_to?: string | null;
  pre_suspend_status?: string | null;
  created_at: string;
}

const statusLabels: Record<string, string> = {
  pending_dev: "待开发",
  planning: "计划协商中",
  in_dev: "开发中",
  pending_qa: "待验收",
  in_qa: "验收中",
  done: "已完成",
  rejected: "已打回",
  cancelled: "已取消",
  paused: "已暂停",
  blocked: "已阻塞",
};

function ensureDb() {
  const { running } = checkEngineRunning();
  if (!running) {
    console.log("⚠️  win-agent 未运行");
    process.exit(1);
  }
  try {
    getDb();
  } catch {
    openDb(getDbPath(process.cwd()));
  }
}

function taskList() {
  ensureDb();

  const tasks = rawQuery<TaskRow>(
    "SELECT * FROM tasks WHERE status NOT IN ('done','cancelled') ORDER BY priority DESC, created_at ASC"
  );

  if (tasks.length === 0) {
    console.log("  没有进行中的任务");
    return;
  }

  // priority sort: high > medium > low (DESC in SQL works alphabetically: low < medium < high? No.)
  // Re-sort in JS to guarantee correct priority ordering
  const priorityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
  tasks.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 0;
    const pb = priorityOrder[b.priority] ?? 0;
    if (pa !== pb) return pb - pa;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });

  for (const task of tasks) {
    const label = statusLabels[task.status] ?? task.status;
    console.log(`  #${task.id} [${label}] (${task.priority}) ${task.title}`);
  }
}

function taskShow(taskId: string) {
  ensureDb();

  const id = parseInt(taskId, 10);
  if (isNaN(id)) {
    console.log(`⚠️  无效的任务 ID: ${taskId}`);
    process.exit(1);
  }

  const tasks = dbSelect<TaskRow>("tasks", { id });
  if (tasks.length === 0) {
    console.log(`⚠️  未找到任务 #${id}`);
    process.exit(1);
  }

  const task = tasks[0];
  const label = statusLabels[task.status] ?? task.status;

  console.log(`\n📋 任务 #${task.id}`);
  console.log(`   标题: ${task.title}`);
  console.log(`   状态: ${label}`);
  console.log(`   优先级: ${task.priority}`);
  console.log(`   负责人: ${task.assigned_to ?? "未分配"}`);
  console.log(`   描述: ${task.description ?? "无"}`);
  console.log(`   验收标准: ${task.acceptance_criteria ?? "无"}`);

  const events = rawQuery("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at", [id]);

  if (events.length > 0) {
    console.log(`\n   📅 事件历史:`);
    for (const evt of events) {
      const fromLabel = statusLabels[evt.from_status] ?? evt.from_status;
      const toLabel = statusLabels[evt.to_status] ?? evt.to_status;
      console.log(`     ${evt.created_at}  ${fromLabel} → ${toLabel}  (by ${evt.changed_by})`);
    }
  } else {
    console.log(`\n   📅 暂无事件历史`);
  }
}

function taskPause(taskId: string) {
  ensureDb();

  const id = parseInt(taskId, 10);
  if (isNaN(id)) {
    console.log(`⚠️  无效的任务 ID: ${taskId}`);
    process.exit(1);
  }

  const tasks = dbSelect<TaskRow>("tasks", { id });
  if (tasks.length === 0) {
    console.log(`⚠️  未找到任务 #${id}`);
    process.exit(1);
  }

  const task = tasks[0];
  const validFrom = ["pending_dev", "planning", "in_dev", "pending_qa", "in_qa", "rejected"];

  if (!validFrom.includes(task.status)) {
    const label = statusLabels[task.status] ?? task.status;
    console.log(`⚠️  任务 #${id} 当前状态为「${label}」，无法暂停`);
    process.exit(1);
  }

  dbInsert("task_events", {
    task_id: id,
    from_status: task.status,
    to_status: "paused",
    changed_by: "user",
  });

  dbUpdate("tasks", { id }, { status: "paused", pre_suspend_status: task.status });

  rawRun("UPDATE messages SET status = 'read' WHERE related_task_id = ? AND status = 'unread'", [
    id,
  ]);

  dbInsert("messages", {
    from_role: "system",
    to_role: "PM",
    type: "notification",
    content: `任务 #${id}「${task.title}」已被用户暂停。`,
    related_task_id: id,
  });

  console.log(`✅ 任务 #${id}「${task.title}」已暂停`);
}

function taskResume(taskId: string) {
  ensureDb();

  const id = parseInt(taskId, 10);
  if (isNaN(id)) {
    console.log(`⚠️  无效的任务 ID: ${taskId}`);
    process.exit(1);
  }

  const tasks = dbSelect<TaskRow>("tasks", { id });
  if (tasks.length === 0) {
    console.log(`⚠️  未找到任务 #${id}`);
    process.exit(1);
  }

  const task = tasks[0];

  if (task.status !== "paused") {
    const label = statusLabels[task.status] ?? task.status;
    console.log(`⚠️  任务 #${id} 当前状态为「${label}」，不是暂停状态，无法恢复`);
    process.exit(1);
  }

  const restoreStatus = task.pre_suspend_status || "pending_dev";

  dbInsert("task_events", {
    task_id: id,
    from_status: "paused",
    to_status: restoreStatus,
    changed_by: "user",
  });

  dbUpdate("tasks", { id }, { status: restoreStatus, pre_suspend_status: null });

  const restoreLabel = statusLabels[restoreStatus] ?? restoreStatus;

  dbInsert("messages", {
    from_role: "system",
    to_role: "PM",
    type: "notification",
    content: `任务 #${id}「${task.title}」已被用户恢复，状态恢复为「${restoreLabel}」。`,
    related_task_id: id,
  });

  console.log(`✅ 任务 #${id}「${task.title}」已恢复为「${restoreLabel}」`);
}

function taskCancel(taskId: string) {
  ensureDb();

  const id = parseInt(taskId, 10);
  if (isNaN(id)) {
    console.log(`⚠️  无效的任务 ID: ${taskId}`);
    process.exit(1);
  }

  const tasks = dbSelect<TaskRow>("tasks", { id });
  if (tasks.length === 0) {
    console.log(`⚠️  未找到任务 #${id}`);
    process.exit(1);
  }

  const task = tasks[0];

  if (task.status === "done" || task.status === "cancelled") {
    const label = statusLabels[task.status] ?? task.status;
    console.log(`⚠️  任务 #${id} 当前状态为「${label}」，无法取消`);
    process.exit(1);
  }

  dbInsert("task_events", {
    task_id: id,
    from_status: task.status,
    to_status: "cancelled",
    changed_by: "user",
  });

  dbUpdate("tasks", { id }, { status: "cancelled" });

  rawRun("UPDATE messages SET status = 'read' WHERE related_task_id = ? AND status = 'unread'", [
    id,
  ]);

  dbInsert("messages", {
    from_role: "system",
    to_role: "PM",
    type: "notification",
    content: `任务 #${id}「${task.title}」已被用户取消。`,
    related_task_id: id,
  });

  console.log(`✅ 任务 #${id}「${task.title}」已取消`);
}

function taskReprioritize(taskId: string, priority: string) {
  ensureDb();

  const id = parseInt(taskId, 10);
  if (isNaN(id)) {
    console.log(`⚠️  无效的任务 ID: ${taskId}`);
    process.exit(1);
  }

  const validPriorities = ["high", "medium", "low"];
  if (!validPriorities.includes(priority)) {
    console.log(`⚠️  无效的优先级: ${priority}（可选值: high, medium, low）`);
    process.exit(1);
  }

  const tasks = dbSelect<TaskRow>("tasks", { id });
  if (tasks.length === 0) {
    console.log(`⚠️  未找到任务 #${id}`);
    process.exit(1);
  }

  const task = tasks[0];
  const oldPriority = task.priority;

  dbUpdate("tasks", { id }, { priority });

  dbInsert("messages", {
    from_role: "system",
    to_role: "PM",
    type: "notification",
    content: `任务 #${id}「${task.title}」优先级已从 ${oldPriority} 调整为 ${priority}。`,
    related_task_id: id,
  });

  console.log(`✅ 任务 #${id}「${task.title}」优先级已调整: ${oldPriority} → ${priority}`);
}

export function registerTaskCommands(program: Command) {
  const task = program.command("task").description("任务管理");

  task
    .command("list")
    .description("列出进行中的任务")
    .action(() => {
      taskList();
    });

  task
    .command("show <taskId>")
    .description("查看任务详情及事件历史")
    .action((taskId: string) => {
      taskShow(taskId);
    });

  task
    .command("pause <taskId>")
    .description("暂停任务")
    .action((taskId: string) => {
      taskPause(taskId);
    });

  task
    .command("resume <taskId>")
    .description("恢复暂停的任务")
    .action((taskId: string) => {
      taskResume(taskId);
    });

  task
    .command("cancel <taskId>")
    .description("取消任务")
    .action((taskId: string) => {
      taskCancel(taskId);
    });

  task
    .command("reprioritize <taskId> <priority>")
    .description("调整任务优先级 (high/medium/low)")
    .action((taskId: string, priority: string) => {
      taskReprioritize(taskId, priority);
    });
}
