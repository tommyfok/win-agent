import fs from "node:fs";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  insertMemory,
  buildRecallPrompt as buildVectorRecallPrompt,
} from "../embedding/memory.js";

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

  constructor(
    private client: OpencodeClient,
    private workspace: string,
  ) {}

  /**
   * Initialize sessions for persistent roles (PM, SA, OPS).
   * Creates a session for each, injects role identity via the agent parameter,
   * and recalls recent memories for existing projects.
   */
  async initPersistentSessions(): Promise<void> {
    for (const role of PERSISTENT_ROLES) {
      const sessionId = await this.createRoleSession(role);
      this.activeSessions.set(role, sessionId);
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
    // 1. Ask role to write memory
    try {
      const result = await this.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: WRITE_MEMORY_PROMPT }],
        },
      });

      // Try to extract memory from the response
      const textParts = result.data?.parts?.filter(
        (p): p is Extract<typeof p, { type: "text" }> => p.type === "text"
      );
      if (textParts && textParts.length > 0) {
        const text = textParts[0].text || "";
        const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          const { summary, content } = JSON.parse(jsonMatch[1]);
          await insertMemory({
            role,
            summary,
            content,
            trigger: "context_limit",
          });
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
      this.taskSessions.set(taskId, newSessionId);
    } else {
      this.activeSessions.set(role, newSessionId);
    }

    return newSessionId;
  }

  /**
   * Trigger all persistent roles to write memory (used on engine stop).
   */
  async writeAllMemories(trigger: string): Promise<void> {
    for (const [role, sessionId] of this.activeSessions) {
      try {
        const result = await this.client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text", text: WRITE_MEMORY_PROMPT }],
          },
        });

        const textParts = result.data?.parts?.filter(
          (p): p is Extract<typeof p, { type: "text" }> => p.type === "text"
        );
        if (textParts && textParts.length > 0) {
          const text = textParts[0].text || "";
          const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
          if (jsonMatch) {
            const { summary, content } = JSON.parse(jsonMatch[1]);
            await insertMemory({ role, summary, content, trigger });
          }
        }
        console.log(`   ✓ ${role} 记忆已保存`);
      } catch {
        console.log(`   ⚠️  ${role} 记忆写入失败`);
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
    // Create session
    const sessionResult = await this.client.session.create({
      body: { title: `win-agent-${role}` },
    });
    const sessionId = sessionResult.data!.id;

    // Inject role identity using agent parameter
    // The agent's system prompt comes from .opencode/agents/{role}.md
    await this.client.session.prompt({
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
    });

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
