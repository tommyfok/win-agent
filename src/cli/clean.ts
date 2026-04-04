import fs from "node:fs";
import path from "node:path";
import { confirm } from "@inquirer/prompts";
import { loadConfig } from "../config/index.js";
import { startOpencodeServer } from "../engine/opencode-server.js";

export async function cleanCommand() {
  try {
    await _cleanCommand();
  } catch (err: any) {
    if (err?.name === "ExitPromptError" || err?.message?.includes("User force closed")) {
      console.log("\n👋 已取消");
      process.exit(0);
    }
    throw err;
  }
}

async function _cleanCommand() {
  const cwd = process.cwd();
  const winAgentDir = path.join(cwd, ".win-agent");

  if (!fs.existsSync(winAgentDir)) {
    console.log("当前目录下没有 .win-agent 目录，无需清理。");
    return;
  }

  // Read workspace ID before deleting config
  const config = loadConfig(cwd);
  const wsId = config.workspaceId;
  const sessionPrefix = wsId ? `wa-${wsId}` : null;

  console.log("\n将清理以下内容：");
  console.log(`  - ${winAgentDir}/`);
  if (sessionPrefix) {
    console.log(`  - opencode 中 ${sessionPrefix}-* 相关 session`);
  }

  const ok = await confirm({ message: "确认删除？此操作不可恢复", default: false });
  if (!ok) {
    console.log("已取消。");
    return;
  }

  // Clean opencode sessions if we have a workspace ID
  if (sessionPrefix) {
    await cleanOpencodeSessionsQuietly(cwd, sessionPrefix);
  }

  // Delete .win-agent directory
  fs.rmSync(winAgentDir, { recursive: true, force: true });
  console.log("  ✓ 已删除 .win-agent/");

  console.log("\n✅ 清理完成");
}

/**
 * Start a temporary opencode server, delete sessions matching prefix, then shut down.
 */
async function cleanOpencodeSessionsQuietly(workspace: string, prefix: string): Promise<void> {
  let handle: { client: any; close: () => void } | null = null;
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
        } catch { /* ignore */ }
      }
    }
    if (deleted > 0) {
      console.log(`  ✓ 已清理 ${deleted} 个 opencode session`);
    } else {
      console.log("  ✓ 无残留 opencode session");
    }
  } catch {
    console.log("  ⚠️  opencode session 清理跳过（服务启动失败）");
  } finally {
    try { handle?.close(); } catch {}
  }
}
