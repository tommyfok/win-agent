import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { insert } from '../../db/repository.js';
import { MessageStatus, TaskStatus } from '../../db/types.js';
import { MESSAGE_PROTOCOL } from '../message-protocol.js';
import { buildDispatchPrompt } from '../prompt-builder.js';
import { Role } from '../role-manager.js';
import type { MessageRow } from '../dispatch-filter.js';

beforeEach(() => {
  setupTestDb();
});

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 1,
    from_role: Role.USER,
    to_role: Role.PM,
    type: 'system',
    content: 'user ping',
    status: MessageStatus.Unread,
    related_task_id: null,
    related_iteration_id: null,
    attachments: null,
    created_at: '',
    retry_count: 0,
    last_retry_at: null,
    ...overrides,
  };
}

function createTask(title: string, status: TaskStatus): number {
  const { lastInsertRowid } = insert('tasks', { title, status });
  return Number(lastInsertRowid);
}

describe('buildDispatchPrompt', () => {
  it('does not show stale DEV directives for done tasks in PM pending queue', () => {
    const doneTaskId = createTask('Done task', TaskStatus.Done);
    const activeTaskId = createTask('Active task', TaskStatus.InDev);

    insert('messages', {
      from_role: Role.PM,
      to_role: Role.DEV,
      type: 'directive',
      content: 'stale done directive',
      status: MessageStatus.Unread,
      related_task_id: doneTaskId,
    });
    insert('messages', {
      from_role: Role.PM,
      to_role: Role.DEV,
      type: 'directive',
      content: 'active directive',
      status: MessageStatus.Unread,
      related_task_id: activeTaskId,
    });

    const prompt = buildDispatchPrompt(Role.PM, [message()], [], null);

    expect(prompt).toContain('DEV 待处理队列（共 1 条未读）');
    expect(prompt).toContain('其他 task 共 1 条');
    expect(prompt).not.toContain('stale done directive');
  });

  it('shows structured message protocol attachments', () => {
    const prompt = buildDispatchPrompt(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: 'please implement feature',
          related_task_id: 123,
          attachments: JSON.stringify({
            protocol: MESSAGE_PROTOCOL,
            type: 'directive',
            task_id: 123,
            iteration_id: 7,
            spec_path: '.win-agent/docs/spec/demo.md',
          }),
        }),
      ],
      [],
      null
    );

    expect(prompt).toContain('please implement feature');
    expect(prompt).toContain('结构化消息 (protocol=win-agent.message.v1, type=directive');
    expect(prompt).toContain('task_id=123');
    expect(prompt).toContain('iteration_id=7');
    expect(prompt).toContain('"spec_path":".win-agent/docs/spec/demo.md"');
  });

  it('keeps non-protocol JSON and legacy messages visible', () => {
    const prompt = buildDispatchPrompt(
      Role.PM,
      [
        message({
          content: 'legacy content',
          attachments: JSON.stringify({ file: 'notes.txt', reason: 'legacy attachment' }),
        }),
        message({ id: 2, content: 'plain old message', attachments: null }),
      ],
      [],
      null
    );

    expect(prompt).toContain('legacy content');
    expect(prompt).toContain('attachments（非 win-agent.message.v1 协议 JSON，原样保留）');
    expect(prompt).toContain('"reason": "legacy attachment"');
    expect(prompt).toContain('plain old message');
  });
});
