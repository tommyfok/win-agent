/**
 * Internal daemon entry point — launched by `start` after interactive setup.
 * Runs opencode server, sessions, and scheduler loop in the background.
 *
 * Usage: win-agent _engine <workspace>
 */
import fs from 'node:fs';
import path from 'node:path';
import { writePidFile, removePidFile, getDbPath } from '../config/index.js';
import { openDb } from '../db/connection.js';
import { select as dbSelect, insert as dbInsert, rawQuery } from '../db/repository.js';
import { MessageStatus } from '../db/types.js';
import {
  startOpencodeServer,
  removeServerInfo,
  type OpencodeServerHandle,
} from '../engine/opencode-server.js';
import { syncAgents, deployTools } from '../workspace/sync-agents.js';
import { SessionManager } from '../engine/session-manager.js';
import { getEmbeddingDimension } from '../embedding/index.js';
import { setEmbeddingDimension } from '../db/schema.js';
import {
  startSchedulerLoop,
  stopSchedulerLoop,
  abortCurrentDispatch,
} from '../engine/scheduler.js';
import { detectModelContextLimit } from '../engine/memory-rotator.js';
import { setSimilarityThreshold } from '../embedding/memory.js';

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
  const embeddingDim = getEmbeddingDimension();
  setEmbeddingDimension(embeddingDim);
  // Adjust similarity threshold based on embedding model dimension.
  // Default 0.3 is calibrated for local bge-small-zh-v1.5 (512-dim, L2 distance).
  // OpenAI text-embedding-3-small (1536-dim) produces cosine-normalized L2 distances
  // in [0, 2], requiring a higher threshold (~1.0) for meaningful filtering.
  if (embeddingDim === 1536) {
    setSimilarityThreshold(1.0);
  }
  const dbPath = getDbPath(workspace);
  openDb(dbPath);

  // Sync agents & tools (in case they changed)
  syncAgents(workspace);
  deployTools(workspace);

  // ── Start opencode server ──
  console.log('→ 启动 opencode server...');
  try {
    serverHandle = await startOpencodeServer(workspace);
    console.log(`✓ opencode server 已启动: ${serverHandle.url}`);
  } catch (err) {
    console.log(`❌ opencode server 启动失败: ${err}`);
    removePidFile(workspace);
    process.exit(1);
  }

  // ── Initialize sessions ──
  console.log('→ 初始化角色 Session...');
  sessionManager = new SessionManager(serverHandle.client, workspace);
  try {
    await sessionManager.initPersistentSessions();
    console.log('✓ PM Session 已就绪');
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
  const memoryCount = rawQuery('SELECT COUNT(*) as cnt FROM memory')[0].cnt;
  if (memoryCount ?? 0 > 0) {
    console.log(`✓ 已回忆 ${memoryCount} 条近期记忆`);
  }

  const activeWorkflows = dbSelect('workflow_instances', { status: 'active' });
  if (activeWorkflows.length > 0) {
    dbInsert('messages', {
      from_role: 'system',
      to_role: 'PM',
      type: 'system',
      content: `引擎已重启恢复，有 ${activeWorkflows.length} 个工作流继续执行。`,
      status: MessageStatus.Unread,
    });
    console.log(`△ 发现 ${activeWorkflows.length} 个活跃工作流，已通知 PM`);
  }

  // Log engine start
  const projectName = dbSelect('project_config', { key: 'projectName' })[0]?.value ?? '未命名';
  dbInsert('logs', {
    role: 'system',
    action: 'engine_start',
    content: `引擎启动 (PID: ${process.pid})，项目: ${projectName}`,
  });

  console.log(`🚀 引擎已启动 (PID: ${process.pid}), 项目: ${projectName}`);

  // ── Graceful shutdown ──
  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('🛑 收到终止信号，正在停止...');

    // 1. Abort current dispatch and persist interrupted context for resume
    const interruptedCtx = await abortCurrentDispatch();
    stopSchedulerLoop();

    if (interruptedCtx) {
      console.log(
        `→ 中断 ${interruptedCtx.role} 调度 (session: ${interruptedCtx.sessionId ?? 'unknown'})`
      );
      const interruptedFile = path.join(workspace, '.win-agent', 'interrupted.json');
      try {
        fs.writeFileSync(
          interruptedFile,
          JSON.stringify(
            {
              role: interruptedCtx.role,
              taskId: interruptedCtx.taskId,
              sessionId: interruptedCtx.sessionId,
              timestamp: new Date().toISOString(),
            },
            null,
            2
          ),
          'utf-8'
        );
        console.log(`→ 已保存中断状态到 interrupted.json`);
      } catch (err) {
        console.error(`⚠️  中断状态保存失败: ${err}`);
      }
    }

    // 2. Save memories for idle roles (skip the interrupted one — it was aborted mid-call)
    try {
      if (sessionManager) {
        console.log('→ 保存角色记忆...');
        await sessionManager.writeAllMemories('engine_stop');
      }
    } catch (err) {
      console.error(`⚠️  记忆保存失败: ${err}`);
    }
    try {
      dbInsert('logs', {
        role: 'system',
        action: 'engine_stop',
        content: `引擎停止 (PID: ${process.pid})${interruptedCtx ? `, 中断角色: ${interruptedCtx.role}` : ''}`,
      });
    } catch {
      /* empty */
    }
    if (serverHandle?.owned) {
      try {
        serverHandle.close();
      } catch {
        /* empty */
      }
      removeServerInfo(workspace);
    }
    removePidFile(workspace);
    console.log('✅ 已安全退出');
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('uncaughtException', (err) => {
    if (shuttingDown) return;
    console.error(`❌ 未捕获异常: ${err}`);
  });
  process.on('unhandledRejection', (err) => {
    if (shuttingDown) return;
    console.error(`❌ 未处理的 Promise 拒绝: ${err}`);
  });

  // Start scheduler (blocks until stopped)
  await startSchedulerLoop(serverHandle.client, sessionManager);
}
