import { exec } from "node:child_process";
import { platform } from "node:os";
import { checkEngineRunning } from "../config/index.js";
import { SessionManager } from "../engine/session-manager.js";

export async function talkCommand() {
  const workspace = process.cwd();

  // 1. Check engine is running
  const { running, pid } = checkEngineRunning(workspace);
  if (!running) {
    console.log("⚠️  win-agent 未运行");
    console.log("   请先执行: npx win-agent start");
    process.exit(1);
  }

  // 2. Read server URL from persisted info
  let serverUrl = "http://localhost:4096";
  try {
    const { default: fs } = await import("node:fs");
    const { default: path } = await import("node:path");
    const infoFile = path.join(workspace, ".win-agent", "opencode-server.json");
    if (fs.existsSync(infoFile)) {
      const info = JSON.parse(fs.readFileSync(infoFile, "utf-8"));
      if (info.url) serverUrl = info.url;
    }
  } catch { /* use default */ }

  // 3. Build the full URL: {serverUrl}/{base64(workspace)}/session/{pmSessionId}
  const sessions = SessionManager.loadPersistedSessions(workspace);
  const pmSessionId = sessions?.PM;

  let targetUrl: string;
  if (pmSessionId) {
    const workspaceBase64 = Buffer.from(workspace).toString("base64url");
    targetUrl = `${serverUrl}/${workspaceBase64}/session/${pmSessionId}`;
  } else {
    targetUrl = serverUrl;
  }

  console.log("🔗 正在打开 PM 聊天页面...");
  console.log(`   ${targetUrl}`);

  openBrowser(targetUrl);
}

function openBrowser(url: string): void {
  const os = platform();
  let cmd: string;
  if (os === "darwin") {
    cmd = `open "${url}"`;
  } else if (os === "win32") {
    cmd = `start "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      console.log("   ⚠️  无法自动打开浏览器，请手动访问上方链接");
    }
  });
}
