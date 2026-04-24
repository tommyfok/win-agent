import path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { withRetry } from './retry.js';
import { buildRecallPrompt } from '../embedding/memory.js';
import { Role } from './role-manager.js';
import { getModelForRole } from './role-model.js';

function getRoleFilePath(workspace: string, role: Role): string {
  return path.join(workspace, '.win-agent', 'roles', `${role}.md`);
}

/**
 * Build the bind prompt for a role.
 * DEV gets an extra reminder about Phase execution order.
 */
function buildBindPrompt(workspace: string, role: Role): string {
  const roleFilePath = getRoleFilePath(workspace, role);

  if (role === Role.DEV) {
    return (
      `请阅读 ${roleFilePath} 文件并严格按要求工作。\n\n` +
      `**⚠️ 关键提醒：你必须严格按 Phase 1 → 2 → 3 → 4 顺序执行，禁止跳过任何 Phase。**\n` +
      `- Phase 1（环境感知）：先执行 git log + git status，查看回忆和任务上下文，完成后才能继续\n` +
      `- Phase 2（消息分派）：根据消息 type 选择分支\n` +
      `- Phase 3（开发和自测）：按 development.md 开发，按 validation.md 验证，全部通过才能进入 Phase 4\n` +
      `- Phase 4（收尾）：git commit → 更新状态 → 写记忆 → 归档 → 发验收报告\n` +
      `跳过任何 Phase 均属严重违规。`
    );
  }

  return `请阅读 ${roleFilePath} 文件并严格按要求工作`;
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
  role: Role
): Promise<string> {
  const sessionResult = await withRetry(
    () =>
      client.session.create({
        body: { title: `${sessionPrefix}-${role}-${Date.now()}` },
      }),
    { maxAttempts: 3, label: `${role} session.create` }
  );
  const sessionId = sessionResult.data!.id;
  const model = getModelForRole(role, workspace);

  const parts: string[] = [];

  parts.push(buildBindPrompt(workspace, role));

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
          ...(model ? { model } : {}),
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
