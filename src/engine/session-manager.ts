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
   * Get PM session ID (convenience method for talk command).
   */
  getPmSessionId(): string {
    return this.getSession(Role.PM);
  }

  /**
   * Create a fresh session for DEV on every dispatch.
   * Each dispatch gets a clean context with role identity and memory recall.
   */
  async getTaskSession(taskId: number, role: Role.DEV): Promise<string> {
    const key = `${taskId}-${role}`;
    this.taskSessions.delete(key);

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
  async writeAllMemories(trigger: string): Promise<void> {
    const sessions: Array<[Role, string]> = [
      ...this.activeSessions.entries(),
      ...Array.from(this.taskSessions.entries()).map(([key, id]) => {
        const role = key.split('-')[1] as Role; // e.g. "42-DEV" → "DEV"
        return [role, id] as [Role, string];
      }),
    ];

    for (const [role, sid] of sessions) {
      try {
        await writeMemory(this.client, role, sid, trigger);
        console.log(`   ✓ ${role} 记忆已保存`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`   ⚠️  ${role} 记忆写入失败: ${msg}`);
      }
    }
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
}
