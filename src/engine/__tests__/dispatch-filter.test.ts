import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { select, insert } from '../../db/repository.js';
import { filterMessagesForRole } from '../dispatch-filter.js';
import { TaskStatus, MessageStatus } from '../../db/types.js';

beforeEach(() => {
  setupTestDb();
});

function createTask(title: string, status: string = TaskStatus.PendingDev): number {
  const { lastInsertRowid } = insert('tasks', {
    title,
    status,
  });
  return lastInsertRowid as number;
}

function createMessage(
  fromRole: string,
  toRole: string,
  type: string,
  taskId: number | null,
  status = MessageStatus.Unread
): number {
  const { lastInsertRowid } = insert('messages', {
    from_role: fromRole,
    to_role: toRole,
    type,
    content: `Test message`,
    related_task_id: taskId,
    status,
  });
  return lastInsertRowid as number;
}

describe('filterMessagesForRole', () => {
  describe('DEV role', () => {
    it('skips messages for paused tasks', () => {
      const taskId = createTask('Task', TaskStatus.Paused);
      const msgId = createMessage('PM', 'DEV', 'directive', taskId);

      const filtered = filterMessagesForRole('DEV', [
        {
          id: msgId,
          from_role: 'PM',
          to_role: 'DEV',
          type: 'directive',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
        },
      ]);

      expect(filtered).toHaveLength(0);
      const msg = select<{ status: string }>('messages', { id: msgId })[0];
      expect(msg.status).toBe(MessageStatus.Read);
    });

    it('skips messages for cancelled tasks', () => {
      const taskId = createTask('Task', TaskStatus.Cancelled);
      const msgId = createMessage('PM', 'DEV', 'directive', taskId);

      const filtered = filterMessagesForRole('DEV', [
        {
          id: msgId,
          from_role: 'PM',
          to_role: 'DEV',
          type: 'directive',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
        },
      ]);

      expect(filtered).toHaveLength(0);
    });

    it('skips messages for blocked tasks', () => {
      const taskId = createTask('Task', TaskStatus.Blocked);
      const msgId = createMessage('PM', 'DEV', 'directive', taskId);

      const filtered = filterMessagesForRole('DEV', [
        {
          id: msgId,
          from_role: 'PM',
          to_role: 'DEV',
          type: 'directive',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
        },
      ]);

      expect(filtered).toHaveLength(0);
    });

    it('delivers cancel_task messages even for done tasks', () => {
      const taskId = createTask('Task', TaskStatus.Done);
      const msgId = createMessage('PM', 'DEV', 'cancel_task', taskId);

      const filtered = filterMessagesForRole('DEV', [
        {
          id: msgId,
          from_role: 'PM',
          to_role: 'DEV',
          type: 'cancel_task',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
        },
      ]);

      expect(filtered).toHaveLength(1);
    });

    it('delivers feedback messages and auto-rejects done tasks', () => {
      const taskId = createTask('Task', TaskStatus.Done);
      const msgId = createMessage('PM', 'DEV', 'feedback', taskId);

      const filtered = filterMessagesForRole('DEV', [
        {
          id: msgId,
          from_role: 'PM',
          to_role: 'DEV',
          type: 'feedback',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
        },
      ]);

      expect(filtered).toHaveLength(1);
      const task = select<{ status: string }>('tasks', { id: taskId })[0];
      expect(task.status).toBe(TaskStatus.Rejected);
    });

    it('does not change status for feedback on non-done tasks', () => {
      const taskId = createTask('Task', TaskStatus.PendingDev);
      const msgId = createMessage('PM', 'DEV', 'feedback', taskId);

      filterMessagesForRole('DEV', [
        {
          id: msgId,
          from_role: 'PM',
          to_role: 'DEV',
          type: 'feedback',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
        },
      ]);

      const task = select<{ status: string }>('tasks', { id: taskId })[0];
      expect(task.status).toBe(TaskStatus.PendingDev);
    });

    it('delivers directive messages for pending_dev tasks', () => {
      const taskId = createTask('Task', TaskStatus.PendingDev);
      const msgId = createMessage('PM', 'DEV', 'directive', taskId);

      const filtered = filterMessagesForRole('DEV', [
        {
          id: msgId,
          from_role: 'PM',
          to_role: 'DEV',
          type: 'directive',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
        },
      ]);

      expect(filtered).toHaveLength(1);
    });
  });

  describe('non-DEV roles', () => {
    it('returns all messages unchanged for PM', () => {
      const taskId = createTask('Task', TaskStatus.Done);
      const msgId = createMessage('DEV', 'PM', 'acceptance_report', taskId);

      const filtered = filterMessagesForRole('PM', [
        {
          id: msgId,
          from_role: 'DEV',
          to_role: 'PM',
          type: 'acceptance_report',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
        },
      ]);

      expect(filtered).toHaveLength(1);
    });
  });
});
