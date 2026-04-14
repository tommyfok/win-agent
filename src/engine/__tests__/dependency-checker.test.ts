import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { select, insert, update } from '../../db/repository.js';
import {
  checkAndBlockUnmetDependencies,
  checkAndUnblockDependencies,
} from '../dependency-checker.js';
import { Role } from '../role-manager.js';
import { MessageStatus, TaskStatus } from '../../db/types.js';

beforeEach(() => {
  setupTestDb();
});

function createTask(title: string, status: TaskStatus = TaskStatus.PendingDev, assignedTo?: string): number {
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
    const depId = createTask('Dep', TaskStatus.PendingDev);
    const taskId = createTask('Task', TaskStatus.PendingDev);
    addDep(taskId, depId);

    const blocked = checkAndBlockUnmetDependencies(taskId, TaskStatus.PendingDev);
    expect(blocked).toBe(true);

    const task = select<{ status: string; pre_suspend_status: string }>('tasks', { id: taskId })[0];
    expect(task.status).toBe(TaskStatus.Blocked);
    expect(task.pre_suspend_status).toBe(TaskStatus.PendingDev);
  });

  it('records a task_event when blocking', () => {
    const depId = createTask('Dep', TaskStatus.PendingDev);
    const taskId = createTask('Task', TaskStatus.PendingDev);
    addDep(taskId, depId);

    checkAndBlockUnmetDependencies(taskId, TaskStatus.PendingDev);

    const events = select<{ to_status: string }>('task_events', { task_id: taskId });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].to_status).toBe(TaskStatus.Blocked);
  });

  it('returns false when all dependencies are done', () => {
    const depId = createTask('Dep Done', TaskStatus.Done);
    const taskId = createTask('Task', TaskStatus.PendingDev);
    addDep(taskId, depId);

    const blocked = checkAndBlockUnmetDependencies(taskId, TaskStatus.PendingDev);
    expect(blocked).toBe(false);
    const task = select<{ status: string }>('tasks', { id: taskId })[0];
    expect(task.status).toBe(TaskStatus.PendingDev);
  });

  it('returns false (already blocked) without modifying pre_suspend_status', () => {
    const depId = createTask('Dep', TaskStatus.PendingDev);
    const taskId = createTask('Task', TaskStatus.Blocked);
    addDep(taskId, depId);

    // Task is already blocked — checkAndBlockUnmetDependencies returns true immediately
    const blocked = checkAndBlockUnmetDependencies(taskId, TaskStatus.Blocked);
    expect(blocked).toBe(true);
    // pre_suspend_status should not have been set (task was created as 'blocked' directly)
    const task = select<{ pre_suspend_status: string | null }>('tasks', { id: taskId })[0];
    expect(task.pre_suspend_status).toBeNull();
  });

  it('returns false when task has no dependencies', () => {
    const taskId = createTask('Task No Deps', TaskStatus.PendingDev);
    const blocked = checkAndBlockUnmetDependencies(taskId, TaskStatus.PendingDev);
    expect(blocked).toBe(false);
  });
});

describe('checkAndUnblockDependencies', () => {
  it('restores pre_suspend_status when all dependencies become done', () => {
    const depId = createTask('Dep', TaskStatus.PendingDev);
    const taskId = createTask('Task', TaskStatus.PendingDev);
    addDep(taskId, depId);

    // Block the task
    checkAndBlockUnmetDependencies(taskId, TaskStatus.PendingDev);
    expect(select<{ status: string }>('tasks', { id: taskId })[0].status).toBe(TaskStatus.Blocked);

    // Mark dep as done and unblock
    update('tasks', { id: depId }, { status: TaskStatus.Done });
    checkAndUnblockDependencies();

    const task = select<{ status: string; pre_suspend_status: string | null }>('tasks', {
      id: taskId,
    })[0];
    expect(task.status).toBe(TaskStatus.PendingDev);
    expect(task.pre_suspend_status).toBeNull();
  });

  it('falls back to pending_dev when pre_suspend_status is null', () => {
    const depId = createTask('Dep', TaskStatus.Done);
    const taskId = createTask('Task', TaskStatus.Blocked);
    addDep(taskId, depId);
    // pre_suspend_status is null by default

    checkAndUnblockDependencies();

    const task = select<{ status: string }>('tasks', { id: taskId })[0];
    expect(task.status).toBe(TaskStatus.PendingDev);
  });

  it('sends PM notification on unblock', () => {
    const depId = createTask('Dep', TaskStatus.PendingDev);
    const taskId = createTask('Task', TaskStatus.PendingDev);
    addDep(taskId, depId);
    checkAndBlockUnmetDependencies(taskId, TaskStatus.PendingDev);

    update('tasks', { id: depId }, { status: TaskStatus.Done });
    checkAndUnblockDependencies();

    const msgs = select<{ to_role: string; content: string }>('messages', { to_role: Role.PM });
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[0].content).toContain(`#${taskId}`);
  });

  it('sends notification to assigned role on unblock', () => {
    const depId = createTask('Dep', TaskStatus.PendingDev);
    const taskId = createTask('Task', TaskStatus.PendingDev, Role.DEV);
    addDep(taskId, depId);
    checkAndBlockUnmetDependencies(taskId, TaskStatus.PendingDev);

    update('tasks', { id: depId }, { status: TaskStatus.Done });
    checkAndUnblockDependencies();

    const devMsgs = select('messages', { to_role: Role.DEV, status: MessageStatus.Unread });
    expect(devMsgs.length).toBe(1);
  });

  it('does not duplicate DEV notification if one already exists', () => {
    const depId = createTask('Dep', TaskStatus.PendingDev);
    const taskId = createTask('Task', TaskStatus.PendingDev, Role.DEV);
    addDep(taskId, depId);
    checkAndBlockUnmetDependencies(taskId, TaskStatus.PendingDev);

    // Pre-insert an unread system notification for DEV
    insert('messages', {
      from_role: Role.SYS,
      to_role: Role.DEV,
      type: 'notification',
      content: 'existing notification',
      related_task_id: taskId,
      status: MessageStatus.Unread,
    });

    update('tasks', { id: depId }, { status: TaskStatus.Done });
    checkAndUnblockDependencies();

    const devMsgs = select('messages', { to_role: Role.DEV, status: MessageStatus.Unread });
    // Still only 1 — dedup prevents adding a second
    expect(devMsgs.length).toBe(1);
  });

  it('keeps task blocked when dependencies are still unmet', () => {
    const dep1 = createTask('Dep 1', TaskStatus.Done);
    const dep2 = createTask('Dep 2', TaskStatus.PendingDev);
    const taskId = createTask('Task', TaskStatus.PendingDev);
    addDep(taskId, dep1);
    addDep(taskId, dep2);
    checkAndBlockUnmetDependencies(taskId, TaskStatus.PendingDev);

    checkAndUnblockDependencies();

    const task = select<{ status: string }>('tasks', { id: taskId })[0];
    expect(task.status).toBe(TaskStatus.Blocked);
  });
});

describe('transitive dependency checking (3-level: A→B→C)', () => {
  // Chain: A depends on B, B depends on C. A and B start as pending_dev, C as in_dev (not done).

  it('blocks A when direct dep B is done but transitive dep C is not done', () => {
    const cId = createTask('C', TaskStatus.InDev);
    const bId = createTask('B', TaskStatus.Done); // B is "done" but its dep C is still in_dev
    const aId = createTask('A', TaskStatus.PendingDev);
    addDep(bId, cId);
    addDep(aId, bId);

    const blocked = checkAndBlockUnmetDependencies(aId, TaskStatus.PendingDev);

    expect(blocked).toBe(true);
    const a = select<{ status: string }>('tasks', { id: aId })[0];
    expect(a.status).toBe(TaskStatus.Blocked);
  });

  it('does NOT unblock A when transitive dep C is still undone (even though direct dep B is done)', () => {
    const cId = createTask('C', TaskStatus.InDev);
    const bId = createTask('B', TaskStatus.Done);
    const aId = createTask('A', TaskStatus.PendingDev);
    addDep(bId, cId);
    addDep(aId, bId);

    checkAndBlockUnmetDependencies(aId, TaskStatus.PendingDev);

    checkAndUnblockDependencies();

    const a = select<{ status: string }>('tasks', { id: aId })[0];
    expect(a.status).toBe(TaskStatus.Blocked);
  });

  it('unblocks B when C completes, then unblocks A when B completes', () => {
    const cId = createTask('C', TaskStatus.InDev);
    const bId = createTask('B', TaskStatus.PendingDev);
    const aId = createTask('A', TaskStatus.PendingDev);
    addDep(bId, cId);
    addDep(aId, bId);

    // Block B (C not done) and A (B not done)
    checkAndBlockUnmetDependencies(bId, TaskStatus.PendingDev);
    checkAndBlockUnmetDependencies(aId, TaskStatus.PendingDev);
    expect(select<{ status: string }>('tasks', { id: bId })[0].status).toBe(TaskStatus.Blocked);
    expect(select<{ status: string }>('tasks', { id: aId })[0].status).toBe(TaskStatus.Blocked);

    // C completes — B should unblock, A still blocked (B not done yet)
    update('tasks', { id: cId }, { status: TaskStatus.Done });
    checkAndUnblockDependencies();
    expect(select<{ status: string }>('tasks', { id: bId })[0].status).toBe(TaskStatus.PendingDev);
    expect(select<{ status: string }>('tasks', { id: aId })[0].status).toBe(TaskStatus.Blocked);

    // B completes — A should now unblock
    update('tasks', { id: bId }, { status: TaskStatus.Done });
    checkAndUnblockDependencies();
    expect(select<{ status: string }>('tasks', { id: aId })[0].status).toBe(TaskStatus.PendingDev);
  });
});
