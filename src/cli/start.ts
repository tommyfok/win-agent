import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { input, confirm } from "@inquirer/prompts";
import {
  checkEngineRunning,
  writePidFile,
  removePidFile,
  getDbPath,
} from "../config/index.js";
import { runEnvCheck } from "./check.js";
import { initWorkspace } from "../workspace/init.js";
import { openDb, closeDb } from "../db/connection.js";
import { select as dbSelect, insert as dbInsert } from "../db/repository.js";
import { syncAgents, deployTools } from "../workspace/sync-agents.js";
import { insertKnowledge } from "../embedding/knowledge.js";
import { getEmbeddingDimension } from "../embedding/index.js";
import { setEmbeddingDimension } from "../db/schema.js";

// Re-export for stop command compatibility
export { getServerHandle, getSessionManager } from "./engine.js";

export async function startCommand() {
  try {
    await _startCommand();
  } catch (err: any) {
    // inquirer throws ExitPromptError on Ctrl+C during prompts
    if (err?.name === "ExitPromptError" || err?.message?.includes("User force closed")) {
      console.log("\n👋 已取消");
      removePidFile();
      process.exit(0);
    }
    throw err;
  }
}

async function _startCommand() {
  // ── 1️⃣ 冲突检测 ──
  console.log("\n1️⃣  冲突检测");
  const { running, pid } = checkEngineRunning();
  if (running) {
    console.log(`   ⚠️  win-agent 已在运行中 (PID: ${pid})`);
    console.log("   如需重启，请先执行: npx win-agent stop");
    process.exit(1);
  }
  writePidFile();
  console.log(`   ✓ PID 锁文件已写入 (PID: ${process.pid})`);

  // ── 2️⃣ 环境检查 ──
  console.log("\n2️⃣  环境检查");
  const { workspace } = await runEnvCheck();

  // Set embedding dimension before DB init (affects vector table schema)
  setEmbeddingDimension(getEmbeddingDimension());

  // ── 3️⃣ 工作空间初始化 ──
  console.log("\n3️⃣  工作空间初始化");
  const initResult = initWorkspace(workspace);
  if (initResult.created) {
    console.log("   ✓ 工作空间已创建");
    console.log("     .win-agent/");
    console.log("     ├── win-agent.db");
    console.log("     ├── roles/");
    console.log("     ├── workflows/");
    console.log("     ├── attachments/");
    console.log("     └── backups/");
  } else if (initResult.patched.length > 0) {
    console.log(`   △ 已补建缺失的表: ${initResult.patched.join(", ")}`);
  } else {
    console.log("   ✓ 工作空间已存在，数据库表完整");
  }

  // Ensure DB is open (initWorkspace already opens it, but be safe)
  const dbPath = getDbPath(workspace);
  try {
    // getDb() would throw if not open; initWorkspace already called openDb
  } catch {
    openDb(dbPath);
  }

  // Sync agent configs and deploy tools
  console.log("   → Agent 配置同步...");
  const synced = syncAgents(workspace);
  console.log(`   ✓ ${synced.length} 个角色已同步到 .opencode/agents/`);
  deployTools(workspace);
  console.log("   ✓ 数据库工具已部署到 .opencode/tools/");

  // ── 4️⃣ 首次启动引导 ──
  console.log("\n4️⃣  首次启动引导");
  const projectNameRows = dbSelect("project_config", { key: "projectName" });

  if (projectNameRows.length === 0) {
    // First time — ask for project info
    const projectName = await input({
      message: "请输入项目名称",
    });
    const projectDescription = await input({
      message: "请简要描述项目目标",
    });

    dbInsert("project_config", { key: "projectName", value: projectName });
    dbInsert("project_config", { key: "projectDescription", value: projectDescription });

    console.log(`   ✓ 项目信息已保存: ${projectName}`);

    // ── 5️⃣ 项目上下文导入（仅新项目） ──
    await importProjectContext(workspace);
  } else {
    const name = projectNameRows[0].value;
    console.log(`   ✓ 已有项目: ${name}`);
    console.log("\n5️⃣  项目上下文导入");
    console.log("   ⏭  已有项目，跳过");
  }

  // ── 6️⃣ 启动后台引擎 ──
  console.log("\n6️⃣  启动后台引擎");

  const projectName = dbSelect("project_config", { key: "projectName" })[0]?.value ?? "未命名";

  // Close DB before spawning daemon (daemon will open its own connection)
  closeDb();

  // Spawn daemon process with output to log file
  const logFile = path.join(workspace, ".win-agent", "engine.log");
  const logFd = fs.openSync(logFile, "a");

  // Find the win-agent bin path (could be npx or direct)
  const binPath = process.argv[1];
  const child = spawn(process.execPath, [binPath, "_engine", workspace], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  if (!child.pid) {
    console.log("   ❌ 后台引擎启动失败");
    removePidFile();
    fs.closeSync(logFd);
    process.exit(1);
  }

  // Write daemon PID to lock file
  writePidFile(workspace, child.pid);
  child.unref();
  fs.closeSync(logFd);

  console.log(`   ✓ 引擎已在后台启动 (PID: ${child.pid})`);
  console.log(`\n🚀 win-agent 已启动`);
  console.log(`   项目: ${projectName}`);
  console.log(`   工作空间: ${workspace}`);
  console.log(`   日志: .win-agent/engine.log`);
  console.log("   输入 npx win-agent talk  打开与产品经理的对话页面");
  console.log("   输入 npx win-agent stop  停止引擎");
}

/**
 * 项目上下文导入（阶段 5️⃣）
 * a) 已有代码扫描
 * b) 参考资料导入
 * c) 技术约束声明
 */
async function importProjectContext(workspace: string) {
  console.log("\n5️⃣  项目上下文导入");

  let knowledgeCount = 0;

  // a) 已有代码扫描
  const hasCode = detectExistingCode(workspace);
  if (hasCode) {
    const doScan = await confirm({
      message: "检测到已有代码，是否扫描项目结构？",
      default: true,
    });
    if (doScan) {
      // TODO: 阶段 3 — 调用 SA session 扫描代码生成技术概览
      console.log("   ⏳ 代码扫描将在 opencode SDK 集成后启用");
    }
  } else {
    console.log("   a) 空目录，跳过代码扫描");
  }

  // b) 参考资料导入
  const doImport = await confirm({
    message: "是否导入参考资料（设计稿、PRD、API文档等）？",
    default: false,
  });
  if (doImport) {
    const refDir = await input({
      message: "请输入资料目录路径（或拖入文件）",
    });
    const resolvedDir = path.resolve(refDir.trim());
    if (fs.existsSync(resolvedDir) && fs.statSync(resolvedDir).isDirectory()) {
      knowledgeCount += await importReferenceDir(resolvedDir, workspace);
    } else {
      console.log(`   ⚠️  目录不存在: ${resolvedDir}`);
    }
  }

  // c) 技术约束声明
  const doConstraints = await confirm({
    message: "是否声明技术约束？",
    default: false,
  });
  if (doConstraints) {
    const deployEnv = await input({ message: "目标部署环境 (留空跳过)", default: "" });
    const requiredTech = await input({ message: "必须使用的技术/框架 (留空跳过)", default: "" });
    const forbiddenTech = await input({ message: "禁止使用的技术/框架 (留空跳过)", default: "" });
    const otherConstraints = await input({ message: "其他约束 (留空跳过)", default: "" });

    const constraints: Record<string, string> = {};
    if (deployEnv) constraints.deployEnv = deployEnv;
    if (requiredTech) constraints.requiredTech = requiredTech;
    if (forbiddenTech) constraints.forbiddenTech = forbiddenTech;
    if (otherConstraints) constraints.other = otherConstraints;

    if (Object.keys(constraints).length > 0) {
      // Write to project_config
      dbInsert("project_config", {
        key: "constraints",
        value: JSON.stringify(constraints),
      });

      // Write to knowledge table
      const parts: string[] = [];
      if (deployEnv) parts.push(`- 部署环境: ${deployEnv}`);
      if (requiredTech) parts.push(`- 必须使用: ${requiredTech}`);
      if (forbiddenTech) parts.push(`- 禁止使用: ${forbiddenTech}`);
      if (otherConstraints) parts.push(`- 其他约束: ${otherConstraints}`);

      await insertKnowledge({
        title: "技术约束",
        content: parts.join("\n"),
        category: "convention",
        tags: "constraints",
        created_by: "system",
      });
      knowledgeCount++;
      console.log(`   ✓ ${Object.keys(constraints).length} 条约束已记录`);
    }
  }

  // Summary
  if (knowledgeCount > 0) {
    console.log(`\n   📦 项目上下文导入完成`);
    console.log(`      知识库: ${knowledgeCount} 条记录已写入`);
  } else {
    console.log("\n   📦 项目上下文导入完成（无新记录）");
  }
}

/**
 * Detect if workspace has existing code files (beyond .win-agent/).
 */
function detectExistingCode(workspace: string): boolean {
  const entries = fs.readdirSync(workspace);
  const codeIndicators = [
    "package.json", "tsconfig.json", "Cargo.toml", "go.mod",
    "pom.xml", "build.gradle", "requirements.txt", "pyproject.toml",
    "Makefile", "CMakeLists.txt", "src", "lib", "app",
  ];
  return entries.some(
    (e) => codeIndicators.includes(e) || e.endsWith(".ts") || e.endsWith(".js") || e.endsWith(".py")
  );
}

/**
 * Import reference materials from a directory into knowledge table.
 */
async function importReferenceDir(refDir: string, workspace: string): Promise<number> {
  const TEXT_EXTS = new Set([".md", ".txt", ".rst", ".html", ".json", ".yaml", ".yml", ".xml"]);
  const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

  let count = 0;
  const entries = fs.readdirSync(refDir, { withFileTypes: true });
  const attachDir = path.join(workspace, ".win-agent", "attachments");

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const filePath = path.join(refDir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();

    if (TEXT_EXTS.has(ext)) {
      // Read text content directly
      const content = fs.readFileSync(filePath, "utf-8");
      await insertKnowledge({
        title: entry.name,
        content,
        category: "reference",
        tags: `imported,${ext.slice(1)}`,
        created_by: "system",
      });
      count++;
      console.log(`   ✓ 导入文本: ${entry.name}`);
    } else if (IMAGE_EXTS.has(ext)) {
      // Copy image to attachments
      const destPath = path.join(attachDir, entry.name);
      fs.copyFileSync(filePath, destPath);
      await insertKnowledge({
        title: entry.name,
        content: `[图片] .win-agent/attachments/${entry.name}`,
        category: "reference",
        tags: `imported,image,${ext.slice(1)}`,
        created_by: "system",
      });
      count++;
      console.log(`   ✓ 导入图片: ${entry.name}`);
    } else {
      // Copy other files to attachments
      const destPath = path.join(attachDir, entry.name);
      fs.copyFileSync(filePath, destPath);
      await insertKnowledge({
        title: entry.name,
        content: `[附件] .win-agent/attachments/${entry.name}`,
        category: "reference",
        tags: `imported,attachment,${ext.slice(1)}`,
        created_by: "system",
      });
      count++;
      console.log(`   ✓ 导入附件: ${entry.name}`);
    }
  }

  return count;
}
