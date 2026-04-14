import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import {
  loadConfig,
  checkEngineRunning,
  removePidFile,
  isProcessRunning,
} from '../config/index.js';

import {
  startOpencodeServer,
  removeServerInfo,
  loadServerPid,
  killProcessTree,
  type OpencodeServerHandle,
} from '../engine/opencode-server.js';
import { AGENT_ROLES } from '../engine/role-manager.js';

export async function cleanCommand() {
  try {
    await _cleanCommand();
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.name === 'ExitPromptError' || err.message?.includes('User force closed'))
    ) {
      console.log('\n👋 已取消');
      process.exit(0);
    }
    throw err;
  }
}

async function _cleanCommand() {
  const cwd = process.cwd();
  const winAgentDir = path.join(cwd, '.win-agent');

  if (!fs.existsSync(winAgentDir)) {
    console.log('当前目录下没有 .win-agent 目录，无需清理。');
    return;
  }

  // ── Check if engine is running ──
  const { running, pid } = checkEngineRunning(cwd);
  if (running && pid) {
    console.log(`\n⚠️  win-agent 引擎正在运行中 (PID: ${pid})`);
    const forceClean = await confirm({
      message: '清理将停止引擎并删除所有 win-agent 数据，确认继续？',
      default: false,
    });
    if (!forceClean) {
      console.log('已取消。');
      return;
    }
    await stopEngine(cwd, pid);
  }

  // Read workspace ID before deleting config
  const config = loadConfig(cwd);
  const wsId = config.workspaceId;
  const sessionPrefix = wsId ? `wa-${wsId}` : null;

  const opencodeDir = path.join(cwd, '.opencode');

  const agentMdPath = path.join(cwd, 'AGENT.md');
  const hasAgentMd = fs.existsSync(agentMdPath);

  console.log('\n将清理以下内容：');
  console.log(`  - ${winAgentDir}/`);
  if (hasAgentMd) console.log('  - AGENT.md（根目录）');
  console.log(`  - .opencode/tools/database_{PM,DEV}.ts`);
  console.log(`  - .opencode/opencode.json 中的 permission 字段`);
  if (sessionPrefix) {
    console.log(`  - opencode 中 ${sessionPrefix}-* 相关 session`);
  }

  const ok = await confirm({ message: '确认删除？此操作不可恢复', default: false });
  if (!ok) {
    console.log('已取消。');
    return;
  }

  // Clean opencode sessions if we have a workspace ID
  if (sessionPrefix) {
    await cleanOpencodeSessionsQuietly(cwd, sessionPrefix);
  }

  // Delete .win-agent directory
  fs.rmSync(winAgentDir, { recursive: true, force: true });
  console.log('  ✓ 已删除 .win-agent/');

  // Delete root AGENT.md
  if (hasAgentMd) {
    fs.unlinkSync(agentMdPath);
    console.log('  ✓ 已删除 AGENT.md');
  }

  // Clean only win-agent-managed files in .opencode/
  cleanOpencodeFiles(opencodeDir);

  console.log('\n✅ 清理完成');
}

/**
 * Remove only win-agent-managed files from .opencode/.
 * Deletes agents, tools, and the permission key in opencode.json.
 * Removes empty directories but leaves .opencode/ itself if other files remain.
 */
function cleanOpencodeFiles(opencodeDir: string): void {
  if (!fs.existsSync(opencodeDir)) return;

  // 1. Remove agent files
  const agentsDir = path.join(opencodeDir, 'agents');
  for (const role of AGENT_ROLES) {
    const f = path.join(agentsDir, `${role}.md`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  removeIfEmpty(agentsDir);

  // 2. Remove tool files
  const toolsDir = path.join(opencodeDir, 'tools');
  for (const role of AGENT_ROLES) {
    const f = path.join(toolsDir, `database_${role}.ts`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  // Legacy shared tool file
  const legacy = path.join(toolsDir, 'database.ts');
  if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  removeIfEmpty(toolsDir);

  // 3. Remove permission key from opencode.json
  const configFile = path.join(opencodeDir, 'opencode.json');
  if (fs.existsSync(configFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      delete cfg.permission;
      if (Object.keys(cfg).length === 0) {
        fs.unlinkSync(configFile);
      } else {
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf-8');
      }
    } catch {
      /* leave file untouched if parse fails */
    }
  }

  removeIfEmpty(opencodeDir);
  console.log('  ✓ 已清理 .opencode/ 中的 win-agent 文件');
}

function removeIfEmpty(dir: string): void {
  if (!fs.existsSync(dir)) return;
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/**
 * Stop the running engine and clean up all associated processes.
 */
async function stopEngine(workspace: string, pid: number): Promise<void> {
  console.log(`\n🛑 正在停止引擎 (PID: ${pid})...`);

  // Send SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    console.log(`   △ 进程 ${pid} 已不存在`);
    removePidFile(workspace);
    cleanupOrphanedProcesses(workspace);
    return;
  }

  // Wait up to 15s for graceful exit
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isProcessRunning(pid)) {
      console.log('   ✓ 引擎已停止');
      removePidFile(workspace);
      cleanupOrphanedProcesses(workspace);
      return;
    }
  }

  // Force kill
  console.log('   ⚠️  引擎未及时退出，强制终止...');
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already dead */
  }
  removePidFile(workspace);
  cleanupOrphanedProcesses(workspace);
  console.log('   ✓ 引擎已停止 (强制)');
}

/**
 * Kill orphaned opencode server and engine processes.
 */
function cleanupOrphanedProcesses(workspace: string): void {
  const serverPid = loadServerPid(workspace);
  if (serverPid) {
    try {
      killProcessTree(serverPid);
    } catch {
      /* already dead */
    }
  }

  try {
    const result = execSync("ps -eo pid,command | grep '[.]opencode serve' | grep -v grep", {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    for (const line of result.split('\n')) {
      const opPid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (opPid && !isNaN(opPid)) {
        try {
          process.kill(opPid, 'SIGTERM');
        } catch {
          /* already dead */
        }
      }
    }
  } catch {
    /* no orphaned processes */
  }

  try {
    const result = execSync(
      `ps -eo pid,command | grep 'win-agent _engine ${workspace}' | grep -v grep`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    for (const line of result.split('\n')) {
      const opPid = parseInt(line.trim().split(/\s+/)[0], 10);
      if (opPid && !isNaN(opPid)) {
        try {
          process.kill(opPid, 'SIGTERM');
        } catch {
          /* already dead */
        }
      }
    }
  } catch {
    /* no orphaned processes */
  }

  removeServerInfo(workspace);
}

/**
 * Start a temporary opencode server, delete sessions matching prefix, then shut down.
 */
async function cleanOpencodeSessionsQuietly(workspace: string, prefix: string): Promise<void> {
  let handle: OpencodeServerHandle | null = null;
  try {
    // Use a different port to avoid conflict with a running engine
    handle = await startOpencodeServer(workspace);
    const listResult = await handle.client.session.list();
    const sessions = (listResult.data ?? []) as Array<{ id: string; title: string }>;
    let deleted = 0;
    for (const s of sessions) {
      if (s.title?.startsWith(prefix)) {
        try {
          await handle.client.session.delete({ path: { id: s.id } });
          deleted++;
        } catch {
          /* ignore */
        }
      }
    }
    if (deleted > 0) {
      console.log(`  ✓ 已清理 ${deleted} 个 opencode session`);
    } else {
      console.log('  ✓ 无残留 opencode session');
    }
  } catch {
    console.log('  ⚠️  opencode session 清理跳过（服务启动失败）');
  } finally {
    try {
      handle?.close();
    } catch {
      // ignore close errors during cleanup
    }
  }
}
