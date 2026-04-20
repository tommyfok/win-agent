import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { select, insert } from '../../db/repository.js';
import { PmIdleMonitor } from '../pm-idle-monitor.js';
import { Role, RoleManager } from '../role-manager.js';
import { MessageStatus, TaskStatus } from '../../db/types.js';
import * as schedulerDispatch from '../scheduler-dispatch.js';

let mockNow: ReturnType<typeof vi.spyOn>;
let realNow: () => number;
let monitor: PmIdleMonitor;
let pmLastDispatchEnd: number;
let mockGetDevLastDispatchEnd: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setupTestDb();
  monitor = new PmIdleMonitor();
  pmLastDispatchEnd = 0;
  // Save real Date.now
  realNow = Date.now.bind(Date);
  mockNow = vi.spyOn(Date, 'now');
  // Set default mock to return real time
  mockNow.mockImplementation(realNow);
  // Mock getDevLastDispatchEnd - default to very old time (DEV idle)
  mockGetDevLastDispatchEnd = vi.spyOn(schedulerDispatch, 'getDevLastDispatchEnd');
  mockGetDevLastDispatchEnd.mockReturnValue(0);
});

afterEach(() => {
  mockNow.mockRestore();
  mockGetDevLastDispatchEnd.mockRestore();
});

function createRoleManager(): RoleManager {
  return new RoleManager();
}

function createTask(status: TaskStatus, title = 'Task'): number {
  const { lastInsertRowid } = insert('tasks', { title, status });
  return lastInsertRowid as number;
}

function createMessage(from_role: string, to_role: string, type: string, related_task_id?: number): number {
  const { lastInsertRowid } = insert('messages', {
    from_role,
    to_role,
    type,
    content: 'test content',
    status: MessageStatus.Unread,
    related_task_id: related_task_id ?? null,
  });
  return lastInsertRowid as number;
}

describe('checkPmIdle', () => {
  it('does not trigger when PM is busy', () => {
    const rm = createRoleManager();
    rm.setBusy(Role.PM, true);
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(0);
  });

  it('does not trigger when idle time is below threshold', () => {
    const rm = createRoleManager();
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 9 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(0);
  });

  it('triggers when pending_dev task without directive', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select<{ content: string }>('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('待派发');
    expect(msgs[0].content).toContain('11');
  });

  it('does not trigger when directive already sent', () => {
    const rm = createRoleManager();
    const taskId = createTask(TaskStatus.PendingDev, 'Pending Task');
    createMessage(Role.PM, Role.DEV, 'directive', taskId);
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(0);
  });

  it('triggers when blocked task exists', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.Blocked, 'Blocked Task');
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select<{ content: string }>('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('被阻塞');
  });

  it('triggers when in_dev task but DEV idle', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.InDev, 'In Dev Task');
    rm.setBusy(Role.DEV, false);
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select<{ content: string }>('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('DEV空闲');
  });

  it('does not trigger when in_dev task and DEV busy', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.InDev, 'In Dev Task');
    rm.setBusy(Role.DEV, true);
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(0);
  });

  it('triggers when pending_review task exists', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.PendingReview, 'Review Task');
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select<{ content: string }>('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('待验收');
  });

  it('triggers when PM has unread messages from user/DEV', () => {
    const rm = createRoleManager();
    createMessage(Role.USER, Role.PM, 'feedback');
    createMessage(Role.DEV, Role.PM, 'feedback');
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select<{ content: string }>('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('未读消息');
    expect(msgs[0].content).toContain('2');
  });

  it('ignores system messages when checking unread', () => {
    const rm = createRoleManager();
    createMessage(Role.SYS, Role.PM, 'system');
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select('messages', { to_role: Role.PM, from_role: Role.SYS });
    // Should not have reminder (system message is ignored, no issues)
    expect(msgs.length).toBe(1); // only the original system message
  });

  it('does not send reminder twice within interval', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;

    // First check at baseTime
    mockNow.mockReturnValue(baseTime);
    monitor.check(rm, pmLastDispatchEnd);

    // Second check 1 minute later (within 10min reminder interval)
    mockNow.mockReturnValue(baseTime + 1 * 60 * 1000);
    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(1); // only one reminder
  });

  it('sends second reminder after interval', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;

    // First reminder at baseTime
    mockNow.mockReturnValue(baseTime);
    monitor.check(rm, pmLastDispatchEnd);

    // Second reminder after 10 min interval
    // Idle time will be 21 min total
    mockNow.mockReturnValue(baseTime + 10 * 60 * 1000);
    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select<{ content: string }>('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(2);
    // Second reminder should show 21 minutes
    expect(msgs[1].content).toContain('21');
  });

  it('writes log when sending reminder', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.PendingDev, 'Pending Task');
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const logs = select<{ action: string }>('logs', { action: 'pm_idle_reminder' });
    expect(logs.length).toBe(1);
  });

  it('combines multiple issues in one message', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.PendingDev, 'Pending Task 1');
    createTask(TaskStatus.Blocked, 'Blocked Task 2');
    createMessage(Role.USER, Role.PM, 'feedback');
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select<{ content: string }>('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('待派发');
    expect(msgs[0].content).toContain('被阻塞');
    expect(msgs[0].content).toContain('未读消息');
  });

  it('does not trigger when DEV busy and recently active', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.PendingDev, 'Pending Task');
    rm.setBusy(Role.DEV, true);
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);
    // DEV was active 5 minutes ago (below threshold)
    mockGetDevLastDispatchEnd.mockReturnValue(baseTime - 5 * 60 * 1000);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(0);
  });

  it('triggers when DEV busy but idle for threshold', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.PendingDev, 'Pending Task');
    rm.setBusy(Role.DEV, true);
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);
    // DEV was active 11 minutes ago (above threshold)
    mockGetDevLastDispatchEnd.mockReturnValue(baseTime - 11 * 60 * 1000);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select<{ content: string }>('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('待派发');
  });

  it('triggers when DEV not busy regardless of last activity', () => {
    const rm = createRoleManager();
    createTask(TaskStatus.PendingDev, 'Pending Task');
    rm.setBusy(Role.DEV, false);
    const baseTime = realNow();
    pmLastDispatchEnd = baseTime - 11 * 60 * 1000;
    mockNow.mockReturnValue(baseTime);
    // DEV was active 1 minute ago - still triggers because DEV not busy
    mockGetDevLastDispatchEnd.mockReturnValue(baseTime - 1 * 60 * 1000);

    monitor.check(rm, pmLastDispatchEnd);

    const msgs = select<{ content: string }>('messages', { to_role: Role.PM, from_role: Role.SYS });
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain('待派发');
  });
});