import type { OpencodeClient } from '@opencode-ai/sdk';
import { writeMemory } from './memory-writer.js';
import {
  persistSessionIds,
  loadPersistedSessions,
  checkAndResumeInterrupted,
  createRoleSession,
  waitForSessionsReady,
  cleanupOldSessions,
} from './session-store.js';
import { ensureWorkspaceId } from '../config/index.js';
import { Role } from './role-manager.js';

// Re-export for callers that previously imported from here
export type { InterruptedState } from './session-store.js';

const PERSISTENT_ROLES: Role[] = [Role.PM];

/**
 * SessionManager manages opencode sessions for all roles.
 *
 * - PM: persistent sessions created at engine startup
 * - DEV: per-task sessions created on demand
 * - All sessions support context-based rotation (write memory → new session → recall)
 *
 * Session creation, cleanup, and readiness polling are handled by session-store.ts.
 * Memory writing is handled by memory-writer.ts.
 */
export class SessionManager {
  /** role → sessionId for persistent roles (PM) */
  private activeSessions: Map<Role, string> = new Map();
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

  getWorkspace(): string {
    return this.workspace;
  }

  /**
   * Initialize sessions for persistent roles (PM).
   * If an interrupted session exists and was resumed, skip creating a new session for that role.
   * Otherwise, cleans up old win-agent sessions and creates fresh ones.
   */
  async initPersistentSessions(): Promise<void> {
    const resumed = await checkAndResumeInterrupted(
      this.client,
      this.workspace,
      this.activeSessions,
      this.taskSessions,
      () => this.persist()
    );
    const resumedRoles = new Set<string>();
    if (resumed) {
      for (const role of PERSISTENT_ROLES) {
        if (this.activeSessions.has(role)) resumedRoles.add(role);
      }
    }

    await cleanupOldSessions(
      this.client,
      this.sessionPrefix,
      this.activeSessions,
      this.taskSessions,
      resumedRoles
    );

    for (const role of PERSISTENT_ROLES) {
      if (resumedRoles.has(role)) {
        console.log(`   ↻ ${role} session 已从中断状态恢复，跳过创建`);
        continue;
      }
      const sessionId = await createRoleSession(
        this.client,
        this.sessionPrefix,
        this.workspace,
        role
      );
      this.activeSessions.set(role, sessionId);
    }
    this.persist();

    await waitForSessionsReady(this.client, this.activeSessions);
  }

  /** Persist session IDs to disk for cross-process access. */
  private persist(): void {
    persistSessionIds(this.workspace, this.activeSessions, this.taskSessions);
  }

  /**
   * Load persisted session IDs from disk (for cross-process access).
   */
  static loadPersistedSessions(workspace: string): Record<string, string> | null {
    return loadPersistedSessions(workspace);
  }

  /**
   * Get the session ID for a persistent role (PM).
   */
  getSession(role: Role.PM): string {
    const id = this.activeSessions.get(role);
    if (!id) {
      throw new Error(`No active session for role ${role}`);
    }
    return id;
  }

  /**
   * Get or recreate the session for a persistent role.
   *
   * Used after reconciliation invalidates a stale local mapping whose session
   * no longer exists on the opencode server.
   */
  async ensureSession(role: Role.PM): Promise<string> {
    const existing = this.activeSessions.get(role);
    if (existing) return existing;

    const sessionId = await createRoleSession(
      this.client,
      this.sessionPrefix,
      this.workspace,
      role
    );
    this.activeSessions.set(role, sessionId);
    this.persist();
    return sessionId;
  }

  /**
   * Get PM session ID (convenience method for talk command).
   */
  getPmSessionId(): string {
    return this.getSession(Role.PM);
  }

  /**
   * Get the DEV session for a task, reusing the existing one if present.
   *
   * A fresh session is created only when:
   * - The task has no session yet (first dispatch for this task), OR
   * - The previous session was cleared via `releaseTaskSession` (task done / iteration reviewed), OR
   * - `rotateSession` replaced it due to context-limit rotation.
   *
   * Reusing the session preserves the DEV's working context (files read, commands run, partial
   * progress) across dispatches on the same task, instead of spinning up a new "DEV worker"
   * each time PM sends a follow-up message.
   */
  async getTaskSession(taskId: number, role: Role.DEV): Promise<string> {
    const key = `${taskId}-${role}`;
    const existing = this.taskSessions.get(key);
    if (existing) {
      return existing;
    }

    const sessionId = await createRoleSession(
      this.client,
      this.sessionPrefix,
      this.workspace,
      role
    );
    this.taskSessions.set(key, sessionId);
    this.persist();
    return sessionId;
  }

  /**
   * Release a task session after task completion.
   */
  releaseTaskSession(taskId: number): void {
    this.taskSessions.delete(`${taskId}-${Role.DEV}`);
  }

  /**
   * Drop any local role/task mapping that points at a server-missing session.
   * The next dispatch will create a fresh session instead of reusing a stale id.
   */
  invalidateSessionId(sessionId: string): void {
    let changed = false;
    for (const [role, id] of this.activeSessions) {
      if (id === sessionId) {
        this.activeSessions.delete(role);
        changed = true;
      }
    }
    for (const [key, id] of this.taskSessions) {
      if (id === sessionId) {
        this.taskSessions.delete(key);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /**
   * Rotate a session: write memory → create new session → recall memories.
   * Used when context usage exceeds threshold (80%).
   *
   * @returns The new session ID
   */
  async rotateSession(role: Role, sessionId: string, taskId?: number): Promise<string> {
    // 1. Ask role to write memory (best effort — continue even on failure)
    try {
      await writeMemory(this.client, role, sessionId, 'context_limit');
    } catch {
      console.log(`   ⚠️  ${role} 记忆写入失败，继续轮转`);
    }

    // 2. Create new session with identity and recall
    const newSessionId = await createRoleSession(
      this.client,
      this.sessionPrefix,
      this.workspace,
      role
    );

    // 3. Update mapping
    if (taskId !== undefined) {
      this.taskSessions.set(`${taskId}-${role}`, newSessionId);
    } else {
      this.activeSessions.set(role, newSessionId);
      this.persist();
    }

    return newSessionId;
  }

  /**
   * Trigger all roles (PM + DEV task sessions) to write memory (used on engine stop).
   */
  async writeAllMemories(trigger: string, timeoutMs?: number): Promise<void> {
    const sessions: Array<[Role, string]> = [
      ...this.activeSessions.entries(),
      ...Array.from(this.taskSessions.entries()).map(([key, id]) => {
        const role = key.split('-')[1] as Role;
        return [role, id] as [Role, string];
      }),
    ];

    const results = await Promise.allSettled(
      sessions.map(([role, sid]) =>
        writeMemory(this.client, role, sid, trigger, timeoutMs).then(
          () => console.log(`   ✓ ${role} 记忆已保存`),
          (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`   ⚠️  ${role} 记忆写入失败: ${msg}`);
          }
        )
      )
    );
    void results;
  }

  /**
   * Consume and return any pending context for a session.
   * Context is now included in the bind prompt; kept for API compatibility.
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

  getRoleSessionId(role: Role, taskId?: number): string | null {
    if (role === Role.PM) {
      return this.activeSessions.get(Role.PM) ?? null;
    }
    if (role === Role.DEV) {
      if (taskId !== undefined) {
        return this.taskSessions.get(`${taskId}-${Role.DEV}`) ?? null;
      }
      return null;
    }
    return null;
  }

  /**
   * Enumerate every known session id for a role across the workspace.
   *
   * - PM: the single persistent session (0 or 1 entry).
   * - DEV: every task-scoped session currently registered in `taskSessions`
   *   (keys of the form `${taskId}-DEV`). Used by the reconciler to detect a
   *   busy DEV session even when no dispatch is in-flight in this process.
   */
  getAllRoleSessionIds(role: Role): string[] {
    if (role === Role.PM) {
      const id = this.activeSessions.get(Role.PM);
      return id ? [id] : [];
    }
    if (role === Role.DEV) {
      const ids: string[] = [];
      const suffix = `-${Role.DEV}`;
      for (const [key, id] of this.taskSessions) {
        if (key.endsWith(suffix)) ids.push(id);
      }
      return ids;
    }
    return [];
  }
}
