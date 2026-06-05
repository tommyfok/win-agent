import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { select, insert } from '../../db/repository.js';
import { filterMessagesForRole } from '../dispatch-filter.js';
import { TaskStatus, MessageStatus } from '../../db/types.js';
import { Role } from '../role-manager.js';

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

function addDep(taskId: number, dependsOnId: number) {
  insert('task_dependencies', { task_id: taskId, depends_on: dependsOnId });
}

describe('filterMessagesForRole', () => {
  describe('DEV role', () => {
    it('skips messages for paused tasks', () => {
      const taskId = createTask('Task', TaskStatus.Paused);
      const msgId = createMessage(Role.PM, Role.DEV, 'directive', taskId);

      const filtered = filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(0);
      const msg = select<{ status: string }>('messages', { id: msgId })[0];
      expect(msg.status).toBe(MessageStatus.Read);
    });

    it('skips messages for cancelled tasks', () => {
      const taskId = createTask('Task', TaskStatus.Cancelled);
      const msgId = createMessage(Role.PM, Role.DEV, 'directive', taskId);

      const filtered = filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(0);
    });

    it('defers messages for blocked tasks', () => {
      const taskId = createTask('Task', TaskStatus.Blocked);
      const msgId = createMessage(Role.PM, Role.DEV, 'directive', taskId);

      const filtered = filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(0);
      const msg = select<{ status: string }>('messages', { id: msgId })[0];
      expect(msg.status).toBe(MessageStatus.Deferred);
    });

    it('defers directive messages when dependencies are unmet', () => {
      const depId = createTask('Dep', TaskStatus.PendingDev);
      const taskId = createTask('Task', TaskStatus.PendingDev);
      addDep(taskId, depId);
      const msgId = createMessage(Role.PM, Role.DEV, 'directive', taskId);

      const filtered = filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(0);
      const msg = select<{ status: string }>('messages', { id: msgId })[0];
      expect(msg.status).toBe(MessageStatus.Deferred);
      const task = select<{ status: string }>('tasks', { id: taskId })[0];
      expect(task.status).toBe(TaskStatus.Blocked);
    });

    it('skips stale directive messages for done tasks', () => {
      const taskId = createTask('Task', TaskStatus.Done);
      const msgId = createMessage(Role.PM, Role.DEV, 'directive', taskId);

      const filtered = filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(0);
      const msg = select<{ status: string }>('messages', { id: msgId })[0];
      expect(msg.status).toBe(MessageStatus.Read);
    });

    it('delivers cancel_task messages even for done tasks', () => {
      const taskId = createTask('Task', TaskStatus.Done);
      const msgId = createMessage(Role.PM, Role.DEV, 'cancel_task', taskId);

      const filtered = filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'cancel_task',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(1);
    });

    it.each([
      ['intent=reject', { intent: 'reject' }],
      ['result=rejected', { result: 'rejected' }],
      ['action=reject', { action: 'reject' }],
    ] as const)(
      'delivers feedback messages and auto-rejects done tasks only with explicit %s',
      (_label, rejectFields) => {
        const taskId = createTask('Task', TaskStatus.Done);
        const msgId = createMessage(Role.PM, Role.DEV, 'feedback', taskId);
        const attachments = JSON.stringify({
          protocol: 'win-agent.message.v1',
          type: 'feedback',
          task_id: taskId,
          ...rejectFields,
        });

        const filtered = filterMessagesForRole(Role.DEV, [
          {
            id: msgId,
            from_role: Role.PM,
            to_role: Role.DEV,
            type: 'feedback',
            content: 'needs fix',
            status: 'unread',
            related_task_id: taskId,
            related_iteration_id: null,
            attachments,
            created_at: '',
            retry_count: 0,
            last_retry_at: null,
          },
        ]);

        expect(filtered).toHaveLength(1);
        const task = select<{ status: string; rejection_reason: string | null }>('tasks', {
          id: taskId,
        })[0];
        expect(task.status).toBe(TaskStatus.Rejected);
        expect(task.rejection_reason).toBe('needs fix');
      }
    );

    it('delivers ordinary feedback on done tasks without changing task status', () => {
      const taskId = createTask('Task', TaskStatus.Done);
      const msgId = createMessage(Role.PM, Role.DEV, 'feedback', taskId);

      const filtered = filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'feedback',
          content: 'additional context',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(1);
      const task = select<{ status: string; rejection_reason: string | null }>('tasks', {
        id: taskId,
      })[0];
      expect(task.status).toBe(TaskStatus.Done);
      expect(task.rejection_reason).toBeNull();
    });

    it('delivers clarify feedback on done tasks without changing task status', () => {
      const taskId = createTask('Task', TaskStatus.Done);
      const msgId = createMessage(Role.PM, Role.DEV, 'feedback', taskId);
      const attachments = JSON.stringify({
        protocol: 'win-agent.message.v1',
        type: 'feedback',
        task_id: taskId,
        intent: 'clarify',
      });

      const filtered = filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'feedback',
          content: 'please clarify evidence',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(1);
      const task = select<{ status: string; rejection_reason: string | null }>('tasks', {
        id: taskId,
      })[0];
      expect(task.status).toBe(TaskStatus.Done);
      expect(task.rejection_reason).toBeNull();
    });

    it('delivers feedback with invalid attachments on done tasks without changing task status', () => {
      const taskId = createTask('Task', TaskStatus.Done);
      const msgId = createMessage(Role.PM, Role.DEV, 'feedback', taskId);

      const filtered = filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'feedback',
          content: 'not structured reject',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: '{nope',
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(1);
      const task = select<{ status: string; rejection_reason: string | null }>('tasks', {
        id: taskId,
      })[0];
      expect(task.status).toBe(TaskStatus.Done);
      expect(task.rejection_reason).toBeNull();
    });

    it('does not change status for feedback on non-done tasks', () => {
      const taskId = createTask('Task', TaskStatus.PendingDev);
      const msgId = createMessage(Role.PM, Role.DEV, 'feedback', taskId);

      filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'feedback',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      const task = select<{ status: string }>('tasks', { id: taskId })[0];
      expect(task.status).toBe(TaskStatus.PendingDev);
    });

    it('delivers directive messages for pending_dev tasks', () => {
      const taskId = createTask('Task', TaskStatus.PendingDev);
      const msgId = createMessage(Role.PM, Role.DEV, 'directive', taskId);

      const filtered = filterMessagesForRole(Role.DEV, [
        {
          id: msgId,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(1);
    });
  });

  describe('non-DEV roles', () => {
    it('returns all messages unchanged for PM', () => {
      const taskId = createTask('Task', TaskStatus.Done);
      const msgId = createMessage(Role.DEV, Role.PM, 'acceptance_report', taskId);

      const filtered = filterMessagesForRole(Role.PM, [
        {
          id: msgId,
          from_role: Role.DEV,
          to_role: Role.PM,
          type: 'acceptance_report',
          content: 'test',
          status: 'unread',
          related_task_id: taskId,
          related_iteration_id: null,
          attachments: null,
          created_at: '',
          retry_count: 0,
          last_retry_at: null,
        },
      ]);

      expect(filtered).toHaveLength(1);
    });
  });
});
