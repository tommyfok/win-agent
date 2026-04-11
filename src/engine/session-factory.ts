import fs from 'node:fs';
import path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { withRetry } from './retry.js';
import { buildRecallPrompt } from '../embedding/memory.js';

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
 * Create a new opencode session for a role with identity prompt and recalled memories.
 * - Creates the session via API
 * - Injects role identity prompt (from .win-agent/roles/{role}.md)
 * - Injects recalled memories (from vector store)
 * - Sends an async bind prompt to prime the agent
 */
export async function createRoleSession(
  client: OpencodeClient,
  sessionPrefix: string,
  workspace: string,
  role: string
): Promise<string> {
  const sessionResult = await withRetry(
    () =>
      client.session.create({
        body: { title: `${sessionPrefix}-${role}` },
      }),
    { maxAttempts: 3, label: `${role} session.create` }
  );
  const sessionId = sessionResult.data!.id;

  const parts: string[] = [];

  try {
    const rolePrompt = loadRolePrompt(workspace, role);
    parts.push(
      `# 你的身份：${role}\n\n以下是你的角色定义、工作职责和行为准则：\n\n${rolePrompt}`
    );
  } catch {
    // Role prompt not found — non-fatal
  }

  try {
    const recallPrompt = await buildRecallPrompt(role);
    if (recallPrompt) parts.push(recallPrompt);
  } catch {
    // Memory recall failed — non-fatal
  }

  parts.push(`你是 ${role} 角色，已准备就绪。等待引擎调度器为你分配任务。`);

  await withRetry(
    () =>
      client.session.promptAsync({
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
