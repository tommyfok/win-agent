import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { isProcessRunning, loadConfig } from '../config/index.js';

interface ServerInfo {
  url: string;
  port: number;
  pid: number | null;
  startedAt: string;
}

export async function serverCommand() {
  // Find all running win-agent engine processes
  const entries: Array<{
    workspace: string;
    enginePid: number;
    serverInfo: ServerInfo | null;
    password: string | undefined;
  }> = [];

  try {
    const result = execSync(
      "ps -eo pid,command | grep 'win-agent._engine' | grep -v grep",
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();

    if (!result) {
      console.log('\n⚠️  没有正在运行的 win-agent server');
      return;
    }

    for (const line of result.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      if (isNaN(pid) || !isProcessRunning(pid)) continue;

      // The workspace path is the last argument of `win-agent _engine <workspace>`
      const workspace = parts[parts.length - 1];
      if (!workspace || !fs.existsSync(path.join(workspace, '.win-agent'))) continue;

      let serverInfo: ServerInfo | null = null;
      const serverInfoPath = path.join(workspace, '.win-agent', 'opencode-server.json');
      if (fs.existsSync(serverInfoPath)) {
        try {
          serverInfo = JSON.parse(fs.readFileSync(serverInfoPath, 'utf-8'));
        } catch {
          /* ignore corrupt file */
        }
      }

      const config = loadConfig(workspace);

      entries.push({ workspace, enginePid: pid, serverInfo, password: config.serverPassword });
    }
  } catch {
    // ps command failed — no processes found
    console.log('\n⚠️  没有正在运行的 win-agent server');
    return;
  }

  if (entries.length === 0) {
    console.log('\n⚠️  没有正在运行的 win-agent server');
    return;
  }

  console.log(`\n📡 正在运行的 win-agent server (${entries.length} 个)\n`);
  for (const entry of entries) {
    const si = entry.serverInfo;
    console.log(`   工作目录: ${entry.workspace}`);
    console.log(`   引擎 PID: ${entry.enginePid}`);
    if (si) {
      console.log(`   Server PID: ${si.pid ?? '-'}`);
      console.log(`   端口: ${si.port}`);
      console.log(`   URL: ${si.url}`);
      console.log(`   启动时间: ${formatTime(si.startedAt)}`);
    } else {
      console.log('   Server 信息: 不可用');
    }
    console.log(`   密码: ${entry.password ?? '未设置'}`);
    console.log('');
  }
}

function formatTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return isoStr;
  }
}
