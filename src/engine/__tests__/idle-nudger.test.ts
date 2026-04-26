import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { insert, select } from '../../db/repository.js';
import { MessageStatus, TaskStatus } from '../../db/types.js';
import { Role } from '../role-manager.js';
import { IdleNudger } from '../idle-nudger.js';
import type { RoleRuntimeState } from '../session-reconciler.js';

let mockNow: ReturnType<typeof vi.spyOn>;
let mockLog: ReturnType<typeof vi.spyOn>;
let baseTime: number;

beforeEach(() => {
  setupTestDb();
  baseTime = Date.now();
  mockNow = vi.spyOn(Date, 'now').mockReturnValue(baseTime);
  mockLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  mockNow.mockRestore();
  mockLog.mockRestore();
});

function state(role: Role, serverBusy: boolean): RoleRuntimeState {
  return {
    role,
    sessionId: `${role}-session`,
    serverStatus: serverBusy ? { type: 'busy' } : { type: 'idle' },
    serverBusy,
    localBusy: serverBusy,
    drift: 'none',
  };
}

function states(pmBusy = false, devBusy = false): Map<Role, RoleRuntimeState> {
  return new Map([
    [Role.PM, state(Role.PM, pmBusy)],
    [Role.DEV, state(Role.DEV, devBusy)],
  ]);
}

function createNudger(devLastDispatchEnd = 0) {
  return new IdleNudger({
    getPmLastDispatchEnd: () => baseTime - 11 * 60 * 1000,
    getDevLastDispatchEnd: () => devLastDispatchEnd,
  });
}

function createTask(status: TaskStatus, title = 'Task'): number {
  const { lastInsertRowid } = insert('tasks', { title, status });
  return Number(lastInsertRowid);
}

function createMessage(
  fromRole: string,
  toRole: string,
  type: string,
  relatedTaskId?: number
): number {
  const { lastInsertRowid } = insert('messages', {
    from_role: fromRole,
    to_role: toRole,
    type,
    content: 'test content',
    status: MessageStatus.Unread,
    related_task_id: relatedTaskId ?? null,
  });
  return Number(lastInsertRowid);
}

describe('IdleNudger', () => {
  it('does not send PM reminder while PM is busy', async () => {
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const nudger = createNudger(baseTime - 11 * 60 * 1000);

    nudger.detect(states(true, false));

    expect(select('messages', { to_role: Role.PM, from_role: Role.SYS })).toHaveLength(0);
  });

  it('does not send PM reminder while DEV is busy', async () => {
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const nudger = createNudger(baseTime - 11 * 60 * 1000);

    nudger.detect(states(false, true));

    expect(select('messages', { to_role: Role.PM, from_role: Role.SYS })).toHaveLength(0);
  });

  it('does not send PM reminder when DEV was recently active', async () => {
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const nudger = createNudger(baseTime - 5 * 60 * 1000);

    nudger.detect(states(false, false));

    expect(select('messages', { to_role: Role.PM, from_role: Role.SYS })).toHaveLength(0);
  });

  it('sends PM reminder for a pending_dev task without directive', async () => {
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const nudger = createNudger(baseTime - 11 * 60 * 1000);

    nudger.detect(states(false, false));

    const msgs = select<{ content: string }>('messages', {
      to_role: Role.PM,
      from_role: Role.SYS,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('待派发');
    expect(msgs[0].content).toContain('11');
  });

  it('does not send PM reminder when directive already exists', async () => {
    const taskId = createTask(TaskStatus.PendingDev, 'Pending Task');
    createMessage(Role.PM, Role.DEV, 'directive', taskId);
    const nudger = createNudger(baseTime - 11 * 60 * 1000);

    nudger.detect(states(false, false));

    expect(select('messages', { to_role: Role.PM, from_role: Role.SYS })).toHaveLength(0);
  });

  it('combines blocked, review, and unread-message issues in one PM reminder', async () => {
    createTask(TaskStatus.Blocked, 'Blocked Task');
    createTask(TaskStatus.PendingReview, 'Review Task');
    createMessage(Role.USER, Role.PM, 'feedback');
    const nudger = createNudger(baseTime - 11 * 60 * 1000);

    nudger.detect(states(false, false));

    const msgs = select<{ content: string }>('messages', {
      to_role: Role.PM,
      from_role: Role.SYS,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('被阻塞');
    expect(msgs[0].content).toContain('待验收');
    expect(msgs[0].content).toContain('未读消息');
  });

  it('does not send duplicate PM reminders within reminder interval', async () => {
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const nudger = createNudger(baseTime - 11 * 60 * 1000);

    nudger.detect(states(false, false));
    mockNow.mockReturnValue(baseTime + 60 * 1000);
    nudger.detect(states(false, false));

    expect(select('messages', { to_role: Role.PM, from_role: Role.SYS })).toHaveLength(1);
  });

  it('sends a second PM reminder after reminder interval', async () => {
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const nudger = createNudger(baseTime - 11 * 60 * 1000);

    nudger.detect(states(false, false));
    // 11min initial idle + 10min advance = 21min reported.
    mockNow.mockReturnValue(baseTime + 10 * 60 * 1000);
    nudger.detect(states(false, false));

    const msgs = select<{ content: string }>('messages', {
      to_role: Role.PM,
      from_role: Role.SYS,
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toContain('21');
  });

  it('writes log when sending PM reminder', async () => {
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const nudger = createNudger(baseTime - 11 * 60 * 1000);

    nudger.detect(states(false, false));

    expect(select('logs', { action: 'pm_idle_reminder' })).toHaveLength(1);
  });

  it('sends DEV pending-work reminder when in_dev task has no directive', async () => {
    const taskId = createTask(TaskStatus.InDev, 'In Dev Task');
    const nudger = createNudger(baseTime - 11 * 60 * 1000);

    nudger.detect(states(false, false));

    const msgs = select<{ content: string; related_task_id: number }>('messages', {
      to_role: Role.DEV,
      from_role: Role.SYS,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('In Dev Task');
    expect(msgs[0].related_task_id).toBe(taskId);
    expect(select('logs', { action: 'dev_pending_work_reminder' })).toHaveLength(1);
  });

  it('does not send DEV pending-work reminder when DEV was recently active', async () => {
    createTask(TaskStatus.InDev, 'In Dev Task');
    const nudger = createNudger(baseTime - 5 * 60 * 1000);

    nudger.detect(states(false, false));

    expect(select('messages', { to_role: Role.DEV, from_role: Role.SYS })).toHaveLength(0);
  });
});
