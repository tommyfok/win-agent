import { exec } from "node:child_process";
import { platform } from "node:os";
import { checkEngineRunning } from "../config/index.js";

export async function talkCommand() {
  // 1. Check engine is running
  const { running, pid } = checkEngineRunning();
  if (!running) {
    console.log("⚠️  win-agent 未运行");
    console.log("   请先执行: npx win-agent start");
    process.exit(1);
  }

  // 2. Get PM session ID
  // TODO: 阶段 3 — 从 SessionManager 获取 PM 的 session ID
  // For now, use a placeholder
  const port = 4096;
  const pmSessionId = "pm-session-placeholder";

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
