import { execSync } from 'node:child_process';
import { checkEngineRunning, removePidFile, isProcessRunning } from '../config/index.js';
import { removeServerInfo } from '../engine/opencode-server.js';

export async function stopCommand() {
  const workspace = process.cwd();
  const { running, pid } = checkEngineRunning();
  if (!running || !pid) {
    console.log('⚠️  win-agent 未在运行');
    // Still clean up orphaned processes
    cleanupOrphanedProcesses(workspace);
    return;
  }

  console.log(`\n🛑 正在停止 win-agent (PID: ${pid})...`);

  // Send SIGTERM — the daemon process handles memory writes and cleanup
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    console.log(`   △ 进程 ${pid} 已不存在`);
    removePidFile();
    cleanupOrphanedProcesses(workspace);
    console.log('   ✓ 已清理');
    return;
  }

  // Wait for the daemon to exit (up to 30s — dispatch is aborted on SIGTERM,
  // so we only need to wait for memory writes and cleanup)
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isProcessRunning(pid)) {
      console.log('   ✓ 引擎已停止');
      removePidFile();
      cleanupOrphanedProcesses(workspace);
      console.log('\n✅ win-agent 已停止');
      return;
    }
  }

  // Force kill if still running
  console.log('   ⚠️  引擎未在 30s 内退出，强制终止...');
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // process may already be dead
  }
  removePidFile();
  cleanupOrphanedProcesses(workspace);
  console.log('\n✅ win-agent 已停止 (强制)');
}

/**
 * Kill orphaned opencode server processes and stale engine processes
 * that weren't properly cleaned up by previous runs.
 */
function cleanupOrphanedProcesses(workspace: string): void {
  try {
    // Kill orphaned opencode servers started by win-agent
    const result = execSync("ps -eo pid,command | grep '[.]opencode serve' | grep -v grep", {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (result) {
      for (const line of result.split('\n')) {
        const pidStr = line.trim().split(/\s+/)[0];
        const opPid = parseInt(pidStr, 10);
        if (opPid && !isNaN(opPid)) {
          try {
            process.kill(opPid, 'SIGTERM');
            console.log(`   ✓ 清理孤立 opencode 进程 (PID: ${opPid})`);
          } catch {
            /* already dead */
          }
        }
      }
    }
  } catch {
    /* no orphaned processes */
  }

  try {
    // Kill orphaned win-agent engine processes for this workspace
    const result = execSync(
      `ps -eo pid,command | grep 'win-agent _engine ${workspace}' | grep -v grep`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (result) {
      for (const line of result.split('\n')) {
        const pidStr = line.trim().split(/\s+/)[0];
        const opPid = parseInt(pidStr, 10);
        if (opPid && !isNaN(opPid)) {
          try {
            process.kill(opPid, 'SIGTERM');
            console.log(`   ✓ 清理孤立引擎进程 (PID: ${opPid})`);
          } catch {
            /* already dead */
          }
        }
      }
    }
  } catch {
    /* no orphaned processes */
  }

  // Clean up server info file
  removeServerInfo(workspace);
}
