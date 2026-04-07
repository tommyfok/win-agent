import fs from "node:fs";
import path from "node:path";
import { confirm } from "@inquirer/prompts";
import { loadConfig } from "../config/index.js";
import { DEFAULT_SKILLS, getSkillDirName } from "../workspace/sync-agents.js";
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

  const opencodeDir = path.join(cwd, ".opencode");

  const skillNames = DEFAULT_SKILLS.map((s) => getSkillDirName(s.pkg)).join(", ");
  console.log("\n将清理以下内容：");
  console.log(`  - ${winAgentDir}/`);
  console.log(`  - .opencode/agents/{PM,DEV,QA}.md`);
  console.log(`  - .opencode/tools/database_{PM,DEV,QA}.ts`);
  console.log(`  - .opencode/skills/{${skillNames}}`);
  console.log(`  - .opencode/opencode.json 中的 permission 字段`);
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

  // Clean only win-agent-managed files in .opencode/
  cleanOpencodeFiles(opencodeDir);

  console.log("\n✅ 清理完成");
}

/**
 * Remove only win-agent-managed files from .opencode/.
 * Deletes agents, tools, and the permission key in opencode.json.
 * Removes empty directories but leaves .opencode/ itself if other files remain.
 */
function cleanOpencodeFiles(opencodeDir: string): void {
  if (!fs.existsSync(opencodeDir)) return;

  // 1. Remove agent files
  const agentsDir = path.join(opencodeDir, "agents");
  for (const role of ["PM", "DEV", "QA"]) {
    const f = path.join(agentsDir, `${role}.md`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  removeIfEmpty(agentsDir);

  // 2. Remove tool files
  const toolsDir = path.join(opencodeDir, "tools");
  for (const role of ["PM", "DEV", "QA"]) {
    const f = path.join(toolsDir, `database_${role}.ts`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  // Legacy shared tool file
  const legacy = path.join(toolsDir, "database.ts");
  if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  removeIfEmpty(toolsDir);

  // 3. Remove win-agent-managed skill directories
  const skillsDir = path.join(opencodeDir, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const skill of DEFAULT_SKILLS) {
      const skillDir = path.join(skillsDir, getSkillDirName(skill.pkg));
      if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });
    }
    removeIfEmpty(skillsDir);
  }

  // 4. Remove permission key from opencode.json
  const configFile = path.join(opencodeDir, "opencode.json");
  if (fs.existsSync(configFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      delete cfg.permission;
      if (Object.keys(cfg).length === 0) {
        fs.unlinkSync(configFile);
      } else {
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), "utf-8");
      }
    } catch { /* leave file untouched if parse fails */ }
  }

  removeIfEmpty(opencodeDir);
  console.log("  ✓ 已清理 .opencode/ 中的 win-agent 文件");
}

function removeIfEmpty(dir: string): void {
  if (!fs.existsSync(dir)) return;
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
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
