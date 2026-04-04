import fs from "node:fs";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  insertMemory,
  buildRecallPrompt as buildVectorRecallPrompt,
} from "../embedding/memory.js";
import { withRetry, withTimeout } from "./retry.js";
import { insert as dbInsert } from "../db/repository.js";
import { ensureWorkspaceId } from "../config/index.js";

type Role = "PM" | "SA" | "DEV" | "QA" | "OPS";
const PERSISTENT_ROLES: Role[] = ["PM", "SA", "OPS"];

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
  const promptFile = path.join(workspace, ".win-agent", "roles", `${role}.md`);
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Role prompt not found: ${promptFile}`);
  }
  return fs.readFileSync(promptFile, "utf-8");
}

/**
 * SessionManager manages opencode sessions for all roles.
 *
 * - PM/SA/OPS: persistent sessions created at engine startup
 * - DEV/QA: per-task sessions created on demand
 * - All sessions support context-based rotation (write memory → new session → recall)
 */
export class SessionManager {
  /** role → sessionId for persistent roles (PM, SA, OPS) */
  private activeSessions: Map<string, string> = new Map();
  /** taskId → sessionId for task-scoped roles (DEV, QA) */
  private taskSessions: Map<number, string> = new Map();
  /** Unique prefix for this workspace's sessions */
  private sessionPrefix: string;

  constructor(
    private client: OpencodeClient,
    private workspace: string,
  ) {
    const wsId = ensureWorkspaceId(workspace);
    this.sessionPrefix = `wa-${wsId}`;
  }

  /**
   * Initialize sessions for persistent roles (PM, SA, OPS).
   * Cleans up old win-agent sessions first, then creates fresh ones.
   */
  async initPersistentSessions(): Promise<void> {
    await this.cleanupOldSessions();
    for (const role of PERSISTENT_ROLES) {
      const sessionId = await this.createRoleSession(role);
      this.activeSessions.set(role, sessionId);
    }
    this.persistSessionIds();
  }

  /**
   * Write active session IDs to .win-agent/sessions.json so other
   * processes (e.g. `win-agent talk`) can read them.
   */
  private persistSessionIds(): void {
    const data: Record<string, string> = {};
    for (const [role, id] of this.activeSessions) {
      data[role] = id;
    }
    const file = path.join(this.workspace, ".win-agent", "sessions.json");
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Load persisted session IDs from disk (for cross-process access).
   */
  static loadPersistedSessions(workspace: string): Record<string, string> | null {
    const file = path.join(workspace, ".win-agent", "sessions.json");
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * Delete leftover sessions from previous runs of THIS workspace only.
   */
  private async cleanupOldSessions(): Promise<void> {
    try {
      const listResult = await this.client.session.list();
      const sessions = (listResult.data ?? []) as Array<{ id: string; title: string }>;
      for (const s of sessions) {
        if (s.title?.startsWith(this.sessionPrefix)) {
          try {
            await this.client.session.delete({ path: { id: s.id } });
          } catch { /* ignore */ }
        }
      }
    } catch {
      // non-fatal
    }
  }

  /**
   * Get the session ID for a persistent role (PM, SA, OPS).
   */
  getSession(role: "PM" | "SA" | "OPS"): string {
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
    return this.getSession("PM");
  }

  /**
   * Get or create a task-scoped session for DEV/QA.
   * If a session already exists for this task, return it.
   * Otherwise create a new session with role identity and memory recall.
   */
  async getTaskSession(taskId: number, role: "DEV" | "QA"): Promise<string> {
    const existing = this.taskSessions.get(taskId);
    if (existing) return existing;

    const sessionId = await this.createRoleSession(role);
    this.taskSessions.set(taskId, sessionId);
    return sessionId;
  }

  /**
   * Release a task session after task completion.
   */
  releaseTaskSession(taskId: number): void {
    this.taskSessions.delete(taskId);
  }

  /**
   * Rotate a session: write memory → create new session → recall memories.
   * Used when context usage exceeds threshold (60%).
   *
   * @returns The new session ID
   */
  async rotateSession(
    role: string,
    sessionId: string,
    taskId?: number
  ): Promise<string> {
    // 1. Ask role to write memory (with timeout, no retry — best effort)
    try {
      const result = await withTimeout(
        this.client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text", text: WRITE_MEMORY_PROMPT }],
          },
        }),
        3 * 60 * 1000,
        `${role} memory write`,
      );

      // Try to extract memory from the response — try JSON block first, then plain text fallback
      const textParts = result.data?.parts?.filter(
        (p): p is Extract<typeof p, { type: "text" }> => p.type === "text"
      );
      if (textParts && textParts.length > 0) {
        const text = textParts[0].text || "";
        const parsed = parseMemoryResponse(text);
        if (parsed) {
          await insertMemory({
            role,
            summary: parsed.summary,
            content: parsed.content,
            trigger: "context_limit",
          });
        }
        // Persist memory-write output for traceability
        try {
          dbInsert("role_outputs", {
            role,
            session_id: sessionId,
            input_summary: WRITE_MEMORY_PROMPT.slice(0, 500),
            output_text: text,
            input_tokens: result.data?.info?.tokens?.input ?? 0,
            output_tokens: result.data?.info?.tokens?.output ?? 0,
          });
        } catch { /* Non-fatal */ }
      }
    } catch {
      // Memory write failed — continue with rotation anyway
      console.log(`   ⚠️  ${role} 记忆写入失败，继续轮转`);
    }

    // 2. Create new session with identity and recall
    const newSessionId = await this.createRoleSession(role);

    // 3. Update mapping
    if (taskId !== undefined) {
      this.taskSessions.set(taskId, newSessionId);
    } else {
      this.activeSessions.set(role, newSessionId);
      this.persistSessionIds();
    }

    return newSessionId;
  }

  /**
   * Trigger all persistent roles to write memory (used on engine stop).
   */
  async writeAllMemories(trigger: string): Promise<void> {
    for (const [role, sessionId] of this.activeSessions) {
      try {
        const result = await withTimeout(
          this.client.session.prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: "text", text: WRITE_MEMORY_PROMPT }],
            },
          }),
          3 * 60 * 1000,
          `${role} memory write`,
        );

        const textParts = result.data?.parts?.filter(
          (p): p is Extract<typeof p, { type: "text" }> => p.type === "text"
        );
        if (textParts && textParts.length > 0) {
          const text = textParts[0].text || "";
          const parsed = parseMemoryResponse(text);
          if (parsed) {
            await insertMemory({ role, summary: parsed.summary, content: parsed.content, trigger });
          }
          // Persist memory-write output for traceability
          try {
            dbInsert("role_outputs", {
              role,
              session_id: sessionId,
              input_summary: WRITE_MEMORY_PROMPT.slice(0, 500),
              output_text: text,
              input_tokens: result.data?.info?.tokens?.input ?? 0,
              output_tokens: result.data?.info?.tokens?.output ?? 0,
            });
          } catch { /* Non-fatal */ }
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
   * Uses the opencode agent system: session.prompt with agent parameter
   * to load the role's agent config from .opencode/agents/{role}.md.
   * Then recalls recent memories.
   */
  private async createRoleSession(role: string): Promise<string> {
    // Create session (with retry for transient server issues)
    const sessionResult = await withRetry(
      () => this.client.session.create({
        body: { title: `${this.sessionPrefix}-${role}` },
      }),
      { maxAttempts: 3, label: `${role} session.create` },
    );
    const sessionId = sessionResult.data!.id;

    // Inject role identity using agent parameter
    await withRetry(
      () =>
        withTimeout(
          this.client.session.prompt({
            path: { id: sessionId },
            body: {
              agent: role,
              noReply: true,
              parts: [
                {
                  type: "text",
                  text: `你是 ${role} 角色，已准备就绪。等待引擎调度器为你分配任务。`,
                },
              ],
            },
          }),
          2 * 60 * 1000,
          `${role} identity inject`,
        ),
      { maxAttempts: 2, label: `${role} identity inject` },
    );

    // Recall recent memories (last 7 days)
    await this.recallMemories(sessionId, role);

    return sessionId;
  }

  /**
   * Recall recent memories for a role and inject them into the session.
   * Uses vector similarity search when context is available.
   */
  private async recallMemories(
    sessionId: string,
    role: string,
    currentContext?: string
  ): Promise<void> {
    try {
      const prompt = await buildVectorRecallPrompt(role, currentContext);
      if (!prompt) return;

      await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: role,
          noReply: true,
          parts: [{ type: "text", text: prompt }],
        },
      });
    } catch {
      // Memory recall failed — non-fatal, session is still usable
    }
  }

  /**
   * Get all active session IDs (for cleanup/monitoring).
   */
  getAllSessionIds(): string[] {
    return [
      ...this.activeSessions.values(),
      ...this.taskSessions.values(),
    ];
  }
}

/**
 * Parse LLM memory response with fallback.
 * Tries JSON code block first, then raw JSON, then plain text fallback.
 */
function parseMemoryResponse(
  text: string,
): { summary: string; content: string } | null {
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
    const lines = trimmed.split("\n");
    const summary = lines[0].slice(0, 200);
    return { summary, content: trimmed };
  }

  return null;
}
