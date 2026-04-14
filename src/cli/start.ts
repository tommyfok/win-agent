import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkEngineRunning, writePidFile, removePidFile, getDbPath } from '../config/index.js';
import { runEnvCheck } from './check.js';
import { initWorkspace } from '../workspace/init.js';
import { openDb, closeDb, getDb } from '../db/connection.js';
import { select as dbSelect, insert as dbInsert } from '../db/repository.js';
import { syncAgents } from '../workspace/sync-agents.js';
import { getEmbeddingDimension } from '../embedding/index.js';
import { setEmbeddingDimension } from '../db/schema.js';
import { hasTodoMarkers } from './init.js';

// Re-export for stop command compatibility
export { getServerHandle, getSessionManager } from './engine.js';

export async function startCommand(options?: { log?: boolean }) {
  try {
    await _startCommand(options?.log ?? false);
  } catch (err: unknown) {
    // inquirer throws ExitPromptError on Ctrl+C during prompts
    if (
      err instanceof Error &&
      (err.name === 'ExitPromptError' || err.message?.includes('User force closed'))
    ) {
      console.log('\n👋 已取消');
      removePidFile();
      process.exit(0);
    }
    throw err;
  }
}

async function _startCommand(tailLog: boolean = false) {
  // ── 1️⃣ 冲突检测 ──
  console.log('\n1️⃣  冲突检测');
  const { running, pid } = checkEngineRunning();
  if (running) {
    console.log(`   ⚠️  win-agent 已在运行中 (PID: ${pid})`);
    console.log('   如需重启，请先执行: npx win-agent stop');
    process.exit(1);
  }
  writePidFile();
  console.log(`   ✓ PID 锁文件已写入 (PID: ${process.pid})`);

  // ── 2️⃣ 环境检查 ──
  console.log('\n2️⃣  环境检查');
  const { workspace } = await runEnvCheck();

  // Set embedding dimension before DB init (affects vector table schema)
  setEmbeddingDimension(getEmbeddingDimension());

  // ── 3️⃣ 工作空间初始化 ──
  console.log('\n3️⃣  工作空间初始化');
  const initResult = initWorkspace(workspace);
  if (initResult.created) {
    console.log('   ✓ 工作空间已创建');
    console.log('     .win-agent/');
    console.log('     ├── win-agent.db');
    console.log('     ├── roles/');
    console.log('     ├── attachments/');
    console.log('     └── backups/');
  } else if (initResult.patched.length > 0) {
    console.log(`   △ 已补建缺失的表: ${initResult.patched.join(', ')}`);
  } else {
    console.log('   ✓ 工作空间已存在，数据库表完整');
  }

  // Ensure DB is open (initWorkspace already opens it, but be safe)
  const dbPath = getDbPath(workspace);
  try {
    getDb();
  } catch {
    openDb(dbPath);
  }

  // Validate role prompts
  console.log('   → 角色配置验证...');
  const synced = syncAgents(workspace);
  console.log(`   ✓ ${synced.length} 个角色已验证`);

  // ── 4️⃣ 前置检查 ──
  const onboardDone = dbSelect<{ key: string; value: string }>('project_config', {
    key: 'onboarding_completed',
  });
  if (onboardDone.length === 0) {
    console.log('\n❌ 请先执行 init 命令完成项目初始化：');
    console.log('   npx win-agent init');
    removePidFile();
    process.exit(1);
  }
  await checkRoleFilesReviewed(workspace);

  // ── 5️⃣ 启动后台引擎 ──
  console.log('\n5️⃣  启动后台引擎');

  const projectName =
    dbSelect<{ key: string; value: string }>('project_config', { key: 'projectName' })[0]?.value ??
    '未命名';

  // Mark first start as done (must be before closeDb)
  const alreadyInvoked = dbSelect<{ key: string; value: string }>('project_config', {
    key: 'start_invoked',
  });
  if (alreadyInvoked.length === 0) {
    dbInsert('project_config', { key: 'start_invoked', value: 'true' });
  }

  // Close DB before spawning daemon (daemon will open its own connection)
  closeDb();

  // Spawn daemon process with output to log file
  const logFile = path.join(workspace, '.win-agent', 'engine.log');
  const logFd = fs.openSync(logFile, 'a');

  // Find the win-agent bin path (could be npx or direct)
  const binPath = process.argv[1];
  const child = spawn(process.execPath, [binPath, '_engine', workspace], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });

  if (!child.pid) {
    console.log('   ❌ 后台引擎启动失败');
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
  console.log('   输入 npx win-agent talk  打开与产品经理的对话页面');
  console.log('   输入 npx win-agent stop  停止引擎');

  if (tailLog) {
    const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
    tail.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  }
}

/**
 * On first start, compare current role file mtimes against the snapshot saved by
 * `init`. Files that haven't changed since init = not yet reviewed by user.
 * Warns and requires confirmation before proceeding.
 */
async function checkRoleFilesReviewed(workspace: string): Promise<void> {
  // Only run on first invocation
  const invoked = dbSelect<{ key: string; value: string }>('project_config', {
    key: 'start_invoked',
  });
  if (invoked.length > 0) return;

  const snapshotRow = dbSelect<{ key: string; value: string }>('project_config', {
    key: 'role_mtimes_snapshot',
  });
  if (snapshotRow.length === 0) return; // no snapshot (init not run), skip

  // Detect project mode: greenfield/pending only check role files, skip docs
  const modeRow = dbSelect<{ key: string; value: string }>('project_config', {
    key: 'project_mode',
  });
  const projectMode = modeRow.length > 0 ? modeRow[0].value : 'existing';
  const skipDocsCheck = projectMode === 'greenfield' || projectMode === 'pending';

  const snapshot: Record<string, number> = JSON.parse(snapshotRow[0].value);
  const rolesDir = path.join(workspace, '.win-agent', 'roles');
  const unmodified: string[] = [];

  for (const [file, snapshotMtime] of Object.entries(snapshot)) {
    const filePath = path.join(rolesDir, file);
    if (!fs.existsSync(filePath)) continue;
    const currentMtime = fs.statSync(filePath).mtimeMs;
    if (currentMtime === snapshotMtime) unmodified.push(file);
  }

  // Check overview.md (skip for greenfield/pending — it's a placeholder)
  let overviewUnmodified = false;
  if (!skipDocsCheck) {
    const overviewSnapshotRow = dbSelect<{ key: string; value: string }>('project_config', {
      key: 'overview_mtime_snapshot',
    });
    if (overviewSnapshotRow.length > 0) {
      const overviewPath = path.join(workspace, '.win-agent', 'docs', 'overview.md');
      if (fs.existsSync(overviewPath)) {
        const currentMtime = fs.statSync(overviewPath).mtimeMs;
        if (currentMtime === Number(overviewSnapshotRow[0].value)) {
          overviewUnmodified = true;
        }
      }
    }
  }

  // Check docs rule files (skip for greenfield/pending — they are placeholders)
  const docsUnmodified: string[] = [];
  const docsWithTodos: string[] = [];
  if (!skipDocsCheck) {
    const docsSnapshotRow = dbSelect<{ key: string; value: string }>('project_config', {
      key: 'docs_mtimes_snapshot',
    });
    if (docsSnapshotRow.length > 0) {
      const docsSnapshot: Record<string, number> = JSON.parse(docsSnapshotRow[0].value);
      const docsDir = path.join(workspace, '.win-agent', 'docs');
      for (const [file, snapshotMtime] of Object.entries(docsSnapshot)) {
        const filePath = path.join(docsDir, file);
        if (!fs.existsSync(filePath)) continue;
        const currentMtime = fs.statSync(filePath).mtimeMs;
        if (currentMtime === snapshotMtime) docsUnmodified.push(file);
      }
    }

    // Check for TODO markers in docs files (even if mtime changed, TODOs mean incomplete)
    const docsDir = path.join(workspace, '.win-agent', 'docs');
    for (const file of ['development.md', 'validation.md']) {
      const filePath = path.join(docsDir, file);
      if (docsUnmodified.includes(file)) continue; // already flagged as unmodified
      if (hasTodoMarkers(filePath)) docsWithTodos.push(file);
    }
  }

  // Non-essential files (roles, overview): suggest but don't block
  const hasSuggestions = unmodified.length > 0 || overviewUnmodified;
  if (hasSuggestions) {
    console.log('\n💡 以下文件自 init 后未经修改，建议根据项目实际情况审阅（不影响启动）：');
    for (const file of unmodified) {
      console.log(`   • .win-agent/roles/${file}`);
    }
    if (overviewUnmodified) {
      console.log('   • .win-agent/docs/overview.md');
    }
  }

  // Essential files (development.md, validation.md): block startup
  const hasBlockers = docsUnmodified.length > 0 || docsWithTodos.length > 0;
  if (hasBlockers) {
    if (docsUnmodified.length > 0) {
      console.log('\n❌ 以下文件自 init 后未经修改，请根据项目实际情况修改后再启动：');
      for (const file of docsUnmodified) {
        console.log(`   • .win-agent/docs/${file}`);
      }
    }
    if (docsWithTodos.length > 0) {
      console.log(`\n❌ 以下文件仍包含待补充的 TODO 标记（⚠️ TODO），请补充完整后再启动：`);
      for (const file of docsWithTodos) {
        console.log(`   • .win-agent/docs/${file}`);
      }
    }
    console.log('\n   根据项目实际情况审核并调整以上文件，完成后重新执行 npx win-agent start');
    removePidFile();
    process.exit(1);
  }
}
