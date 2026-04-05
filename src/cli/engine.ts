/**
 * Internal daemon entry point — launched by `start` after interactive setup.
 * Runs opencode server, sessions, and scheduler loop in the background.
 *
 * Usage: win-agent _engine <workspace>
 */
import fs from "node:fs";
import {
  writePidFile,
  removePidFile,
  getDbPath,
} from "../config/index.js";
import { openDb } from "../db/connection.js";
import { select as dbSelect, insert as dbInsert, rawQuery } from "../db/repository.js";
import { startOpencodeServer, removeServerInfo, type OpencodeServerHandle } from "../engine/opencode-server.js";
import { syncAgents, deployTools } from "../workspace/sync-agents.js";
import { SessionManager } from "../engine/session-manager.js";
import { getEmbeddingDimension } from "../embedding/index.js";
import { setEmbeddingDimension } from "../db/schema.js";
import { startSchedulerLoop, stopSchedulerLoop } from "../engine/scheduler.js";
import { detectModelContextLimit } from "../engine/memory-rotator.js";

let serverHandle: OpencodeServerHandle | null = null;
let sessionManager: SessionManager | null = null;

export function getServerHandle(): OpencodeServerHandle | null {
  return serverHandle;
}

export function getSessionManager(): SessionManager | null {
  return sessionManager;
}

export async function engineCommand(workspace: string) {
  // Write daemon PID
  writePidFile(workspace);

  // Open database
  setEmbeddingDimension(getEmbeddingDimension());
  const dbPath = getDbPath(workspace);
  openDb(dbPath);

  // Sync agents & tools (in case they changed)
  syncAgents(workspace);
  deployTools(workspace);

  // ── Start opencode server ──
  console.log("→ 启动 opencode server...");
  try {
    serverHandle = await startOpencodeServer(workspace);
    console.log(`✓ opencode server 已启动: ${serverHandle.url}`);
  } catch (err) {
    console.log(`❌ opencode server 启动失败: ${err}`);
    removePidFile(workspace);
    process.exit(1);
  }

  // ── Initialize sessions ──
  console.log("→ 初始化角色 Session...");
  sessionManager = new SessionManager(serverHandle.client, workspace);
  try {
    await sessionManager.initPersistentSessions();
    console.log("✓ PM Session 已创建");
  } catch (err) {
    console.log(`❌ Session 初始化失败: ${err}`);
    serverHandle.close();
    removePidFile(workspace);
    process.exit(1);
  }

  // ── Detect model context limit ──
  const contextLimit = await detectModelContextLimit(serverHandle.client);
  console.log(`✓ 模型 context 上限: ${contextLimit.toLocaleString()} tokens`);

  // Check memories and active workflows
  const memoryCount = rawQuery("SELECT COUNT(*) as cnt FROM memory")[0].cnt;
  if (memoryCount > 0) {
    console.log(`✓ 已回忆 ${memoryCount} 条近期记忆`);
  }

  const activeWorkflows = dbSelect("workflow_instances", { status: "active" });
  if (activeWorkflows.length > 0) {
    dbInsert("messages", {
      from_role: "system",
      to_role: "PM",
      type: "system",
      content: `引擎已重启恢复，有 ${activeWorkflows.length} 个工作流继续执行。`,
      status: "unread",
    });
    console.log(`△ 发现 ${activeWorkflows.length} 个活跃工作流，已通知 PM`);
  }

  // ── Onboarding check ──
  const onboardingDone = dbSelect("project_config", { key: "onboarding_completed" });
  if (onboardingDone.length === 0) {
    dbInsert("messages", {
      from_role: "system",
      to_role: "PM",
      type: "system",
      content: [
        "【Onboarding 模式】这是项目首次启动，请进入 Onboarding 流程：",
        "1. 向用户介绍团队 3 个角色（PM/DEV/QA）的定位和协作方式",
        "2. 逐个角色与用户讨论期望和偏好设定",
        "3. 讨论工作流偏好（MVP 优先 vs 一步到位、迭代节奏等）",
        "4. 完成后请写入 project_config: key='onboarding_completed', value='true'",
        "",
        "用户即将通过 `npx win-agent talk` 与你对话，请等待用户消息后开始引导。",
      ].join("\n"),
      status: "unread",
    });
    console.log("→ 已向 PM 发送 Onboarding 引导消息");
  }

  // Log engine start
  const projectName = dbSelect("project_config", { key: "projectName" })[0]?.value ?? "未命名";
  dbInsert("logs", {
    role: "system",
    action: "engine_start",
    content: `引擎启动 (PID: ${process.pid})，项目: ${projectName}`,
  });

  console.log(`🚀 引擎已启动 (PID: ${process.pid}), 项目: ${projectName}`);

  // ── Graceful shutdown ──
  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("🛑 收到终止信号，正在停止...");
    stopSchedulerLoop();
    try {
      if (sessionManager) {
        console.log("→ 保存角色记忆...");
        await sessionManager.writeAllMemories("engine_stop");
      }
    } catch (err) {
      console.error(`⚠️  记忆保存失败: ${err}`);
    }
    try {
      dbInsert("logs", {
        role: "system",
        action: "engine_stop",
        content: `引擎停止 (PID: ${process.pid})`,
      });
    } catch {}
    if (serverHandle?.owned) {
      try { serverHandle.close(); } catch {}
      removeServerInfo(workspace);
    }
    removePidFile(workspace);
    console.log("✅ 已安全退出");
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.on("uncaughtException", (err) => {
    if (shuttingDown) return;
    console.error(`❌ 未捕获异常: ${err}`);
  });
  process.on("unhandledRejection", (err) => {
    if (shuttingDown) return;
    console.error(`❌ 未处理的 Promise 拒绝: ${err}`);
  });

  // Start scheduler (blocks until stopped)
  await startSchedulerLoop(serverHandle.client, sessionManager, workspace);
}
