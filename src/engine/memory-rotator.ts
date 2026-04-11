import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SessionManager } from './session-manager.js';
import { insert, select, upsertProjectConfig } from '../db/repository.js';
import { loadConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Default context window size (tokens) for rotation calculation.
 * Used as fallback when dynamic detection fails.
 */
const DEFAULT_MAX_CONTEXT = 200_000;

/**
 * Default rotation threshold — rotate when input tokens exceed this fraction of max context.
 * Can be overridden via config.contextRotation.inputThreshold.
 */
const DEFAULT_ROTATION_THRESHOLD = 0.8;

/**
 * Default context anxiety drop ratio.
 * Can be overridden via config.contextRotation.anxietyDropRatio.
 */
const DEFAULT_ANXIETY_DROP_RATIO = 0.3;
const ANXIETY_HISTORY_SIZE = 3;

/** Read effective rotation threshold from config, falling back to defaults. */
function getRotationThreshold(): number {
  try {
    const config = loadConfig();
    return config.contextRotation?.inputThreshold ?? DEFAULT_ROTATION_THRESHOLD;
  } catch {
    return DEFAULT_ROTATION_THRESHOLD;
  }
}

/** Read effective anxiety drop ratio from config, falling back to defaults. */
function getAnxietyDropRatio(): number {
  try {
    const config = loadConfig();
    return config.contextRotation?.anxietyDropRatio ?? DEFAULT_ANXIETY_DROP_RATIO;
  } catch {
    return DEFAULT_ANXIETY_DROP_RATIO;
  }
}

/** Dynamically detected model context limit (set once at engine startup). */
let dynamicMaxContext: number | null = null;

/** Per-role output token history for context anxiety detection. */
const outputHistory: Map<string, number[]> = new Map();

/**
 * Fetch the model's context limit from the opencode provider API.
 * Call once at engine startup. Falls back to DEFAULT_MAX_CONTEXT on failure.
 */
export async function detectModelContextLimit(client: OpencodeClient): Promise<number> {
  try {
    const result = await client.provider.list();
    const data = result.data as { all?: unknown[] } | null;
    const providers = data?.all;
    if (Array.isArray(providers)) {
      // Find the largest context limit across all available models
      let maxCtx = 0;
      for (const provider of providers) {
        const p = provider as { models?: Record<string, unknown> };
        const models = p.models;
        if (models && typeof models === 'object') {
          for (const model of Object.values(models)) {
            const m = model as { limit?: { context?: number } };
            const ctx = m?.limit?.context;
            if (typeof ctx === 'number' && ctx > maxCtx) {
              maxCtx = ctx;
            }
          }
        }
      }
      if (maxCtx > 0) {
        dynamicMaxContext = maxCtx;
        return maxCtx;
      }
    }
  } catch {
    // Non-fatal — fall back to default
  }
  dynamicMaxContext = DEFAULT_MAX_CONTEXT;
  return DEFAULT_MAX_CONTEXT;
}

/**
 * Get the effective max context limit (dynamic or default).
 */
function getMaxContext(): number {
  return dynamicMaxContext ?? DEFAULT_MAX_CONTEXT;
}

/**
 * Load per-role output token history from project_config (call at engine startup).
 */
export function loadOutputHistory(): void {
  try {
    const rows = select<{ key: string; value: string }>('project_config', {});
    for (const row of rows) {
      if (row.key.startsWith('engine.outputHistory.')) {
        const role = row.key.replace('engine.outputHistory.', '');
        const parsed = JSON.parse(row.value) as number[];
        if (Array.isArray(parsed)) outputHistory.set(role, parsed);
      }
    }
  } catch { /* non-fatal */ }
}

function saveOutputHistory(role: string): void {
  try {
    upsertProjectConfig(`engine.outputHistory.${role}`, JSON.stringify(outputHistory.get(role) ?? []));
  } catch { /* non-fatal */ }
}

/**
 * Record output tokens for a role (for context anxiety detection).
 */
export function recordOutputTokens(role: string, outputTokens: number): void {
  let history = outputHistory.get(role);
  if (!history) {
    history = [];
    outputHistory.set(role, history);
  }
  history.push(outputTokens);
  // Keep only recent entries
  if (history.length > ANXIETY_HISTORY_SIZE + 1) {
    history.shift();
  }
  saveOutputHistory(role);
}

/**
 * Check whether a role shows "context anxiety" — sudden output drop
 * suggesting the model is struggling with context pressure.
 */
function detectContextAnxiety(role: string, outputTokens: number): boolean {
  const history = outputHistory.get(role);
  if (!history || history.length < ANXIETY_HISTORY_SIZE) return false;

  // Calculate average of last N entries (excluding current)
  const recent = history.slice(-(ANXIETY_HISTORY_SIZE + 1), -1);
  if (recent.length < ANXIETY_HISTORY_SIZE) return false;

  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  if (avg === 0) return false;

  return outputTokens < avg * getAnxietyDropRatio();
}

/**
 * Check whether a session needs rotation based on token usage
 * and context anxiety, and rotate if needed.
 *
 * @param inputTokens - The input token count from the last prompt response
 * @param outputTokens - The output token count from the last prompt response
 * @param role - The role whose session to rotate
 * @param sessionId - The current session ID
 * @param taskId - Optional task ID (for DEV sessions)
 * @returns The (possibly new) session ID
 */
export async function checkAndRotate(
  sessionManager: SessionManager,
  role: string,
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  taskId?: number
): Promise<string> {
  const maxContext = getMaxContext();
  const usage = inputTokens / maxContext;

  // Record output for anxiety detection
  recordOutputTokens(role, outputTokens);

  // Check hard threshold
  const rotationThreshold = getRotationThreshold();
  if (usage > rotationThreshold) {
    const usagePct = Math.round(usage * 100);
    const threshold = Math.round(rotationThreshold * 100);
    logger.info({ role, usagePct, threshold }, 'session rotation triggered');
    insert('logs', {
      role: 'system',
      action: 'session_rotation',
      content: `${role} 上下文使用率 ${usagePct}%（限制 ${maxContext} tokens），执行 session 轮转`,
    });
    return sessionManager.rotateSession(role, sessionId, taskId);
  }

  // Check context anxiety (only if we're past 50% usage — don't trigger too early)
  if (usage > 0.5 && detectContextAnxiety(role, outputTokens)) {
    logger.info({ role, outputTokens, usagePct: Math.round(usage * 100) }, 'context anxiety rotation');
    insert('logs', {
      role: 'system',
      action: 'session_rotation',
      content: `${role} context anxiety 检测触发（使用率 ${Math.round(usage * 100)}%，输出 ${outputTokens} tokens 远低于近期平均）`,
    });

    return sessionManager.rotateSession(role, sessionId, taskId);
  }

  return sessionId;
}
