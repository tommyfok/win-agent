import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function logCommand() {
  const workspace = process.cwd();
  const logFile = path.join(workspace, ".win-agent", "engine.log");

  if (!fs.existsSync(logFile)) {
    console.log("⚠️  日志文件不存在，引擎可能尚未启动过");
    console.log(`   路径: ${logFile}`);
    process.exit(1);
  }

  console.log(`📋 实时日志: ${logFile}`);
  console.log("   按 Ctrl+C 退出\n");

  const tail = spawn("tail", ["-f", logFile], { stdio: "inherit" });

  tail.on("error", (err) => {
    console.error(`❌ 无法执行 tail: ${err.message}`);
    process.exit(1);
  });

  tail.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
