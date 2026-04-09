import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { select } from '@inquirer/prompts';
import { checkEngineRunning } from '../config/index.js';
import { SessionManager } from '../engine/session-manager.js';

export async function talkCommand() {
  const workspace = process.cwd();

  // 1. Check engine is running
  const { running } = checkEngineRunning(workspace);
  if (!running) {
    console.log('⚠️  win-agent 未运行');
    console.log('   请先执行: npx win-agent start');
    process.exit(1);
  }

  // 2. Read server URL from persisted info
  let serverUrl = 'http://localhost:4096';
  try {
    const { default: fs } = await import('node:fs');
    const { default: path } = await import('node:path');
    const infoFile = path.join(workspace, '.win-agent', 'opencode-server.json');
    if (fs.existsSync(infoFile)) {
      const info = JSON.parse(fs.readFileSync(infoFile, 'utf-8'));
      if (info.url) serverUrl = info.url;
    }
  } catch {
    /* use default */
  }

  // 3. Let user pick a role
  const sessions = SessionManager.loadPersistedSessions(workspace);
  if (!sessions || Object.keys(sessions).length === 0) {
    console.log('⚠️  未找到任何 session，请确认 win-agent 已正常启动');
    process.exit(1);
  }

  const workspaceBase64 = Buffer.from(workspace).toString('base64url');
  const entries = Object.entries(sessions);

  const sessionId = await select({
    message: '请选择要打开的角色',
    choices: entries.map(([role, id]) => ({ name: role, value: id })),
  });

  const role = entries.find(([, id]) => id === sessionId)![0];
  const url = `${serverUrl}/${workspaceBase64}/session/${sessionId}`;
  console.log(`正在打开 ${role} 聊天页面...`);
  openBrowser(url);
}

function openBrowser(url: string): void {
  const os = platform();
  let cmd: string;
  if (os === 'darwin') {
    cmd = `open "${url}"`;
  } else if (os === 'win32') {
    cmd = `start "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) {
      console.log(`⚠️  无法自动打开浏览器，请手动访问: ${url}`);
    }
  });
}
