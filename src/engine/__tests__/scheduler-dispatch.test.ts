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
    const schedulerDispatch = await import('../scheduler-dispatch.js');

    const task = insert('tasks', {
      title: 'task',
    });

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
      related_task_id: Number(task.lastInsertRowid),
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
  });
});
