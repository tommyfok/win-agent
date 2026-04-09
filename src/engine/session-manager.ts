import fs from 'node:fs';
import path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { insertMemory, buildRecallPrompt as buildVectorRecallPrompt } from '../embedding/memory.js';
import { withRetry, withTimeout } from './retry.js';
import { insert as dbInsert } from '../db/repository.js';
import { ensureWorkspaceId } from '../config/index.js';

type Role = 'PM' | 'DEV';
const PERSISTENT_ROLES: Role[] = ['PM'];

/** Persisted state of an interrupted dispatch (written by engine on shutdown). */
export interface InterruptedState {
  role: string;
  taskId: number | null;
  sessionId: string | null;
  timestamp: string;
}

/** Prompt template for writing memory before session rotation. */
const WRITE_MEMORY_PROMPT = `你即将被轮转到一个新的 session。请总结你当前的工作状态，包括：

1. **摘要**（一句话概括当前进度）
2. **详细内容**：
   - 已完成的工作
   - 关键决策和原因
   - 未完成的事项
   - 需要注意的风险或问题

请用以下 JSON 格式输出：
\`\`\`json
{
  "summary": "一句话摘要",
  "content": "详细工作内容"
}
\`\`\``;

// buildRecallPrompt is now in ../embedding/memory.ts with vector search support

/**
 * Load the role prompt content from .win-agent/roles/{role}.md
 */
function loadRolePrompt(workspace: string, role: string): string {
  const promptFile = path.join(workspace, '.win-agent', 'roles', `${role}.md`);
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Role prompt not found: ${promptFile}`);
  }
  return fs.readFileSync(promptFile, 'utf-8');
}

/**
 * SessionManager manages opencode sessions for all roles.
 *
 * - PM: persistent sessions created at engine startup
 * - DEV: per-task sessions created on demand
 * - All sessions support context-based rotation (write memory → new session → recall)
 */
export class SessionManager {
  /** role → sessionId for persistent roles (PM) */
  private activeSessions: Map<string, string> = new Map();
  /** "taskId-role" → sessionId for task-scoped roles (DEV) */
  private taskSessions: Map<string, string> = new Map();
  /** Unique prefix for this workspace's sessions */
  private sessionPrefix: string;

  constructor(
    private client: OpencodeClient,
    private workspace: string
  ) {
    const wsId = ensureWorkspaceId(workspace);
    this.sessionPrefix = `wa-${wsId}`;
  }

  /**
   * Initialize sessions for persistent roles (PM).
   * If an interrupted session exists and was resumed, skip creating a new session for that role.
   * Otherwise, cleans up old win-agent sessions and creates fresh ones.
   */
  async initPersistentSessions(): Promise<void> {
    // Check for interrupted dispatch — resume if possible
    const resumed = await this.checkAndResumeInterrupted();
    const resumedRoles = new Set<string>();
    if (resumed) {
      // Collect which roles already have sessions from the resume
      for (const role of PERSISTENT_ROLES) {
        if (this.activeSessions.has(role)) resumedRoles.add(role);
      }
    }

    // Clean up old sessions (but NOT the ones we just resumed)
    await this.cleanupOldSessions(resumedRoles);

    // Create fresh sessions for roles that were NOT resumed
    for (const role of PERSISTENT_ROLES) {
      if (resumedRoles.has(role)) {
        console.log(`   ↻ ${role} session 已从中断状态恢复，跳过创建`);
        continue;
      }
      const sessionId = await this.createRoleSession(role);
      this.activeSessions.set(role, sessionId);
    }
    this.persistSessionIds();

    // Wait for async agent bind prompts to complete.
    // promptAsync returns immediately but the LLM processes in background.
    // We need to wait so that: (1) the web UI sees proper assistant responses,
    // (2) the scheduler doesn't conflict with in-progress bind responses.
    await this.waitForSessionsReady();
  }

  /**
   * Wait for all persistent sessions to become idle (bind responses complete).
   * Polls session status via event stream with a timeout.
   */
  private async waitForSessionsReady(): Promise<void> {
    const maxWait = 60_000; // 60s max
    const pollInterval = 2_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      let allIdle = true;
      for (const [, sessionId] of this.activeSessions) {
        try {
          // Check session messages - if assistant has responded, session is ready
          const msgs = await this.client.session.messages({ path: { id: sessionId } });
          const messages = (msgs.data ?? []) as Array<{ role?: string }>;
          const hasAssistantResponse = messages.some((m) => m.role === 'assistant');
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
    // Timeout — proceed anyway, sessions may work but bind might not be done
    console.log('   ⚠️  Session 初始化等待超时，继续启动');
  }

  /**
   * Write active session IDs to .win-agent/sessions.json so other
   * processes (e.g. `win-agent talk`) can read them.
   * Includes both PM (activeSessions) and DEV task sessions (taskSessions).
   */
  private persistSessionIds(): void {
    const data: Record<string, string> = {};
    for (const [role, id] of this.activeSessions) {
      data[role] = id;
    }
    for (const [key, id] of this.taskSessions) {
      data[`task:${key}`] = id;
    }
    const file = path.join(this.workspace, '.win-agent', 'sessions.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load persisted session IDs from disk (for cross-process access).
   */
  static loadPersistedSessions(workspace: string): Record<string, string> | null {
    const file = path.join(workspace, '.win-agent', 'sessions.json');
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Delete leftover sessions from previous runs of THIS workspace only.
   * @param preserveRoles - roles whose current sessions should NOT be deleted (e.g. resumed sessions)
   */
  private async cleanupOldSessions(preserveRoles?: Set<string>): Promise<void> {
    // Collect session IDs to preserve
    const preserveIds = new Set<string>();
    if (preserveRoles) {
      for (const role of preserveRoles) {
        const id = this.activeSessions.get(role);
        if (id) preserveIds.add(id);
      }
      // Also preserve any task sessions that were resumed
      for (const [, id] of this.taskSessions) {
        preserveIds.add(id);
      }
    }

    try {
      const listResult = await this.client.session.list();
      const sessions = (listResult.data ?? []) as Array<{ id: string; title: string }>;
      for (const s of sessions) {
        if (s.title?.startsWith(this.sessionPrefix) && !preserveIds.has(s.id)) {
          try {
            await this.client.session.delete({ path: { id: s.id } });
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      // non-fatal
    }
  }

  /**
   * Get the session ID for a persistent role (PM).
   */
  getSession(role: 'PM'): string {
    const id = this.activeSessions.get(role);
    if (!id) {
      throw new Error(`No active session for role ${role}`);
    }
    return id;
  }

  /**
   * Get PM session ID (convenience method for talk command).
   */
  getPmSessionId(): string {
    return this.getSession('PM');
  }

  /**
   * Create a fresh session for DEV on every dispatch.
   * Each dispatch gets a clean context with role identity and memory recall.
   * The previous task session (if any) is released first.
   */
  async getTaskSession(taskId: number, role: 'DEV'): Promise<string> {
    const key = `${taskId}-${role}`;
    // Release previous session for this task (if any) so DEV always starts clean
    this.taskSessions.delete(key);

    const sessionId = await this.createRoleSession(role);
    this.taskSessions.set(key, sessionId);
    this.persistSessionIds();
    return sessionId;
  }

  /**
   * Release a task session after task completion.
   */
  releaseTaskSession(taskId: number): void {
    this.taskSessions.delete(`${taskId}-DEV`);
  }

  /**
   * Rotate a session: write memory → create new session → recall memories.
   * Used when context usage exceeds threshold (80%).
   *
   * @returns The new session ID
   */
  async rotateSession(role: string, sessionId: string, taskId?: number): Promise<string> {
    // 1. Ask role to write memory (with timeout, no retry — best effort)
    try {
      const result = await withTimeout(
        this.client.session.prompt({
          path: { id: sessionId },
          body: {
            agent: role,
            parts: [{ type: 'text', text: WRITE_MEMORY_PROMPT }],
          },
        }),
        3 * 60 * 1000,
        `${role} memory write`
      );

      // Try to extract memory from the response — try JSON block first, then plain text fallback
      const textParts = result.data?.parts?.filter(
        (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
      );
      if (textParts && textParts.length > 0) {
        const text = textParts[0].text || '';
        const parsed = parseMemoryResponse(text);
        if (parsed) {
          await insertMemory({
            role,
            summary: parsed.summary,
            content: parsed.content,
            trigger: 'context_limit',
          });
        }
        // Persist memory-write output for traceability
        try {
          dbInsert('role_outputs', {
            role,
            session_id: sessionId,
            input_summary: WRITE_MEMORY_PROMPT.slice(0, 500),
            output_text: text,
            input_tokens: result.data?.info?.tokens?.input ?? 0,
            output_tokens: result.data?.info?.tokens?.output ?? 0,
          });
        } catch {
          /* Non-fatal */
        }
      }
    } catch {
      // Memory write failed — continue with rotation anyway
      console.log(`   ⚠️  ${role} 记忆写入失败，继续轮转`);
    }

    // 2. Create new session with identity and recall
    const newSessionId = await this.createRoleSession(role);

    // 3. Update mapping
    if (taskId !== undefined) {
      this.taskSessions.set(`${taskId}-${role}`, newSessionId);
    } else {
      this.activeSessions.set(role, newSessionId);
      this.persistSessionIds();
    }

    return newSessionId;
  }

  /**
   * Trigger all roles (PM + DEV task sessions) to write memory (used on engine stop).
   */
  async writeAllMemories(trigger: string): Promise<void> {
    // Build a combined list of [role, sessionId] for all active sessions
    const sessions: Array<[string, string]> = [
      ...this.activeSessions.entries(),
      // DEV task sessions: key format is "taskId-role"
      ...Array.from(this.taskSessions.entries()).map(([key, id]) => {
        const role = key.split('-')[1]; // e.g. "42-DEV" → "DEV"
        return [role, id] as [string, string];
      }),
    ];

    for (const [role, sessionId] of sessions) {
      try {
        const result = await withTimeout(
          this.client.session.prompt({
            path: { id: sessionId },
            body: {
              agent: role,
              parts: [{ type: 'text', text: WRITE_MEMORY_PROMPT }],
            },
          }),
          3 * 60 * 1000,
          `${role} memory write`
        );

        const textParts = result.data?.parts?.filter(
          (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
        );
        if (textParts && textParts.length > 0) {
          const text = textParts[0].text || '';
          const parsed = parseMemoryResponse(text);
          if (parsed) {
            await insertMemory({ role, summary: parsed.summary, content: parsed.content, trigger });
          }
          // Persist memory-write output for traceability
          try {
            dbInsert('role_outputs', {
              role,
              session_id: sessionId,
              input_summary: WRITE_MEMORY_PROMPT.slice(0, 500),
              output_text: text,
              input_tokens: result.data?.info?.tokens?.input ?? 0,
              output_tokens: result.data?.info?.tokens?.output ?? 0,
            });
          } catch {
            /* Non-fatal */
          }
        }
        console.log(`   ✓ ${role} 记忆已保存`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`   ⚠️  ${role} 记忆写入失败: ${msg}`);
      }
    }
  }

  /**
   * Create a new session for a role.
   *
   * Creates the session and sends the bind prompt with full role identity
   * and recalled memories included. This ensures context survives engine
   * crashes (no in-memory pendingContext that could be lost).
   */
  private async createRoleSession(role: string): Promise<string> {
    // Create session (with retry for transient server issues)
    const sessionResult = await withRetry(
      () =>
        this.client.session.create({
          body: { title: `${this.sessionPrefix}-${role}` },
        }),
      { maxAttempts: 3, label: `${role} session.create` }
    );
    const sessionId = sessionResult.data!.id;

    // Build bind prompt: role identity + memories + ready message
    const parts: string[] = [];

    // Role prompt (so agent knows its full responsibilities from the start)
    try {
      const rolePrompt = loadRolePrompt(this.workspace, role);
      parts.push(
        `# 你的身份：${role}\n\n以下是你的角色定义、工作职责和行为准则：\n\n${rolePrompt}`
      );
    } catch {
      // Role prompt not found — non-fatal
    }

    // Recent memories
    try {
      const recallPrompt = await buildVectorRecallPrompt(role);
      if (recallPrompt) parts.push(recallPrompt);
    } catch {
      // Memory recall failed — non-fatal
    }

    parts.push(`你是 ${role} 角色，已准备就绪。等待引擎调度器为你分配任务。`);

    // Associate agent with session via promptAsync.
    // Includes full role context so it's persisted in the session's
    // conversation history and survives engine restarts.
    await withRetry(
      () =>
        this.client.session.promptAsync({
          path: { id: sessionId },
          body: {
            agent: role,
            parts: [
              {
                type: 'text',
                text: parts.join('\n\n---\n\n'),
              },
            ],
          },
        }),
      { maxAttempts: 2, label: `${role} agent bind` }
    );

    return sessionId;
  }

  /**
   * Consume and return any pending context for a session.
   * Since context is now included in the bind prompt, this always returns empty.
   * Kept for API compatibility with dispatcher.
   */
  consumePendingContext(_sessionId: string): string {
    return '';
  }

  /**
   * Get all active session IDs (for cleanup/monitoring).
   */
  getAllSessionIds(): string[] {
    return [...this.activeSessions.values(), ...this.taskSessions.values()];
  }

  /**
   * Check for interrupted dispatch state and resume if found.
   *
   * On engine startup, reads .win-agent/interrupted.json. If present:
   * 1. Validates that the session still exists on the opencode server
   * 2. Re-registers the session in our maps (so scheduler uses it)
   * 3. Sends a "continue" prompt to the interrupted session
   * 4. Deletes the interrupted.json file
   *
   * @returns true if a session was resumed
   */
  async checkAndResumeInterrupted(): Promise<boolean> {
    const interruptedFile = path.join(this.workspace, '.win-agent', 'interrupted.json');
    if (!fs.existsSync(interruptedFile)) return false;

    let state: InterruptedState;
    try {
      state = JSON.parse(fs.readFileSync(interruptedFile, 'utf-8'));
    } catch {
      // Corrupt file — clean up and move on
      try {
        fs.unlinkSync(interruptedFile);
      } catch {
        /* */
      }
      return false;
    }

    const { role, taskId, sessionId } = state;
    if (!sessionId) {
      // No session to resume (dispatch was interrupted before session was resolved)
      try {
        fs.unlinkSync(interruptedFile);
      } catch {
        /* */
      }
      return false;
    }

    // Validate session still exists on server
    try {
      await this.client.session.get({ path: { id: sessionId } });
    } catch {
      console.log(`   ⚠️  中断的 session ${sessionId} 已不存在，跳过恢复`);
      try {
        fs.unlinkSync(interruptedFile);
      } catch {
        /* */
      }
      return false;
    }

    // Re-register session in our maps
    if (role === 'PM') {
      this.activeSessions.set(role, sessionId);
    } else if (taskId && role === 'DEV') {
      this.taskSessions.set(`${taskId}-${role}`, sessionId);
    }
    this.persistSessionIds();

    // Send "continue" prompt to the interrupted session
    const resumePrompt =
      `你的上一次操作因引擎重启被中断。请检查当前工作目录和任务状态，然后继续完成未完成的工作。` +
      (taskId ? `\n\n被中断的任务 ID: task#${taskId}` : '');

    try {
      await withRetry(
        () =>
          this.client.session.promptAsync({
            path: { id: sessionId },
            body: {
              agent: role,
              parts: [{ type: 'text', text: resumePrompt }],
            },
          }),
        { maxAttempts: 2, label: `${role} resume` }
      );
      console.log(`   ✓ 已恢复 ${role} session (${sessionId})，发送继续指令`);
    } catch (err) {
      console.log(`   ⚠️  恢复 ${role} session 失败: ${err}`);
    }

    // Clean up interrupted file
    try {
      fs.unlinkSync(interruptedFile);
    } catch {
      /* */
    }
    return true;
  }
}

/**
 * Parse LLM memory response with fallback.
 * Tries JSON code block first, then raw JSON, then plain text fallback.
 */
function parseMemoryResponse(text: string): { summary: string; content: string } | null {
  // Try ```json block
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    try {
      const { summary, content } = JSON.parse(jsonBlockMatch[1]);
      if (summary && content) return { summary, content };
    } catch {
      // Fall through
    }
  }

  // Try raw JSON (LLM may omit code fences)
  const jsonMatch = text.match(/\{[\s\S]*"summary"[\s\S]*"content"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const { summary, content } = JSON.parse(jsonMatch[0]);
      if (summary && content) return { summary, content };
    } catch {
      // Fall through
    }
  }

  // Plain text fallback: use first line as summary, rest as content
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    const lines = trimmed.split('\n');
    const summary = lines[0].slice(0, 200);
    return { summary, content: trimmed };
  }

  return null;
}
