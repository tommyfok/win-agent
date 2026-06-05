import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { insert, select } from '../../db/repository.js';
import { MessageStatus, TaskStatus } from '../../db/types.js';
import { Role } from '../../engine/role-manager.js';
import { registerTaskCommands } from '../task.js';

vi.mock('../../config/index.js', () => ({
  checkEngineRunning: vi.fn(() => ({ running: true, pid: 1234 })),
  getDbPath: vi.fn(() => ':memory:'),
}));

interface MessageRow {
  status: string;
}

interface TaskRow {
  status: string;
  pre_suspend_status: string | null;
}

beforeEach(() => {
  setupTestDb();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createTask(status: TaskStatus): number {
  return Number(
    insert('tasks', {
      title: 'Keep PM feedback visible',
      status,
    }).lastInsertRowid
  );
}

function createMessage(fromRole: Role, toRole: Role, type: string, taskId: number): number {
  return Number(
    insert('messages', {
      from_role: fromRole,
      to_role: toRole,
      type,
      content: `${fromRole}->${toRole} ${type}`,
      status: MessageStatus.Unread,
      related_task_id: taskId,
    }).lastInsertRowid
  );
}

function getMessageStatus(messageId: number): string {
  return select<MessageRow>('messages', { id: messageId })[0].status;
}

async function runTaskCommand(command: 'pause' | 'cancel', taskId: number): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerTaskCommands(program);

  await program.parseAsync(['task', command, String(taskId)], { from: 'user' });
}

describe('task pause/cancel message cleanup', () => {
  it.each([
    {
      command: 'pause' as const,
      initialStatus: TaskStatus.PendingDev,
      expectedStatus: TaskStatus.Paused,
    },
    {
      command: 'cancel' as const,
      initialStatus: TaskStatus.InDev,
      expectedStatus: TaskStatus.Cancelled,
    },
  ])(
    '$command preserves DEV->PM feedback while clearing stale DEV execution messages',
    async ({ command, initialStatus, expectedStatus }) => {
      const taskId = createTask(initialStatus);
      const devFeedbackToPm = createMessage(Role.DEV, Role.PM, 'feedback', taskId);
      const devReviewToPm = createMessage(Role.DEV, Role.PM, 'review_result', taskId);
      const pmDirectiveToDev = createMessage(Role.PM, Role.DEV, 'directive', taskId);
      const sysSystemToDev = createMessage(Role.SYS, Role.DEV, 'system', taskId);
      const sysNotificationToDev = createMessage(Role.SYS, Role.DEV, 'notification', taskId);
      const pmCancelToDev = createMessage(Role.PM, Role.DEV, 'cancel_task', taskId);

      await runTaskCommand(command, taskId);

      const task = select<TaskRow>('tasks', { id: taskId })[0];
      expect(task.status).toBe(expectedStatus);
      if (command === 'pause') {
        expect(task.pre_suspend_status).toBe(initialStatus);
      }

      expect(getMessageStatus(devFeedbackToPm)).toBe(MessageStatus.Unread);
      expect(getMessageStatus(devReviewToPm)).toBe(MessageStatus.Unread);
      expect(getMessageStatus(pmDirectiveToDev)).toBe(MessageStatus.Read);
      expect(getMessageStatus(sysSystemToDev)).toBe(MessageStatus.Read);
      expect(getMessageStatus(sysNotificationToDev)).toBe(MessageStatus.Read);
      expect(getMessageStatus(pmCancelToDev)).toBe(MessageStatus.Read);
    }
  );
});
