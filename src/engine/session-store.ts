import fs from 'node:fs';
import path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { withRetry } from './retry.js';
import { loadConfig } from '../config/index.js';
import { Role } from './role-manager.js';
import { getModelForRole } from './role-model.js';

// Re-export for callers that import session creation from this module
export { createRoleSession } from './session-factory.js';

/** Persisted state of an interrupted dispatch (written by engine on shutdown). */
export interface InterruptedState {
  role: Role;
  taskId: number | null;
  sessionId: string | null;
  timestamp: string;
}

/**
 * Write active session IDs to .win-agent/sessions.json so other
 * processes (e.g. `win-agent talk`) can read them.
 * Includes both PM (activeSessions) and DEV task sessions (taskSessions).
 */
export function persistSessionIds(
  workspace: string,
  activeSessions: Map<string, string>,
  taskSessions: Map<string, string>
): void {
  const data: Record<string, string> = {};
  for (const [role, id] of activeSessions) {
    data[role] = id;
  }
  for (const [key, id] of taskSessions) {
    data[`task:${key}`] = id;
  }
  const file = path.join(workspace, '.win-agent', 'sessions.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Load persisted session IDs from disk (for cross-process access).
 */
export function loadPersistedSessions(workspace: string): Record<string, string> | null {
  const file = path.join(workspace, '.win-agent', 'sessions.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Check for interrupted dispatch state and resume if found.
 *
 * On engine startup, reads .win-agent/interrupted.json. If present:
 * 1. Validates that the session still exists on the opencode server
 * 2. Re-registers the session in the provided session maps
 * 3. Sends a "continue" prompt to the interrupted session
 * 4. Deletes the interrupted.json file
 *
 * @param onPersist - Called after maps are updated to persist them to disk
 * @returns true if a session was resumed
 */
export async function checkAndResumeInterrupted(
  client: OpencodeClient,
  workspace: string,
  activeSessions: Map<string, string>,
  taskSessions: Map<string, string>,
  onPersist: () => void
): Promise<boolean> {
  const interruptedFile = path.join(workspace, '.win-agent', 'interrupted.json');
  if (!fs.existsSync(interruptedFile)) return false;

  let state: InterruptedState;
  try {
    state = JSON.parse(fs.readFileSync(interruptedFile, 'utf-8'));
  } catch {
    try {
      fs.unlinkSync(interruptedFile);
    } catch {
      /* */
    }
    return false;
  }

  const { role, taskId, sessionId } = state;
  if (!sessionId) {
    try {
      fs.unlinkSync(interruptedFile);
    } catch {
      /* */
    }
    return false;
  }

  // Validate session still exists on server
  try {
    await client.session.get({ path: { id: sessionId } });
  } catch {
    console.log(`   ⚠️  中断的 session ${sessionId} 已不存在，跳过恢复`);
    try {
      fs.unlinkSync(interruptedFile);
    } catch {
      /* */
    }
    return false;
  }

  // Re-register session in maps
  if (role === Role.PM) {
    activeSessions.set(role, sessionId);
  } else if (taskId && role === Role.DEV) {
    taskSessions.set(`${taskId}-${role}`, sessionId);
  }
  onPersist();

  // Send "continue" prompt to the interrupted session
  const resumePrompt =
    `你的上一次操作因引擎重启被中断。请检查当前工作目录和任务状态，然后继续完成未完成的工作。` +
    (taskId ? `\n\n被中断的任务 ID: task#${taskId}` : '');

  try {
    const model = getModelForRole(role, workspace);
    await withRetry(
      () =>
        client.session.promptAsync({
          path: { id: sessionId },
          body: {
            ...(model ? { model } : {}),
            parts: [{ type: 'text', text: resumePrompt }],
          },
        }),
      { maxAttempts: 2, label: `${role} resume` }
    );
    console.log(`   ✓ 已恢复 ${role} session (${sessionId})，发送继续指令`);
  } catch (err) {
    console.log(`   ⚠️  恢复 ${role} session 失败: ${err}`);
  }

  try {
    fs.unlinkSync(interruptedFile);
  } catch {
    /* */
  }
  return true;
}

/**
 * Wait for all persistent sessions to become idle (bind responses complete).
 * Polls session message history with a timeout.
 */
export async function waitForSessionsReady(
  client: OpencodeClient,
  activeSessions: Map<string, string>
): Promise<void> {
  const maxWait = loadConfig().engine?.sessionInitTimeoutMs ?? 120_000;
  const pollInterval = 2_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    let allIdle = true;
    for (const [, sessionId] of activeSessions) {
      try {
        const msgs = await client.session.messages({ path: { id: sessionId } });
        const messages = (msgs.data ?? []) as Array<{ role?: Role }>;
        const hasAssistantResponse = messages.some((m) => m.role === Role.ASSISTANT);
        if (!hasAssistantResponse) {
          allIdle = false;
          break;
        }
      } catch {
        allIdle = false;
        break;
      }
    }
    if (allIdle) return;
    await new Promise<void>((r) => setTimeout(r, pollInterval));
  }
  console.log('   ⚠️  Session 初始化等待超时，继续启动');
}

/**
 * Delete leftover sessions from previous runs of THIS workspace only.
 * Sessions listed in preserveRoles or taskSessions are kept.
 */
export async function cleanupOldSessions(
  client: OpencodeClient,
  sessionPrefix: string,
  activeSessions: Map<string, string>,
  taskSessions: Map<string, string>,
  preserveRoles?: Set<string>
): Promise<void> {
  const preserveIds = new Set<string>();
  if (preserveRoles) {
    for (const role of preserveRoles) {
      const id = activeSessions.get(role);
      if (id) preserveIds.add(id);
    }
    for (const [, id] of taskSessions) {
      preserveIds.add(id);
    }
  }

  try {
    const listResult = await client.session.list();
    const sessions = (listResult.data ?? []) as Array<{ id: string; title: string }>;
    for (const s of sessions) {
      if (s.title?.startsWith(sessionPrefix) && !preserveIds.has(s.id)) {
        try {
          await client.session.delete({ path: { id: s.id } });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    // non-fatal
  }
}
