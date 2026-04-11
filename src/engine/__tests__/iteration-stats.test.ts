import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { insert } from '../../db/repository.js';
import { generateIterationStats } from '../iteration-stats.js';

beforeEach(() => {
  setupTestDb();
});

function createIteration(): number {
  return insert('iterations', { name: 'Sprint 1', status: 'active' }).lastInsertRowid as number;
}

function createTask(iterationId: number, title: string, status: string): number {
  return insert('tasks', { title, status, iteration_id: iterationId }).lastInsertRowid as number;
}

function addRejectionEvent(taskId: number): void {
  insert('task_events', {
    task_id: taskId,
    from_status: 'in_dev',
    to_status: 'rejected',
    changed_by: 'PM',
    reason: 'does not meet criteria',
  });
}

describe('generateIterationStats', () => {
  it('includes the iteration ID in the header', () => {
    const iterId = createIteration();
    const report = generateIterationStats(iterId);
    expect(report).toContain(`## 迭代 #${iterId}`);
  });

  it('reports task status counts correctly', () => {
    const iterId = createIteration();
    createTask(iterId, 'Task A', 'done');
    createTask(iterId, 'Task B', 'done');
    createTask(iterId, 'Task C', 'rejected');
    createTask(iterId, 'Task D', 'pending_dev');

    const report = generateIterationStats(iterId);

    expect(report).toContain('共 4 个');
    expect(report).toContain('done: 2');
    expect(report).toContain('rejected: 1');
    expect(report).toContain('pending_dev: 1');
  });

  it('counts rejection events from task_events (not current status)', () => {
    const iterId = createIteration();
    const taskId = createTask(iterId, 'Bouncy Task', 'done');
    // Task was rejected twice before finally being done
    addRejectionEvent(taskId);
    addRejectionEvent(taskId);

    const report = generateIterationStats(iterId);

    expect(report).toContain('累计打回次数: 2');
  });

  it('shows zero rejections when no rejection events exist', () => {
    const iterId = createIteration();
    createTask(iterId, 'Clean Task', 'done');

    const report = generateIterationStats(iterId);

    expect(report).toContain('累计打回次数: 0');
    expect(report).toContain('打回率: 0%');
  });

  it('counts tasks that were ever blocked', () => {
    const iterId = createIteration();
    const taskId = createTask(iterId, 'Blocked Task', 'done');
    insert('task_events', {
      task_id: taskId,
      from_status: 'pending_dev',
      to_status: 'blocked',
      changed_by: 'system',
      reason: 'dep unmet',
    });

    const report = generateIterationStats(iterId);

    expect(report).toContain('曾被阻塞的任务数: 1');
  });

  it('includes token consumption section when role_outputs exist', () => {
    const iterId = createIteration();
    insert('role_outputs', {
      role: 'PM',
      session_id: 'sess-1',
      input_summary: 'summary',
      output_text: 'output',
      input_tokens: 1000,
      output_tokens: 500,
      related_iteration_id: iterId,
    });
    insert('role_outputs', {
      role: 'DEV',
      session_id: 'sess-2',
      input_summary: 'summary',
      output_text: 'output',
      input_tokens: 2000,
      output_tokens: 800,
      related_iteration_id: iterId,
    });

    const report = generateIterationStats(iterId);

    expect(report).toContain('Token 消耗');
    expect(report).toContain('PM');
    expect(report).toContain('DEV');
    expect(report).toContain('合计');
  });

  it('skips token section when no role_outputs exist', () => {
    const iterId = createIteration();
    createTask(iterId, 'Task', 'done');

    const report = generateIterationStats(iterId);

    expect(report).not.toContain('Token 消耗');
  });

  it('shows top rejected tasks section', () => {
    const iterId = createIteration();
    const t1 = createTask(iterId, 'Problem Task', 'done');
    addRejectionEvent(t1);
    addRejectionEvent(t1);
    const t2 = createTask(iterId, 'Other Task', 'done');
    addRejectionEvent(t2);

    const report = generateIterationStats(iterId);

    expect(report).toContain('打回次数最多的任务');
    expect(report).toContain('Problem Task');
    expect(report).toContain('打回 2 次');
  });

  it('returns a valid report for an empty iteration (no tasks)', () => {
    const iterId = createIteration();

    const report = generateIterationStats(iterId);

    // Should not throw; header should still appear
    expect(report).toContain(`## 迭代 #${iterId}`);
    expect(report).toContain('共 0 个');
    expect(report).toContain('累计打回次数: 0');
  });
});
