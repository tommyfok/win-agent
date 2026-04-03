import {
  checkEngineRunning,
  getWorkspacePath,
  getDbPath,
} from "../config/index.js";
import { openDb, getDb } from "../db/connection.js";
import { select as dbSelect, rawQuery } from "../db/repository.js";

export async function statusCommand() {
  // 1. Check engine status
  const { running, pid } = checkEngineRunning();
  if (!running) {
    console.log("⚠️  win-agent 未运行");
    console.log("   请先执行: npx win-agent start");
    process.exit(1);
  }

  const workspace = getWorkspacePath();
  if (!workspace) {
    console.log("⚠️  工作空间未配置");
    process.exit(1);
  }

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

  // 2. Active workflow instances
  const workflows = dbSelect("workflow_instances", { status: "active" }, { orderBy: "created_at DESC" });
  console.log("\n📋 工作流实例:");
  if (workflows.length === 0) {
    console.log("   无活跃工作流");
  } else {
    for (const wf of workflows) {
      const elapsed = formatElapsed(wf.created_at);
      console.log(`   #${wf.id} [${wf.template}] 阶段: ${wf.phase}`);
      console.log(`      状态: ${wf.status} | 已进行: ${elapsed}`);
    }
  }

  // 3. Task statistics
  const taskStats = rawQuery(`
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

  const doneCount = statsMap["done"] ?? 0;

  console.log("\n📊 任务统计:");
  if (totalTasks === 0) {
    console.log("   无任务");
  } else {
    const parts: string[] = [];
    const statusLabels: Record<string, string> = {
      pending_dev: "待开发",
      in_dev: "开发中",
      pending_qa: "待验收",
      in_qa: "验收中",
      done: "已完成",
      rejected: "已打回",
      cancelled: "已取消",
    };
    for (const [status, label] of Object.entries(statusLabels)) {
      if (statsMap[status]) {
        parts.push(`${label}: ${statsMap[status]}`);
      }
    }
    console.log(`   ${parts.join("  ")}`);
    console.log(`   总进度: ${doneCount}/${totalTasks} (${Math.round((doneCount / totalTasks) * 100)}%)`);
  }

  // 4. Recent messages
  const recentMessages = dbSelect("messages", undefined, {
    orderBy: "created_at DESC",
    limit: 5,
  });
  console.log("\n💬 最近消息:");
  if (recentMessages.length === 0) {
    console.log("   无消息");
  } else {
    for (const msg of recentMessages) {
      const time = formatTime(msg.created_at);
      const content = msg.content.length > 50 ? msg.content.substring(0, 50) + "..." : msg.content;
      console.log(`   [${time}] ${msg.from_role} → ${msg.to_role}: ${content}`);
    }
  }

  console.log("");
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
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
