import { exec } from "node:child_process";
import { platform } from "node:os";
import { checkEngineRunning } from "../config/index.js";
import { getSessionManager } from "./start.js";

export async function talkCommand() {
  // 1. Check engine is running
  const { running, pid } = checkEngineRunning();
  if (!running) {
    console.log("⚠️  win-agent 未运行");
    console.log("   请先执行: npx win-agent start");
    process.exit(1);
  }

  // 2. Get PM session ID
  const port = 4096;
  const sm = getSessionManager();
  let pmSessionId: string;
  if (sm) {
    pmSessionId = sm.getPmSessionId();
  } else {
    // Fallback: engine is running in a different process,
    // session manager is not available in this process.
    // User should open the opencode web UI directly.
    console.log("⚠️  当前进程无法获取 PM Session ID");
    console.log("   请直接访问 opencode Web UI:");
    console.log(`   http://localhost:${port}`);
    openBrowser(`http://localhost:${port}`);
    return;
  }

  // 3. Build URL and open browser
  const url = `http://localhost:${port}/session/${pmSessionId}`;
  console.log("🔗 正在打开 PM 对话界面...");
  console.log(`   ${url}`);

  openBrowser(url);
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
