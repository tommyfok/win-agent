import {
  checkEngineRunning,
  getDbPath,
} from "../config/index.js";
import { openDb, getDb } from "../db/connection.js";
import { select as dbSelect, rawQuery } from "../db/repository.js";
import { formatTokens } from "../utils/format.js";

export async function statusCommand() {
  // 1. Check engine status
  const { running, pid } = checkEngineRunning();
  if (!running) {
    console.log("⚠️  win-agent 未运行");
    console.log("   请先执行: npx win-agent start");
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
      planning: "计划协商中",
      in_dev: "开发中",
      pending_qa: "待验收",
      in_qa: "验收中",
      done: "已完成",
      rejected: "已打回",
      paused: "已暂停",
      blocked: "已阻塞",
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

  // 4. Cost overview (token consumption per role)
  const costStats = rawQuery(`
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
    console.log("\n💰 Token 消耗:");
    let grandTotal = 0;
    for (const row of costStats) {
      const total = row.total_tokens ?? 0;
      grandTotal += total;
      console.log(
        `   ${row.role}: ${formatTokens(total)} tokens (输入 ${formatTokens(row.total_input ?? 0)} / 输出 ${formatTokens(row.total_output ?? 0)}) | ${row.dispatch_count} 次调度`,
      );
    }
    console.log(`   合计: ${formatTokens(grandTotal)} tokens`);

    // Per-workflow cost (active workflows only)
    const wfCosts = rawQuery(`
      SELECT w.id, w.template, w.phase,
             SUM(r.input_tokens + r.output_tokens) as total_tokens,
             COUNT(r.id) as dispatch_count
      FROM workflow_instances w
      JOIN role_outputs r ON r.related_workflow_id = w.id
      WHERE w.status = 'active'
      GROUP BY w.id
      ORDER BY total_tokens DESC
    `);
    if (wfCosts.length > 0) {
      console.log("   按工作流:");
      for (const wc of wfCosts) {
        console.log(`     #${wc.id} [${wc.template}]: ${formatTokens(wc.total_tokens ?? 0)} tokens (${wc.dispatch_count} 次调度)`);
      }
    }
  }

  // 5. Recent messages
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

// formatTokens imported from ../utils/format.js

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
