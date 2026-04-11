import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { select, insert } from '../../db/repository.js';
import { checkAutoTriggers, resetTriggers } from '../auto-trigger.js';

beforeEach(() => {
  setupTestDb();
  resetTriggers();
});

function createIteration(status = 'active'): number {
  const { lastInsertRowid } = insert('iterations', { name: 'Test Iter', status });
  return lastInsertRowid as number;
}

function createTask(iterationId: number, status: string, title = 'Task'): number {
  const { lastInsertRowid } = insert('tasks', { title, status, iteration_id: iterationId });
  return lastInsertRowid as number;
}

describe('checkAllTasksDone (via checkAutoTriggers)', () => {
  it('marks iteration completed when all tasks are done', () => {
    const iterId = createIteration('active');
    createTask(iterId, 'done', 'Task 1');
    createTask(iterId, 'done', 'Task 2');

    checkAutoTriggers();

    const iter = select<{ status: string }>('iterations', { id: iterId })[0];
    expect(iter.status).toBe('completed');
  });

  it('sends deferred PM notification when all tasks done', () => {
    const iterId = createIteration('active');
    createTask(iterId, 'done', 'Task 1');

    checkAutoTriggers();

    const msgs = select<{ status: string; content: string }>('messages', { to_role: 'PM' });
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].status).toBe('deferred');
    expect(msgs[0].content).toContain(`#${iterId}`);
  });

  it('does not trigger if some tasks are not done', () => {
    const iterId = createIteration('active');
    createTask(iterId, 'done', 'Task 1');
    createTask(iterId, 'pending_dev', 'Task 2');

    checkAutoTriggers();

    const iter = select<{ status: string }>('iterations', { id: iterId })[0];
    expect(iter.status).toBe('active');
  });

  it('ignores cancelled tasks when checking all-done', () => {
    const iterId = createIteration('active');
    createTask(iterId, 'done', 'Task 1');
    createTask(iterId, 'cancelled', 'Task 2');

    checkAutoTriggers();

    const iter = select<{ status: string }>('iterations', { id: iterId })[0];
    expect(iter.status).toBe('completed');
  });

  it('does not fire twice (idempotent)', () => {
    const iterId = createIteration('active');
    createTask(iterId, 'done', 'Task 1');

    checkAutoTriggers();
    checkAutoTriggers(); // second call should be a no-op

    const msgs = select('messages', { to_role: 'PM' });
    expect(msgs.length).toBe(1); // only one notification
  });

  it('does not trigger when iteration has no tasks', () => {
    const iterId = createIteration('active');

    checkAutoTriggers();

    const iter = select<{ status: string }>('iterations', { id: iterId })[0];
    expect(iter.status).toBe('active');
  });
});

describe('checkRejectionRate (via checkAutoTriggers)', () => {
  it('triggers when rejection rate exceeds 30% with ≥3 tasks', () => {
    const iterId = createIteration('active');
    createTask(iterId, 'rejected', 'T1');
    createTask(iterId, 'rejected', 'T2');
    createTask(iterId, 'pending_dev', 'T3');

    checkAutoTriggers();

    const msgs = select<{ content: string }>('messages', { to_role: 'PM' });
    const rateMsg = msgs.find((m) => m.content.includes('打回率'));
    expect(rateMsg).toBeDefined();
  });

  it('does not trigger when rejection rate is ≤30%', () => {
    const iterId = createIteration('active');
    createTask(iterId, 'rejected', 'T1');
    createTask(iterId, 'done', 'T2');
    createTask(iterId, 'done', 'T3');
    createTask(iterId, 'done', 'T4');

    checkAutoTriggers();

    // No rate warning message (may have all-done message if all done)
    const msgs = select<{ content: string }>('messages', { to_role: 'PM' });
    const rateMsg = msgs.find((m) => m.content.includes('打回率'));
    expect(rateMsg).toBeUndefined();
  });

  it('does not trigger with fewer than 3 tasks regardless of rate', () => {
    const iterId = createIteration('active');
    createTask(iterId, 'rejected', 'T1');
    createTask(iterId, 'rejected', 'T2');

    checkAutoTriggers();

    const msgs = select<{ content: string }>('messages', { to_role: 'PM' });
    const rateMsg = msgs.find((m) => m.content.includes('打回率'));
    expect(rateMsg).toBeUndefined();
  });

  it('does not fire twice (idempotent)', () => {
    const iterId = createIteration('active');
    createTask(iterId, 'rejected', 'T1');
    createTask(iterId, 'rejected', 'T2');
    createTask(iterId, 'pending_dev', 'T3');

    checkAutoTriggers();
    checkAutoTriggers();

    const msgs = select<{ content: string }>('messages', { to_role: 'PM' });
    const rateMsgs = msgs.filter((m) => m.content.includes('打回率'));
    expect(rateMsgs.length).toBe(1);
  });
});

describe('checkScaffoldDone (via checkAutoTriggers)', () => {
  it('triggers when scaffold task is done in greenfield mode', () => {
    insert('project_config', { key: 'project_mode', value: 'greenfield' });
    insert('tasks', { title: 'Setup [scaffold]', status: 'done' });

    checkAutoTriggers();

    const msgs = select<{ content: string }>('messages', { to_role: 'PM' });
    const scaffoldMsg = msgs.find((m) => m.content.includes('脚手架'));
    expect(scaffoldMsg).toBeDefined();
  });

  it('does not trigger in non-greenfield mode', () => {
    insert('project_config', { key: 'project_mode', value: 'brownfield' });
    insert('tasks', { title: 'Setup [scaffold]', status: 'done' });

    checkAutoTriggers();

    const msgs = select<{ content: string }>('messages', { to_role: 'PM' });
    const scaffoldMsg = msgs.find((m) => m.content.includes('脚手架'));
    expect(scaffoldMsg).toBeUndefined();
  });

  it('does not fire twice (idempotent)', () => {
    insert('project_config', { key: 'project_mode', value: 'greenfield' });
    insert('tasks', { title: 'Setup [scaffold]', status: 'done' });

    checkAutoTriggers();
    checkAutoTriggers();

    const msgs = select<{ content: string }>('messages', { to_role: 'PM' });
    const scaffoldMsgs = msgs.filter((m) => m.content.includes('脚手架'));
    expect(scaffoldMsgs.length).toBe(1);
  });
});
