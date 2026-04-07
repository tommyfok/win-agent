import fs from "node:fs";
import path from "node:path";
import { input, confirm } from "@inquirer/prompts";
import { runEnvCheck } from "./check.js";
import { initWorkspace } from "../workspace/init.js";
import { openDb, closeDb, getDb } from "../db/connection.js";
import { select as dbSelect, insert as dbInsert, update as dbUpdate } from "../db/repository.js";
import {
  syncAgents,
  deployTools,
  installDefaultSkills,
  DEFAULT_SKILLS,
  getSkillDirName,
} from "../workspace/sync-agents.js";
import { insertKnowledge } from "../embedding/knowledge.js";
import { getEmbeddingDimension } from "../embedding/index.js";
import { setEmbeddingDimension } from "../db/schema.js";
import { getDbPath } from "../config/index.js";
import { startOpencodeServer, removeServerInfo } from "../engine/opencode-server.js";

const WORKSPACE_ANALYSIS_PROMPT = `请分析当前工作空间，生成一份项目技术概览文档。

使用 glob 和 read 工具扫描项目结构，重点了解：
1. 项目类型和主要技术栈
2. 目录结构和关键文件
3. 主要模块/功能划分
4. 依赖和配置情况

请直接输出 Markdown 格式的概览文档，包含以下章节：
## 技术栈
## 目录结构（关键路径）
## 主要模块
## 开发规范（如有 lint/test/build 配置）

只输出文档内容，不需要额外解释。`;

export async function onboardingCommand() {
  try {
    await _onboardingCommand();
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.name === "ExitPromptError" || err.message?.includes("User force closed"))
    ) {
      console.log("\n👋 已取消");
      process.exit(0);
    }
    throw err;
  }
}

async function _onboardingCommand() {
  // ── 1️⃣ 环境检查 ──
  console.log("\n1️⃣  环境检查");
  const { workspace } = await runEnvCheck();
  setEmbeddingDimension(getEmbeddingDimension());

  // ── 2️⃣ 工作空间初始化 ──
  console.log("\n2️⃣  工作空间初始化");
  const initResult = initWorkspace(workspace);
  if (initResult.created) {
    console.log("   ✓ 工作空间已创建");
  } else {
    console.log("   ✓ 工作空间已存在");
  }

  const dbPath = getDbPath(workspace);
  try {
    getDb();
  } catch {
    openDb(dbPath);
  }

  // ── 3️⃣ 幂等检查 ──
  const alreadyDone = dbSelect<{ key: string; value: string }>("project_config", { key: "onboarding_completed" });
  if (alreadyDone.length > 0) {
    const rerun = await confirm({ message: "Onboarding 已完成过，是否重新运行？", default: false });
    if (!rerun) {
      console.log("   已跳过");
      closeDb();
      return;
    }
  }

  // ── 4️⃣ 项目信息 ──
  console.log("\n4️⃣  项目信息");
  const existingName = dbSelect<{ key: string; value: string }>("project_config", { key: "projectName" })[0]?.value ?? "";
  const existingDesc = dbSelect<{ key: string; value: string }>("project_config", { key: "projectDescription" })[0]?.value ?? "";

  const projectName = await input({ message: "项目名称", default: existingName });
  const projectDescription = await input({ message: "项目描述", default: existingDesc });

  if (existingName) {
    dbUpdate("project_config", { key: "projectName" }, { value: projectName });
    dbUpdate("project_config", { key: "projectDescription" }, { value: projectDescription });
  } else {
    dbInsert("project_config", { key: "projectName", value: projectName });
    dbInsert("project_config", { key: "projectDescription", value: projectDescription });
  }
  console.log("   ✓ 已保存");

  // ── 5️⃣ 项目上下文导入 ──
  await importProjectContext(workspace);

  // ── 6️⃣ 同步角色配置（分析前需先有 .opencode/agents/） ──
  console.log("\n6️⃣  同步角色配置");
  syncAgents(workspace);
  deployTools(workspace);
  console.log("   ✓ 完成");

  // ── 6.5 安装默认 Skill ──
  console.log("\n   安装默认 Skill");
  for (const s of DEFAULT_SKILLS) {
    const roles = s.roles.join(", ");
    console.log(`   · ${getSkillDirName(s.pkg)}  (${roles})`);
  }
  const installSkills = await confirm({ message: "   安装以上 skill？", default: true });
  if (installSkills) {
    installDefaultSkills(workspace);
  } else {
    console.log("   已跳过");
  }

  // ── 7️⃣ 工作空间分析 ──
  console.log("\n7️⃣  工作空间分析（AI 扫描项目结构）");
  let overview = "";
  let serverHandle: Awaited<ReturnType<typeof startOpencodeServer>> | null = null;
  if (!detectExistingCode(workspace)) {
    console.log("   空目录，跳过");
  } else
    try {
      serverHandle = await startOpencodeServer(workspace);
      const { client } = serverHandle;

      const session = await client.session.create({ body: { title: "wa-onboarding-analyst" } });
      const sessionId = session.data!.id;

      console.log("   → 分析中，请稍候...");
      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: "PM",
          parts: [{ type: "text", text: WORKSPACE_ANALYSIS_PROMPT }],
        },
      });

      const textParts = result.data?.parts?.filter(
        (p): p is Extract<typeof p, { type: "text" }> => p.type === "text"
      );
      overview = textParts?.map((p) => p.text).join("\n") ?? "";

      const overviewPath = path.join(workspace, ".win-agent", "overview.md");
      fs.writeFileSync(
        overviewPath,
        `# 项目概览\n\n_由 \`win-agent onboard\` 自动生成_\n\n${overview}`,
        "utf-8"
      );
      console.log("   ✓ 已写入 .win-agent/overview.md");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "INSTALL_FAILED") {
        throw err;
      }
      console.log(`   ⚠️  工作空间分析失败，跳过: ${err}`);
    } finally {
      if (serverHandle?.owned) {
        serverHandle.close();
        removeServerInfo(workspace);
      }
    }

  // ── 8️⃣ 注入项目上下文到角色文件 ──
  console.log("\n8️⃣  更新角色文件");
  injectProjectContext(workspace, projectName, projectDescription);
  syncAgents(workspace); // re-sync after injection
  console.log("   ✓ 完成");

  // ── 完成 ──
  // Snapshot role file mtimes so `start` can detect user edits
  snapshotRoleMtimes(workspace);

  if (alreadyDone.length === 0) {
    dbInsert("project_config", { key: "onboarding_completed", value: "true" });
  }
  closeDb();

  console.log("\n✅ Onboarding 完成");
  console.log(`   项目: ${projectName}`);
  if (overview) console.log("   概览: .win-agent/overview.md");
  console.log("   角色: .win-agent/roles/  （可直接编辑，重启后对 PM 生效）");
  console.log("\n提示：需要 MCP 工具请在下次启动前配置好，Agent 运行时无法自行安装");
  console.log("就绪后执行：npx win-agent start");
}

// ─── 项目上下文导入 ───────────────────────────────────────────────────────────

async function importProjectContext(workspace: string) {
  console.log("\n5️⃣  项目上下文导入");

  let knowledgeCount = 0;

  const hasCode = detectExistingCode(workspace);
  if (!hasCode) {
    console.log("   a) 空目录，跳过代码扫描");
  }

  const doImport = await confirm({
    message: "导入参考资料（设计稿、PRD、API 文档等）？",
    default: false,
  });
  if (doImport) {
    const refDir = await input({ message: "资料目录路径" });
    const resolved = path.resolve(refDir.trim());
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      knowledgeCount += await importReferenceDir(resolved, workspace);
    } else {
      console.log(`   ⚠️  目录不存在: ${resolved}`);
    }
  }

  const doConstraints = await confirm({ message: "声明技术约束？", default: false });
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
      dbInsert("project_config", { key: "constraints", value: JSON.stringify(constraints) });
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

  if (knowledgeCount > 0) {
    console.log(`   📦 知识库: ${knowledgeCount} 条记录已写入`);
  } else {
    console.log("   📦 完成（无新记录）");
  }
}

function detectExistingCode(workspace: string): boolean {
  const entries = fs.readdirSync(workspace);
  const indicators = [
    "package.json",
    "tsconfig.json",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "requirements.txt",
    "pyproject.toml",
    "Makefile",
    "CMakeLists.txt",
    "src",
    "lib",
    "app",
  ];
  return entries.some(
    (e) => indicators.includes(e) || e.endsWith(".ts") || e.endsWith(".js") || e.endsWith(".py")
  );
}

async function importReferenceDir(refDir: string, workspace: string): Promise<number> {
  const TEXT_EXTS = new Set([".md", ".txt", ".rst", ".html", ".json", ".yaml", ".yml", ".xml"]);
  const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
  const attachDir = path.join(workspace, ".win-agent", "attachments");

  let count = 0;
  for (const entry of fs.readdirSync(refDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const filePath = path.join(refDir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();

    if (TEXT_EXTS.has(ext)) {
      await insertKnowledge({
        title: entry.name,
        content: fs.readFileSync(filePath, "utf-8"),
        category: "reference",
        tags: `imported,${ext.slice(1)}`,
        created_by: "system",
      });
      console.log(`   ✓ 导入文本: ${entry.name}`);
    } else {
      fs.copyFileSync(filePath, path.join(attachDir, entry.name));
      await insertKnowledge({
        title: entry.name,
        content: `[${IMAGE_EXTS.has(ext) ? "图片" : "附件"}] .win-agent/attachments/${entry.name}`,
        category: "reference",
        tags: `imported,${IMAGE_EXTS.has(ext) ? "image," : "attachment,"}${ext.slice(1)}`,
        created_by: "system",
      });
      console.log(`   ✓ 导入${IMAGE_EXTS.has(ext) ? "图片" : "附件"}: ${entry.name}`);
    }
    count++;
  }
  return count;
}

// ─── Mtime 快照 ───────────────────────────────────────────────────────────────

export function snapshotRoleMtimes(workspace: string): void {
  const rolesDir = path.join(workspace, ".win-agent", "roles");
  if (!fs.existsSync(rolesDir)) return;
  const snapshot: Record<string, number> = {};
  for (const file of fs.readdirSync(rolesDir)) {
    if (!file.endsWith(".md")) continue;
    snapshot[file] = fs.statSync(path.join(rolesDir, file)).mtimeMs;
  }
  const existing = dbSelect<{ key: string; value: string }>("project_config", { key: "role_mtimes_snapshot" });
  if (existing.length > 0) {
    dbUpdate(
      "project_config",
      { key: "role_mtimes_snapshot" },
      { value: JSON.stringify(snapshot) }
    );
  } else {
    dbInsert("project_config", { key: "role_mtimes_snapshot", value: JSON.stringify(snapshot) });
  }
}

// ─── 角色文件上下文注入 ────────────────────────────────────────────────────────

function injectProjectContext(workspace: string, projectName: string, projectDescription: string) {
  const rolesDir = path.join(workspace, ".win-agent", "roles");
  if (!fs.existsSync(rolesDir)) return;

  const block = [
    "<!-- win-agent:project-context -->",
    "## 项目背景",
    `- **项目名称**: ${projectName}`,
    `- **项目描述**: ${projectDescription}`,
    "- **技术概览**: 详见 `.win-agent/overview.md`",
    "<!-- /win-agent:project-context -->",
    "",
  ].join("\n");

  const sentinel =
    /<!-- win-agent:project-context -->[\s\S]*?<!-- \/win-agent:project-context -->\n?/;

  for (const file of fs.readdirSync(rolesDir)) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(rolesDir, file);
    let content = fs.readFileSync(filePath, "utf-8");
    if (sentinel.test(content)) {
      content = content.replace(sentinel, block);
    } else {
      const firstNewline = content.indexOf("\n") + 1;
      content = content.slice(0, firstNewline) + "\n" + block + content.slice(firstNewline);
    }
    fs.writeFileSync(filePath, content, "utf-8");
    console.log(`   ✓ ${file}`);
  }
}
