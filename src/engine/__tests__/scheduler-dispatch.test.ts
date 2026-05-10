import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageStatus } from '../../db/types.js';
import { Role, RoleManager } from '../role-manager.js';

vi.mock('../dispatcher.js', () => ({
  dispatchToRole: vi.fn().mockResolvedValue({
    sessionId: 'session-1',
    inputTokens: 0,
    outputTokens: 0,
  }),
}));

vi.mock('../memory-rotator.js', () => ({
  checkAndRotate: vi.fn(),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const { setupTestDb } = await import('../../db/__tests__/test-helpers.js');
  setupTestDb();
});

describe('tryDispatchNormalRole', () => {
  it('rotates candidate roles after the last dispatched role', async () => {
    const { insert } = await import('../../db/repository.js');
    const { dispatchToRole } = await import('../dispatcher.js');
    const { checkAndRotate } = await import('../memory-rotator.js');
    const schedulerDispatch = await import('../scheduler-dispatch.js');

    const task = insert('tasks', {
      title: 'task',
    });
    const taskId = Number(task.lastInsertRowid);

    insert('messages', {
      from_role: Role.USER,
      to_role: Role.PM,
      type: 'system',
      content: 'pm work',
      status: MessageStatus.Unread,
    });
    insert('messages', {
      from_role: Role.PM,
      to_role: Role.DEV,
      type: 'directive',
      content: 'dev work',
      status: MessageStatus.Unread,
      related_task_id: taskId,
    });

    schedulerDispatch.setLastDispatchedRole(Role.PM);

    await schedulerDispatch.tryDispatchNormalRole(
      {} as never,
      {} as never,
      new RoleManager(),
      undefined,
      new Map([
        [
          Role.PM,
          {
            role: Role.PM,
            sessionId: 'pm',
            serverStatus: { type: 'idle' },
            serverBusy: false,
            localBusy: false,
            drift: 'none',
          },
        ],
        [
          Role.DEV,
          {
            role: Role.DEV,
            sessionId: 'dev',
            serverStatus: { type: 'idle' },
            serverBusy: false,
            localBusy: false,
            drift: 'none',
          },
        ],
      ]),
      [Role.PM, Role.DEV]
    );

    expect(dispatchToRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      Role.DEV,
      expect.any(Array),
      expect.any(Object)
    );
    expect(checkAndRotate).toHaveBeenCalledWith(
      expect.anything(),
      Role.DEV,
      'session-1',
      0,
      0,
      taskId
    );
  });

  it('claims unread messages before dispatch so a second scheduler cannot resend them', async () => {
    const { insert, select } = await import('../../db/repository.js');
    const { dispatchToRole } = await import('../dispatcher.js');
    const schedulerDispatch = await import('../scheduler-dispatch.js');

    const task = insert('tasks', {
      title: 'task',
    });
    const taskId = Number(task.lastInsertRowid);

    const message = insert('messages', {
      from_role: Role.PM,
      to_role: Role.DEV,
      type: 'directive',
      content: 'dev work',
      status: MessageStatus.Unread,
      related_task_id: taskId,
    });
    const msgId = Number(message.lastInsertRowid);

    let resolveDispatch: (() => void) | undefined;
    vi.mocked(dispatchToRole).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = () =>
            resolve({
              sessionId: 'session-1',
              inputTokens: 0,
              outputTokens: 0,
            });
        })
    );

    const firstDispatch = schedulerDispatch.tryDispatchNormalRole(
      {} as never,
      {} as never,
      new RoleManager(),
      undefined,
      new Map([
        [
          Role.DEV,
          {
            role: Role.DEV,
            sessionId: 'dev',
            serverStatus: { type: 'idle' },
            serverBusy: false,
            localBusy: false,
            drift: 'none',
          },
        ],
      ]),
      [Role.DEV]
    );

    await vi.waitFor(() => expect(dispatchToRole).toHaveBeenCalledTimes(1));
    expect(select<{ status: string }>('messages', { id: msgId })[0].status).toBe(
      MessageStatus.Dispatching
    );

    await schedulerDispatch.tryDispatchNormalRole(
      {} as never,
      {} as never,
      new RoleManager(),
      undefined,
      new Map([
        [
          Role.DEV,
          {
            role: Role.DEV,
            sessionId: 'dev',
            serverStatus: { type: 'idle' },
            serverBusy: false,
            localBusy: false,
            drift: 'none',
          },
        ],
      ]),
      [Role.DEV]
    );

    expect(dispatchToRole).toHaveBeenCalledTimes(1);
    resolveDispatch?.();
    await firstDispatch;
  });

  it('returns claimed messages to unread when dispatch fails below retry limit', async () => {
    const { insert, select } = await import('../../db/repository.js');
    const { dispatchToRole } = await import('../dispatcher.js');
    const schedulerDispatch = await import('../scheduler-dispatch.js');

    const task = insert('tasks', {
      title: 'task',
    });
    const taskId = Number(task.lastInsertRowid);

    const message = insert('messages', {
      from_role: Role.PM,
      to_role: Role.DEV,
      type: 'directive',
      content: 'dev work',
      status: MessageStatus.Unread,
      related_task_id: taskId,
    });
    const msgId = Number(message.lastInsertRowid);

    vi.mocked(dispatchToRole).mockRejectedValue(new Error('temporary failure'));

    await schedulerDispatch.tryDispatchNormalRole(
      {} as never,
      {} as never,
      new RoleManager(),
      undefined,
      new Map([
        [
          Role.DEV,
          {
            role: Role.DEV,
            sessionId: 'dev',
            serverStatus: { type: 'idle' },
            serverBusy: false,
            localBusy: false,
            drift: 'none',
          },
        ],
      ]),
      [Role.DEV]
    );

    const row = select<{ status: string; retry_count: number }>('messages', { id: msgId })[0];
    expect(row.status).toBe(MessageStatus.Unread);
    expect(row.retry_count).toBe(1);
  });
});
