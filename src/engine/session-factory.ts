import path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { withRetry } from './retry.js';
import { buildRecallPrompt } from '../embedding/memory.js';

function getRoleFilePath(workspace: string, role: string): string {
  return path.join(workspace, '.win-agent', 'roles', `${role}.md`);
}

/**
 * Create a new opencode session for a role with identity prompt and recalled memories.
 * - Creates the session via API
 * - Injects role identity prompt (from getRoleFilePath(workspace, role))
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

  parts.push(`请阅读 ${getRoleFilePath(workspace, role)} 文件并严格按要求工作`);

  try {
    const recallPrompt = await buildRecallPrompt(role);
    if (recallPrompt) parts.push(recallPrompt);
  } catch {
    // Memory recall failed — non-fatal
  }

  await withRetry(
    () =>
      client.session.promptAsync({
        path: { id: sessionId },
        body: {
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
