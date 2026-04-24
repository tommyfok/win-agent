import type { OpencodeClient } from '@opencode-ai/sdk';
import { insertMemory } from '../embedding/memory.js';
import { withTimeout } from './retry.js';
import { insert as dbInsert } from '../db/repository.js';
import type { Role } from './role-manager.js';
import { getModelForRole } from './role-model.js';

export const WRITE_MEMORY_PROMPT = `你即将被轮转到一个新的 session。请总结你当前的工作状态，包括：

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

/**
 * Ask a role to write a memory summary and persist it.
 * Shared by session rotation (rotateSession) and engine shutdown (writeAllMemories).
 *
 * Throws on timeout or API error — callers handle errors differently:
 * - rotateSession: catches and logs warning, continues with rotation
 * - writeAllMemories: catches and logs warning per role
 */
export async function writeMemory(
  client: OpencodeClient,
  role: Role,
  sessionId: string,
  trigger: string,
  timeoutMs: number = 3 * 60 * 1000
): Promise<void> {
  const model = getModelForRole(role);
  const result = await withTimeout(
    client.session.prompt({
      path: { id: sessionId },
      body: {
        ...(model ? { model } : {}),
        parts: [{ type: 'text', text: WRITE_MEMORY_PROMPT }],
      },
    }),
    timeoutMs,
    `${role} memory write`
  );

  const textParts = result.data?.parts?.filter(
    (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
  );
  if (textParts && textParts.length > 0) {
    const text = textParts[0].text || '';
    const parsed = parseMemoryResponse(text);
    if (parsed) {
      await insertMemory({ role, summary: parsed.summary, content: parsed.content, trigger });
    }
    try {
      dbInsert('role_outputs', {
        role,
        session_id: sessionId,
        input_summary: WRITE_MEMORY_PROMPT.slice(0, 500),
        output_text: text,
        input_tokens: result.data?.info?.tokens?.input ?? 0,
        output_tokens: result.data?.info?.tokens?.output ?? 0,
      });
    } catch {
      /* Non-fatal */
    }
  }
}

/**
 * Parse LLM memory response with fallback.
 * Tries JSON code block first, then raw JSON, then plain text fallback.
 */
function parseMemoryResponse(text: string): { summary: string; content: string } | null {
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
    const lines = trimmed.split('\n');
    const summary = lines[0].slice(0, 200);
    return { summary, content: trimmed };
  }

  return null;
}
