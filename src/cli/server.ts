import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Separator, select } from '@inquirer/prompts';
import { isProcessRunning, loadConfig } from '../config/index.js';
import { logCommand } from './log.js';
import { modelCommand } from './model.js';
import { restartCommand } from './restart.js';
import { skillsCommand } from './skills.js';
import { statusCommand } from './status.js';
import { stopCommand } from './stop.js';
import { taskStatus } from './task.js';
import { talkCommand } from './talk.js';
import { updateCommand } from './update.js';

interface ServerInfo {
  url: string;
  port: number;
  pid: number | null;
  startedAt: string;
}

type WorkspaceAction =
  | 'talk'
  | 'status'
  | 'tasks'
  | 'log'
  | 'model'
  | 'update'
  | 'skills'
  | 'restart'
  | 'stop'
  | 'exit';

const workspaceActionChoices = [
  new Separator('──────────── 日常查看 ────────────'),
  { name: '对话：打开角色聊天页面', value: 'talk' },
  { name: '状态：查看运行状态、迭代进度和最近消息', value: 'status' },
  { name: '任务概览：按状态查看所有任务', value: 'tasks' },
  { name: '日志：实时查看 engine.log', value: 'log' },
  new Separator('──────────── 配置维护 ────────────'),
  { name: '模型：切换 LLM / Embedding 配置', value: 'model' },
  { name: '更新：同步工作空间文档和角色模板', value: 'update' },
  { name: 'Skills：推荐并安装项目技能', value: 'skills' },
  new Separator('──────────── 进程控制 ────────────'),
  { name: '重启：停止后重新启动', value: 'restart' },
  { name: '停止：停止该 workspace 的 win-agent', value: 'stop' },
  new Separator(),
  { name: '退出', value: 'exit' },
] satisfies Array<Separator | { name: string; value: WorkspaceAction }>;

export async function serverCommand() {
  // Find all running win-agent engine processes
  const entries: Array<{
    workspace: string;
    enginePid: number;
    serverInfo: ServerInfo | null;
    password: string | undefined;
  }> = [];

  try {
    const result = execSync("ps -eo pid,command | grep 'win-agent._engine' | grep -v grep", {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

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

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  await promptServerAction(entries);
}

async function promptServerAction(
  entries: Array<{
    workspace: string;
    enginePid: number;
    serverInfo: ServerInfo | null;
    password: string | undefined;
  }>
): Promise<void> {
  try {
    const selectedWorkspace = await select({
      message: '请选择要操作的 server',
      choices: [
        ...entries.map((entry) => ({
          name: formatServerChoice(entry),
          value: entry.workspace,
        })),
        { name: '退出', value: '' },
      ],
    });

    if (!selectedWorkspace) return;

    const action = await select({
      message: '请选择操作',
      choices: workspaceActionChoices,
    });

    if (action === 'exit') return;

    await runWorkspaceAction(selectedWorkspace, action);
  } catch (err) {
    if (isPromptCancel(err)) {
      console.log('\n👋 已取消');
      return;
    }
    throw err;
  }
}

async function runWorkspaceAction(workspace: string, action: WorkspaceAction): Promise<void> {
  const previousCwd = process.cwd();
  try {
    process.chdir(workspace);
    if (action === 'talk') {
      await talkCommand();
    } else if (action === 'status') {
      await statusCommand();
    } else if (action === 'tasks') {
      taskStatus();
    } else if (action === 'log') {
      logCommand();
    } else if (action === 'model') {
      await modelCommand();
    } else if (action === 'update') {
      await updateCommand();
    } else if (action === 'skills') {
      await skillsCommand();
    } else if (action === 'restart') {
      await restartCommand();
    } else if (action === 'stop') {
      await stopCommand();
    }
  } finally {
    process.chdir(previousCwd);
  }
}

function formatServerChoice(entry: {
  workspace: string;
  enginePid: number;
  serverInfo: ServerInfo | null;
}): string {
  const parts = [
    `${path.basename(entry.workspace)} (${entry.workspace})`,
    `PID ${entry.enginePid}`,
  ];
  if (entry.serverInfo) {
    parts.push(`:${entry.serverInfo.port}`);
  }
  return parts.join('  ');
}

function isPromptCancel(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'ExitPromptError' || err.message?.includes('User force closed'))
  );
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
