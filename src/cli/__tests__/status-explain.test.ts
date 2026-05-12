import { beforeEach, describe, expect, it } from 'vitest';
import { insert, rawQuery, rawRun } from '../../db/repository.js';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { MessageStatus, TaskStatus } from '../../db/types.js';
import { Role } from '../../engine/role-manager.js';
import {
  collectSchedulerExplanationSnapshot,
  formatSchedulerExplanation,
} from '../status-explain.js';

beforeEach(() => {
  setupTestDb();
});

describe('scheduler status explanation', () => {
  it('renders cleanly with no tasks, messages, or active iterations', () => {
    const snapshot = collectSchedulerExplanationSnapshot({
      now: new Date('2026-05-12T10:00:00.000Z'),
    });
    const output = formatSchedulerExplanation(snapshot).join('\n');

    expect(snapshot.roleQueues).toEqual([
      { role: Role.PM, unread: 0, deferred: 0, dispatching: 0 },
      { role: Role.DEV, unread: 0, deferred: 0, dispatching: 0 },
    ]);
    expect(output).toContain('无 dispatching 消息');
    expect(output).toContain('无阻塞任务');
    expect(output).toContain('暂无明显候选');
    expect(output).toContain('无调度/自动触发事件');
  });

  it('explains a blocked task and lists incomplete dependencies', () => {
    const iterId = Number(insert('iterations', { name: 'Iter', status: 'active' }).lastInsertRowid);
    const dependencyId = Number(
      insert('tasks', {
        title: 'Build API',
        status: TaskStatus.InDev,
        iteration_id: iterId,
      }).lastInsertRowid
    );
    const blockedId = Number(
      insert('tasks', {
        title: 'Wire UI',
        status: TaskStatus.Blocked,
        iteration_id: iterId,
      }).lastInsertRowid
    );
    insert('task_dependencies', { task_id: blockedId, depends_on: dependencyId });

    const snapshot = collectSchedulerExplanationSnapshot();
    const output = formatSchedulerExplanation(snapshot).join('\n');

    expect(snapshot.blockedTasks).toHaveLength(1);
    expect(snapshot.blockedTasks[0]).toMatchObject({
      id: blockedId,
      title: 'Wire UI',
      incompleteDependencies: [{ id: dependencyId, title: 'Build API', status: TaskStatus.InDev }],
    });
    expect(output).toContain(`task#${blockedId}「Wire UI」`);
    expect(output).toContain(`#${dependencyId}「Build API」(${TaskStatus.InDev})`);
  });

  it('explains dispatching messages without requiring a trace column', () => {
    const iterId = Number(insert('iterations', { name: 'Iter', status: 'active' }).lastInsertRowid);
    const taskId = Number(
      insert('tasks', {
        title: 'Implement scheduler page',
        status: TaskStatus.InDev,
        iteration_id: iterId,
      }).lastInsertRowid
    );
    const msgId = Number(
      insert('messages', {
        from_role: Role.PM,
        to_role: Role.DEV,
        type: 'directive',
        content: 'Please continue',
        status: MessageStatus.Dispatching,
        related_task_id: taskId,
        related_iteration_id: iterId,
        created_at: '2026-05-12T09:45:00.000Z',
      }).lastInsertRowid
    );

    const snapshot = collectSchedulerExplanationSnapshot({
      now: new Date('2026-05-12T10:00:00.000Z'),
    });
    const output = formatSchedulerExplanation(snapshot).join('\n');

    expect(snapshot.roleQueues.find((q) => q.role === Role.DEV)?.dispatching).toBe(1);
    expect(snapshot.dispatchingMessages).toEqual([
      expect.objectContaining({
        id: msgId,
        toRole: Role.DEV,
        relatedTaskId: taskId,
        taskTitle: 'Implement scheduler page',
        relatedIterationId: iterId,
        traceId: null,
        ageMinutes: 15,
      }),
    ]);
    expect(output).toContain(`msg#${msgId} PM→DEV`);
    expect(output).toContain(`task#${taskId}「Implement scheduler page」`);
  });

  it('counts deferred PM messages and shows PM cooldown from project_config', () => {
    insert('project_config', { key: 'engine.lastDispatchedRole', value: Role.PM });
    insert('project_config', { key: 'engine.pmLastDispatchEnd', value: '10000' });
    insert('messages', {
      from_role: Role.SYS,
      to_role: Role.PM,
      type: 'system',
      content: 'Review iteration',
      status: MessageStatus.Deferred,
    });

    const snapshot = collectSchedulerExplanationSnapshot({
      now: new Date(11_000),
      pmCooldownMs: 3000,
    });
    const output = formatSchedulerExplanation(snapshot).join('\n');

    expect(snapshot.overview.lastDispatchedRole).toBe(Role.PM);
    expect(snapshot.overview.pmCooldownRemainingMs).toBe(2000);
    expect(snapshot.roleQueues.find((q) => q.role === Role.PM)?.deferred).toBe(1);
    expect(output).toContain('last=PM');
    expect(output).toContain('PM cooldown 剩余 2s');
    expect(output).toContain('PM: unread 0 / deferred 1 / dispatching 0');
  });

  it('reads trace columns when they exist for current work and recent events', () => {
    addColumnIfMissing('messages', 'trace_id', 'TEXT');
    addColumnIfMissing('logs', 'trace_id', 'TEXT');

    rawRun(
      `INSERT INTO messages (from_role, to_role, type, content, status, trace_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [Role.PM, Role.DEV, 'directive', 'Trace this', MessageStatus.Dispatching, 'dispatch_msg_1']
    );
    rawRun(
      `INSERT INTO logs (role, action, content, trace_id)
       VALUES (?, ?, ?, ?)`,
      [Role.SYS, 'auto_trigger', 'auto fired', 'trigger_1']
    );

    const snapshot = collectSchedulerExplanationSnapshot();

    expect(snapshot.dispatchingMessages[0].traceId).toBe('dispatch_msg_1');
    expect(snapshot.recentEvents[0]).toMatchObject({
      kind: 'auto_trigger',
      traceId: 'trigger_1',
    });
  });
});

function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = rawQuery<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((row) => row.name === column)) {
    rawRun(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
