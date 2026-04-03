import {
  checkEngineRunning,
  removePidFile,
  getWorkspacePath,
  getDbPath,
} from "../config/index.js";
import { openDb, getDb, closeDb } from "../db/connection.js";
import { getServerHandle, getSessionManager } from "./start.js";

export async function stopCommand() {
  const { running, pid } = checkEngineRunning();
  if (!running) {
    console.log("⚠️  win-agent 未在运行");
    return;
  }

  console.log(`\n🛑 正在停止 win-agent (PID: ${pid})...`);

  // Trigger memory writes for all roles
  const sm = getSessionManager();
  if (sm) {
    console.log("   → 保存角色记忆...");
    await sm.writeAllMemories("engine_stop");
  } else {
    console.log("   ⏭  非引擎进程，跳过记忆写入");
  }

  // Close opencode server if in this process
  const server = getServerHandle();
  if (server) {
    server.close();
    console.log("   ✓ opencode server 已停止");
  }

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
