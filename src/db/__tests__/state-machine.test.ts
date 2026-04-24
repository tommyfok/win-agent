import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './test-helpers.js';
import { insert, update, select } from '../repository.js';
import { transitionTaskStatus, TASK_TRANSITIONS } from '../state-machine.js';
import { Role } from '../../engine/role-manager.js';
import { TaskStatus } from '../types.js';

beforeEach(() => {
  setupTestDb();
});

function createTask(status: TaskStatus): number {
  const { lastInsertRowid } = insert('tasks', { title: 'Test Task', status });
  return lastInsertRowid as number;
}

describe('TASK_TRANSITIONS', () => {
  it('covers all TaskStatus values', () => {
    const keys = Object.keys(TASK_TRANSITIONS);
    expect(keys).toContain(TaskStatus.PendingPm);
    expect(keys).toContain(TaskStatus.PendingDev);
    expect(keys).toContain(TaskStatus.InDev);
    expect(keys).toContain(TaskStatus.PendingReview);
    expect(keys).toContain(TaskStatus.InReview);
    expect(keys).toContain(TaskStatus.Blocked);
    expect(keys).toContain(TaskStatus.Rejected);
    expect(keys).toContain(TaskStatus.Done);
    expect(keys).toContain(TaskStatus.Cancelled);
    expect(keys).toContain(TaskStatus.Paused);
  });

  it('terminal states have no outgoing transitions', () => {
    expect(TASK_TRANSITIONS[TaskStatus.Done]).toHaveLength(0);
    expect(TASK_TRANSITIONS[TaskStatus.Cancelled]).toHaveLength(0);
  });
});

describe('transitionTaskStatus — legal transitions', () => {
  it('pending_dev → in_dev updates status and records task_event', () => {
    const id = createTask(TaskStatus.PendingDev);
    transitionTaskStatus(id, TaskStatus.PendingDev, TaskStatus.InDev, Role.SYS, 'dev started');

    const task = select<{ status: string; pre_suspend_status: string | null }>('tasks', { id })[0];
    expect(task.status).toBe(TaskStatus.InDev);
    expect(task.pre_suspend_status).toBeNull();

    const events = select<{ from_status: string; to_status: string }>('task_events', { task_id: id });
    expect(events).toHaveLength(1);
    expect(events[0].from_status).toBe(TaskStatus.PendingDev);
    expect(events[0].to_status).toBe(TaskStatus.InDev);
  });

  it('pending_dev → blocked saves pre_suspend_status', () => {
    const id = createTask(TaskStatus.PendingDev);
    transitionTaskStatus(id, TaskStatus.PendingDev, TaskStatus.Blocked, Role.SYS, 'dep unmet');

    const task = select<{ status: string; pre_suspend_status: string | null }>('tasks', { id })[0];
    expect(task.status).toBe(TaskStatus.Blocked);
    expect(task.pre_suspend_status).toBe(TaskStatus.PendingDev);
  });

  it('in_dev → blocked saves pre_suspend_status', () => {
    const id = createTask(TaskStatus.InDev);
    transitionTaskStatus(id, TaskStatus.InDev, TaskStatus.Blocked, Role.SYS, 'dep unmet during dev');

    const task = select<{ status: string; pre_suspend_status: string | null }>('tasks', { id })[0];
    expect(task.status).toBe(TaskStatus.Blocked);
    expect(task.pre_suspend_status).toBe(TaskStatus.InDev);
  });

  it('blocked → pending_dev clears pre_suspend_status', () => {
    const id = createTask(TaskStatus.Blocked);
    update('tasks', { id }, { pre_suspend_status: TaskStatus.PendingDev });

    transitionTaskStatus(id, TaskStatus.Blocked, TaskStatus.PendingDev, Role.SYS, 'dep resolved');

    const task = select<{ status: string; pre_suspend_status: string | null }>('tasks', { id })[0];
    expect(task.status).toBe(TaskStatus.PendingDev);
    expect(task.pre_suspend_status).toBeNull();
  });

  it('in_review → done records event with correct metadata', () => {
    const id = createTask(TaskStatus.InReview);
    transitionTaskStatus(id, TaskStatus.InReview, TaskStatus.Done, Role.PM, 'accepted');

    const events = select<{ changed_by: string; reason: string }>('task_events', { task_id: id });
    expect(events[0].changed_by).toBe(Role.PM);
    expect(events[0].reason).toBe('accepted');
  });

  it('rejected → pending_dev is allowed', () => {
    const id = createTask(TaskStatus.Rejected);
    transitionTaskStatus(id, TaskStatus.Rejected, TaskStatus.PendingDev, Role.PM, 'rework');
    expect(select<{ status: string }>('tasks', { id })[0].status).toBe(TaskStatus.PendingDev);
  });
});

describe('transitionTaskStatus — illegal transitions', () => {
  it('throws for pending_dev → done (skipping steps)', () => {
    const id = createTask(TaskStatus.PendingDev);
    expect(() =>
      transitionTaskStatus(id, TaskStatus.PendingDev, TaskStatus.Done, Role.SYS, 'skip')
    ).toThrow(
      '非法任务状态转换'
    );
  });

  it('throws for done → pending_dev (terminal state)', () => {
    const id = createTask(TaskStatus.Done);
    expect(() =>
      transitionTaskStatus(id, TaskStatus.Done, TaskStatus.PendingDev, Role.SYS, 'retry')
    ).toThrow(
      '非法任务状态转换'
    );
  });

  it('throws for cancelled → in_dev (terminal state)', () => {
    const id = createTask(TaskStatus.Cancelled);
    expect(() =>
      transitionTaskStatus(id, TaskStatus.Cancelled, TaskStatus.InDev, Role.SYS, 'resume')
    ).toThrow(
      '非法任务状态转换'
    );
  });

  it('throws for in_review → in_dev (back-transition)', () => {
    const id = createTask(TaskStatus.InReview);
    expect(() =>
      transitionTaskStatus(id, TaskStatus.InReview, TaskStatus.InDev, Role.SYS, 'back')
    ).toThrow(
      '非法任务状态转换'
    );
  });

  it('does not persist task update when transition is illegal', () => {
    const id = createTask(TaskStatus.PendingDev);
    expect(() =>
      transitionTaskStatus(id, TaskStatus.PendingDev, TaskStatus.Done, Role.SYS, 'skip')
    ).toThrow();
    expect(select<{ status: string }>('tasks', { id })[0].status).toBe(TaskStatus.PendingDev);
    expect(select('task_events', { task_id: id })).toHaveLength(0);
  });
});

describe('TASK_TRANSITION_ROLES', () => {
  it('PendingDev → InDev is restricted to DEV and system', () => {
    const id = createTask(TaskStatus.PendingDev);
    expect(() =>
      transitionTaskStatus(id, TaskStatus.PendingDev, TaskStatus.InDev, Role.PM, 'pm starts dev')
    ).toThrow('无权执行状态转换');
    // status unchanged
    expect(select<{ status: string }>('tasks', { id })[0].status).toBe(TaskStatus.PendingDev);
  });

  it('DEV can transition PendingDev → InDev', () => {
    const id = createTask(TaskStatus.PendingDev);
    transitionTaskStatus(id, TaskStatus.PendingDev, TaskStatus.InDev, Role.DEV, 'dev starts');
    expect(select<{ status: string }>('tasks', { id })[0].status).toBe(TaskStatus.InDev);
  });

  it('system can transition PendingDev → InDev', () => {
    const id = createTask(TaskStatus.PendingDev);
    transitionTaskStatus(id, TaskStatus.PendingDev, TaskStatus.InDev, Role.SYS, 'auto');
    expect(select<{ status: string }>('tasks', { id })[0].status).toBe(TaskStatus.InDev);
  });

  it('unrestricted transitions allow any role', () => {
    const id = createTask(TaskStatus.InReview);
    transitionTaskStatus(id, TaskStatus.InReview, TaskStatus.Done, Role.PM, 'accepted');
    expect(select<{ status: string }>('tasks', { id })[0].status).toBe(TaskStatus.Done);
  });
});
