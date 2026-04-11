import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { select, insert, update } from '../../db/repository.js';
import {
  checkAndBlockUnmetDependencies,
  checkAndUnblockDependencies,
} from '../dependency-checker.js';

beforeEach(() => {
  setupTestDb();
});

function createTask(title: string, status = 'pending_dev', assignedTo?: string): number {
  const { lastInsertRowid } = insert('tasks', {
    title,
    status,
    ...(assignedTo ? { assigned_to: assignedTo } : {}),
  });
  return lastInsertRowid as number;
}

function addDep(taskId: number, dependsOnId: number) {
  insert('task_dependencies', { task_id: taskId, depends_on: dependsOnId });
}

describe('checkAndBlockUnmetDependencies', () => {
  it('blocks task and saves pre_suspend_status when deps are unmet', () => {
    const depId = createTask('Dep', 'pending_dev');
    const taskId = createTask('Task', 'pending_dev');
    addDep(taskId, depId);

    const blocked = checkAndBlockUnmetDependencies(taskId, 'pending_dev');
    expect(blocked).toBe(true);

    const task = select<{ status: string; pre_suspend_status: string }>('tasks', { id: taskId })[0];
    expect(task.status).toBe('blocked');
    expect(task.pre_suspend_status).toBe('pending_dev');
  });

  it('records a task_event when blocking', () => {
    const depId = createTask('Dep', 'pending_dev');
    const taskId = createTask('Task', 'pending_dev');
    addDep(taskId, depId);

    checkAndBlockUnmetDependencies(taskId, 'pending_dev');

    const events = select<{ to_status: string }>('task_events', { task_id: taskId });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].to_status).toBe('blocked');
  });

  it('returns false when all dependencies are done', () => {
    const depId = createTask('Dep Done', 'done');
    const taskId = createTask('Task', 'pending_dev');
    addDep(taskId, depId);

    const blocked = checkAndBlockUnmetDependencies(taskId, 'pending_dev');
    expect(blocked).toBe(false);
    const task = select<{ status: string }>('tasks', { id: taskId })[0];
    expect(task.status).toBe('pending_dev');
  });

  it('returns false (already blocked) without modifying pre_suspend_status', () => {
    const depId = createTask('Dep', 'pending_dev');
    const taskId = createTask('Task', 'blocked');
    addDep(taskId, depId);

    // Task is already blocked — checkAndBlockUnmetDependencies returns true immediately
    const blocked = checkAndBlockUnmetDependencies(taskId, 'blocked');
    expect(blocked).toBe(true);
    // pre_suspend_status should not have been set (task was created as 'blocked' directly)
    const task = select<{ pre_suspend_status: string | null }>('tasks', { id: taskId })[0];
    expect(task.pre_suspend_status).toBeNull();
  });

  it('returns false when task has no dependencies', () => {
    const taskId = createTask('Task No Deps', 'pending_dev');
    const blocked = checkAndBlockUnmetDependencies(taskId, 'pending_dev');
    expect(blocked).toBe(false);
  });
});

describe('checkAndUnblockDependencies', () => {
  it('restores pre_suspend_status when all dependencies become done', () => {
    const depId = createTask('Dep', 'pending_dev');
    const taskId = createTask('Task', 'pending_dev');
    addDep(taskId, depId);

    // Block the task
    checkAndBlockUnmetDependencies(taskId, 'pending_dev');
    expect(select<{ status: string }>('tasks', { id: taskId })[0].status).toBe('blocked');

    // Mark dep as done and unblock
    update('tasks', { id: depId }, { status: 'done' });
    checkAndUnblockDependencies();

    const task = select<{ status: string; pre_suspend_status: string | null }>('tasks', {
      id: taskId,
    })[0];
    expect(task.status).toBe('pending_dev');
    expect(task.pre_suspend_status).toBeNull();
  });

  it('falls back to pending_dev when pre_suspend_status is null', () => {
    const depId = createTask('Dep', 'done');
    const taskId = createTask('Task', 'blocked');
    addDep(taskId, depId);
    // pre_suspend_status is null by default

    checkAndUnblockDependencies();

    const task = select<{ status: string }>('tasks', { id: taskId })[0];
    expect(task.status).toBe('pending_dev');
  });

  it('sends PM notification on unblock', () => {
    const depId = createTask('Dep', 'pending_dev');
    const taskId = createTask('Task', 'pending_dev');
    addDep(taskId, depId);
    checkAndBlockUnmetDependencies(taskId, 'pending_dev');

    update('tasks', { id: depId }, { status: 'done' });
    checkAndUnblockDependencies();

    const msgs = select<{ to_role: string; content: string }>('messages', { to_role: 'PM' });
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].content).toContain(`#${taskId}`);
  });

  it('sends notification to assigned role on unblock', () => {
    const depId = createTask('Dep', 'pending_dev');
    const taskId = createTask('Task', 'pending_dev', 'DEV');
    addDep(taskId, depId);
    checkAndBlockUnmetDependencies(taskId, 'pending_dev');

    update('tasks', { id: depId }, { status: 'done' });
    checkAndUnblockDependencies();

    const devMsgs = select('messages', { to_role: 'DEV', status: 'unread' });
    expect(devMsgs.length).toBe(1);
  });

  it('does not duplicate DEV notification if one already exists', () => {
    const depId = createTask('Dep', 'pending_dev');
    const taskId = createTask('Task', 'pending_dev', 'DEV');
    addDep(taskId, depId);
    checkAndBlockUnmetDependencies(taskId, 'pending_dev');

    // Pre-insert an unread system notification for DEV
    insert('messages', {
      from_role: 'system',
      to_role: 'DEV',
      type: 'notification',
      content: 'existing notification',
      related_task_id: taskId,
      status: 'unread',
    });

    update('tasks', { id: depId }, { status: 'done' });
    checkAndUnblockDependencies();

    const devMsgs = select('messages', { to_role: 'DEV', status: 'unread' });
    // Still only 1 — dedup prevents adding a second
    expect(devMsgs.length).toBe(1);
  });

  it('keeps task blocked when dependencies are still unmet', () => {
    const dep1 = createTask('Dep 1', 'done');
    const dep2 = createTask('Dep 2', 'pending_dev');
    const taskId = createTask('Task', 'pending_dev');
    addDep(taskId, dep1);
    addDep(taskId, dep2);
    checkAndBlockUnmetDependencies(taskId, 'pending_dev');

    checkAndUnblockDependencies();

    const task = select<{ status: string }>('tasks', { id: taskId })[0];
    expect(task.status).toBe('blocked');
  });
});

describe('transitive dependency checking (3-level: A→B→C)', () => {
  // Chain: A depends on B, B depends on C. A and B start as pending_dev, C as in_dev (not done).

  it('blocks A when direct dep B is done but transitive dep C is not done', () => {
    const cId = createTask('C', 'in_dev');
    const bId = createTask('B', 'done'); // B is "done" but its dep C is still in_dev
    const aId = createTask('A', 'pending_dev');
    addDep(bId, cId);
    addDep(aId, bId);

    const blocked = checkAndBlockUnmetDependencies(aId, 'pending_dev');

    expect(blocked).toBe(true);
    const a = select<{ status: string }>('tasks', { id: aId })[0];
    expect(a.status).toBe('blocked');
  });

  it('does NOT unblock A when transitive dep C is still undone (even though direct dep B is done)', () => {
    const cId = createTask('C', 'in_dev');
    const bId = createTask('B', 'done');
    const aId = createTask('A', 'pending_dev');
    addDep(bId, cId);
    addDep(aId, bId);

    checkAndBlockUnmetDependencies(aId, 'pending_dev');

    checkAndUnblockDependencies();

    const a = select<{ status: string }>('tasks', { id: aId })[0];
    expect(a.status).toBe('blocked');
  });

  it('unblocks B when C completes, then unblocks A when B completes', () => {
    const cId = createTask('C', 'in_dev');
    const bId = createTask('B', 'pending_dev');
    const aId = createTask('A', 'pending_dev');
    addDep(bId, cId);
    addDep(aId, bId);

    // Block B (C not done) and A (B not done)
    checkAndBlockUnmetDependencies(bId, 'pending_dev');
    checkAndBlockUnmetDependencies(aId, 'pending_dev');
    expect(select<{ status: string }>('tasks', { id: bId })[0].status).toBe('blocked');
    expect(select<{ status: string }>('tasks', { id: aId })[0].status).toBe('blocked');

    // C completes — B should unblock, A still blocked (B not done yet)
    update('tasks', { id: cId }, { status: 'done' });
    checkAndUnblockDependencies();
    expect(select<{ status: string }>('tasks', { id: bId })[0].status).toBe('pending_dev');
    expect(select<{ status: string }>('tasks', { id: aId })[0].status).toBe('blocked');

    // B completes — A should now unblock
    update('tasks', { id: bId }, { status: 'done' });
    checkAndUnblockDependencies();
    expect(select<{ status: string }>('tasks', { id: aId })[0].status).toBe('pending_dev');
  });
});
