import type { OpencodeClient } from '@opencode-ai/sdk';
import { loadConfig } from '../config/index.js';
import { withAbortableTimeout } from './retry.js';
import { Role } from './role-manager.js';
import { getModelForRole } from './role-model.js';
import { logger } from '../utils/logger.js';

export const DEV_CONTINUE_PROMPT = '继续';

const DEFAULT_STALLED_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_NUDGE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000;
const MESSAGE_QUERY_TIMEOUT_MS = 5_000;
const NUDGE_TIMEOUT_MS = 10_000;

const lastNudgedAt = new Map<string, number>();

interface MessageWithTimes {
  info?: { time?: { created?: number; completed?: number } };
  parts?: Array<{ time?: { start?: number; end?: number } }>;
}

function getStalledThresholdMs(workspace?: string): number {
  return (
    loadConfig(workspace).engine?.devSessionStalledThresholdMs ?? DEFAULT_STALLED_THRESHOLD_MS
  );
}

function getNudgeCooldownMs(workspace?: string): number {
  return (
    loadConfig(workspace).engine?.devSessionNudgeCooldownMs ?? DEFAULT_NUDGE_COOLDOWN_MS
  );
}

function getCheckIntervalMs(workspace?: string): number {
  return (
    loadConfig(workspace).engine?.devSessionStallCheckIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
  );
}

function maxTime(values: Array<number | undefined>): number {
  let max = 0;
  for (const value of values) {
    if (value !== undefined && value > max) max = value;
  }
  return max;
}

export async function getLatestSessionUpdateTime(
  client: OpencodeClient,
  sessionId: string
): Promise<number | null> {
  const msgs = await withAbortableTimeout(
    (signal) =>
      client.session.messages({
        path: { id: sessionId },
        query: { limit: 10 },
        signal,
      }),
    MESSAGE_QUERY_TIMEOUT_MS,
    'DEV session progress check'
  );

  const messages = (msgs.data ?? []) as MessageWithTimes[];
  let latest = 0;
  for (const message of messages) {
    latest = Math.max(
      latest,
      maxTime([message.info?.time?.created, message.info?.time?.completed])
    );
    for (const part of message.parts ?? []) {
      latest = Math.max(latest, maxTime([part.time?.start, part.time?.end]));
    }
  }
  return latest > 0 ? latest : null;
}

export async function nudgeDevSessionIfStalled(
  client: OpencodeClient,
  workspace: string,
  sessionId: string,
  now = Date.now()
): Promise<boolean> {
  const latestUpdate = await getLatestSessionUpdateTime(client, sessionId);
  if (!latestUpdate) return false;

  const stalledMs = now - latestUpdate;
  if (stalledMs < getStalledThresholdMs(workspace)) return false;

  const lastNudge = lastNudgedAt.get(sessionId) ?? 0;
  if (now - lastNudge < getNudgeCooldownMs(workspace)) return false;

  const model = getModelForRole(Role.DEV, workspace);
  await withAbortableTimeout(
    (signal) =>
      client.session.promptAsync({
        path: { id: sessionId },
        signal,
        body: {
          ...(model ? { model } : {}),
          parts: [{ type: 'text', text: DEV_CONTINUE_PROMPT }],
        },
      }),
    NUDGE_TIMEOUT_MS,
    'DEV session continue nudge'
  );
  lastNudgedAt.set(sessionId, now);
  logger.info({ sessionId, stalledMs }, 'DEV session nudged to continue');
  return true;
}

export function startDevSessionStallMonitor(
  client: OpencodeClient,
  workspace: string,
  sessionId: string
): () => void {
  const intervalMs = getCheckIntervalMs(workspace);
  const timer = setInterval(() => {
    nudgeDevSessionIfStalled(client, workspace, sessionId).catch((err) => {
      logger.warn({ err, sessionId }, 'DEV session continue nudge failed');
    });
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

export function resetDevSessionNudgeState(): void {
  lastNudgedAt.clear();
}
