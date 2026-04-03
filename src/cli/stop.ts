import {
  checkEngineRunning,
  removePidFile,
  getWorkspacePath,
  getDbPath,
} from "../config/index.js";
import { openDb, getDb, closeDb } from "../db/connection.js";

export async function stopCommand() {
  const { running, pid } = checkEngineRunning();
  if (!running) {
    console.log("⚠️  win-agent 未在运行");
    return;
  }

  console.log(`\n🛑 正在停止 win-agent (PID: ${pid})...`);

  // TODO: 阶段 5 — 触发所有角色写记忆（trigger='engine_stop'）
  // await triggerMemoryWrite('engine_stop');
  console.log("   ⏳ 记忆写入将在 opencode SDK 集成后启用");

  // Close DB if open in this process
  const workspace = getWorkspacePath();
  if (workspace) {
    const dbPath = getDbPath(workspace);
    try {
      getDb();
      closeDb();
      console.log("   ✓ 数据库连接已关闭");
    } catch {
      // DB not open in this process, that's fine
    }
  }

  // If the running PID is a different process, send SIGTERM
  if (pid && pid !== process.pid) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`   ✓ 已向进程 ${pid} 发送终止信号`);
    } catch {
      console.log(`   △ 进程 ${pid} 已不存在`);
    }
  }

  // Clean PID file
  removePidFile();
  console.log("   ✓ PID 锁文件已清理");
  console.log("\n✅ win-agent 已停止");
}
