import { stopCommand } from "./stop.js";
import { startCommand } from "./start.js";
import { talkCommand } from "./talk.js";

export async function restartCommand() {
  // 1. Stop
  await stopCommand();

  // 2. Start
  await startCommand();

  // 3. Wait 10s for engine to initialize before opening talk
  console.log("\n⏳ 等待引擎初始化 (10s)...");
  await new Promise((r) => setTimeout(r, 10000));

  // 4. Talk
  await talkCommand();
}
