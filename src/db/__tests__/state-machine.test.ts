import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './test-helpers.js';
import { insert, update, select } from '../repository.js';
import { transitionTaskStatus, TASK_TRANSITIONS } from '../state-machine.js';

beforeEach(() => {
  setupTestDb();
});

function createTask(status: string): number {
  const { lastInsertRowid } = insert('tasks', { title: 'Test Task', status });
  return lastInsertRowid as number;
}

describe('TASK_TRANSITIONS', () => {
  it('covers all TaskStatus values', () => {
    const keys = Object.keys(TASK_TRANSITIONS);
    expect(keys).toContain('pending_pm');
    expect(keys).toContain('pending_dev');
    expect(keys).toContain('in_dev');
    expect(keys).toContain('pending_review');
    expect(keys).toContain('in_review');
    expect(keys).toContain('blocked');
    expect(keys).toContain('rejected');
    expect(keys).toContain('done');
    expect(keys).toContain('cancelled');
    expect(keys).toContain('paused');
  });

  it('terminal states have no outgoing transitions', () => {
    expect(TASK_TRANSITIONS['done']).toHaveLength(0);
    expect(TASK_TRANSITIONS['cancelled']).toHaveLength(0);
  });
});

describe('transitionTaskStatus — legal transitions', () => {
  it('pending_dev → in_dev updates status and records task_event', () => {
    const id = createTask('pending_dev');
    transitionTaskStatus(id, 'pending_dev', 'in_dev', 'system', 'dev started');

    const task = select<{ status: string; pre_suspend_status: string | null }>('tasks', { id })[0];
    expect(task.status).toBe('in_dev');
    expect(task.pre_suspend_status).toBeNull();

    const events = select<{ from_status: string; to_status: string }>('task_events', { task_id: id });
    expect(events).toHaveLength(1);
    expect(events[0].from_status).toBe('pending_dev');
    expect(events[0].to_status).toBe('in_dev');
  });

  it('pending_dev → blocked saves pre_suspend_status', () => {
    const id = createTask('pending_dev');
    transitionTaskStatus(id, 'pending_dev', 'blocked', 'system', 'dep unmet');

    const task = select<{ status: string; pre_suspend_status: string | null }>('tasks', { id })[0];
    expect(task.status).toBe('blocked');
    expect(task.pre_suspend_status).toBe('pending_dev');
  });

  it('in_dev → blocked saves pre_suspend_status', () => {
    const id = createTask('in_dev');
    transitionTaskStatus(id, 'in_dev', 'blocked', 'system', 'dep unmet during dev');

    const task = select<{ status: string; pre_suspend_status: string | null }>('tasks', { id })[0];
    expect(task.status).toBe('blocked');
    expect(task.pre_suspend_status).toBe('in_dev');
  });

  it('blocked → pending_dev clears pre_suspend_status', () => {
    const id = createTask('blocked');
    update('tasks', { id }, { pre_suspend_status: 'pending_dev' });

    transitionTaskStatus(id, 'blocked', 'pending_dev', 'system', 'dep resolved');

    const task = select<{ status: string; pre_suspend_status: string | null }>('tasks', { id })[0];
    expect(task.status).toBe('pending_dev');
    expect(task.pre_suspend_status).toBeNull();
  });

  it('in_review → done records event with correct metadata', () => {
    const id = createTask('in_review');
    transitionTaskStatus(id, 'in_review', 'done', 'PM', 'accepted');

    const events = select<{ changed_by: string; reason: string }>('task_events', { task_id: id });
    expect(events[0].changed_by).toBe('PM');
    expect(events[0].reason).toBe('accepted');
  });

  it('rejected → pending_dev is allowed', () => {
    const id = createTask('rejected');
    transitionTaskStatus(id, 'rejected', 'pending_dev', 'PM', 'rework');
    expect(select<{ status: string }>('tasks', { id })[0].status).toBe('pending_dev');
  });
});

describe('transitionTaskStatus — illegal transitions', () => {
  it('throws for pending_dev → done (skipping steps)', () => {
    const id = createTask('pending_dev');
    expect(() => transitionTaskStatus(id, 'pending_dev', 'done', 'system', 'skip')).toThrow(
      '非法任务状态转换'
    );
  });

  it('throws for done → pending_dev (terminal state)', () => {
    const id = createTask('done');
    expect(() => transitionTaskStatus(id, 'done', 'pending_dev', 'system', 'retry')).toThrow(
      '非法任务状态转换'
    );
  });

  it('throws for cancelled → in_dev (terminal state)', () => {
    const id = createTask('cancelled');
    expect(() => transitionTaskStatus(id, 'cancelled', 'in_dev', 'system', 'resume')).toThrow(
      '非法任务状态转换'
    );
  });

  it('throws for in_review → in_dev (back-transition)', () => {
    const id = createTask('in_review');
    expect(() => transitionTaskStatus(id, 'in_review', 'in_dev', 'system', 'back')).toThrow(
      '非法任务状态转换'
    );
  });

  it('does not persist task update when transition is illegal', () => {
    const id = createTask('pending_dev');
    expect(() => transitionTaskStatus(id, 'pending_dev', 'done', 'system', 'skip')).toThrow();
    expect(select<{ status: string }>('tasks', { id })[0].status).toBe('pending_dev');
    expect(select('task_events', { task_id: id })).toHaveLength(0);
  });
});
