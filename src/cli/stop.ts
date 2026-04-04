import {
  checkEngineRunning,
  removePidFile,
  isProcessRunning,
} from "../config/index.js";

export async function stopCommand() {
  const { running, pid } = checkEngineRunning();
  if (!running || !pid) {
    console.log("⚠️  win-agent 未在运行");
    return;
  }

  console.log(`\n🛑 正在停止 win-agent (PID: ${pid})...`);

  // Send SIGTERM — the daemon process handles memory writes and cleanup
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    console.log(`   △ 进程 ${pid} 已不存在`);
    removePidFile();
    console.log("   ✓ PID 锁文件已清理");
    return;
  }

  // Wait for the daemon to exit (up to 120s for memory writes across multiple roles)
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isProcessRunning(pid)) {
      console.log("   ✓ 引擎已停止");
      // Daemon should have cleaned up PID file, but clean up just in case
      removePidFile();
      console.log("\n✅ win-agent 已停止");
      return;
    }
  }

  // Force kill if still running
  console.log("   ⚠️  引擎未在 120s 内退出，强制终止...");
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  removePidFile();
  console.log("\n✅ win-agent 已停止 (强制)");
}
