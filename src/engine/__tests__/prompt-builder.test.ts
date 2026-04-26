import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { insert } from '../../db/repository.js';
import { MessageStatus, TaskStatus } from '../../db/types.js';
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
});
