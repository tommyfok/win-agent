import type { OpencodeClient } from "@opencode-ai/sdk";
import type { SessionManager } from "./session-manager.js";
import { insert } from "../db/repository.js";

/**
 * Default context window size (tokens) for rotation calculation.
 * Most models use 128k-200k; we use a conservative estimate.
 */
const DEFAULT_MAX_CONTEXT = 128_000;

/**
 * Rotation threshold — rotate when input tokens exceed this fraction of max context.
 */
const ROTATION_THRESHOLD = 0.6;

/**
 * Check whether a session needs rotation based on token usage,
 * and rotate if needed.
 *
 * @param inputTokens - The input token count from the last prompt response
 * @param role - The role whose session to rotate
 * @param sessionId - The current session ID
 * @param taskId - Optional task ID (for DEV/QA sessions)
 * @returns The (possibly new) session ID
 */
export async function checkAndRotate(
  sessionManager: SessionManager,
  role: string,
  sessionId: string,
  inputTokens: number,
  taskId?: number,
): Promise<string> {
  const usage = inputTokens / DEFAULT_MAX_CONTEXT;

  if (usage > ROTATION_THRESHOLD) {
    console.log(
      `   🔄 ${role} 上下文使用率 ${Math.round(usage * 100)}%，执行 session 轮转`,
    );
    insert("logs", {
      role: "system",
      action: "session_rotation",
      content: `${role} 上下文使用率 ${Math.round(usage * 100)}%，执行 session 轮转`,
    });
    const newSessionId = await sessionManager.rotateSession(
      role,
      sessionId,
      taskId,
    );
    return newSessionId;
  }

  return sessionId;
}
