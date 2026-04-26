import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageStatus } from '../../db/types.js';
import { Role } from '../role-manager.js';
import { findRolesReadyForDispatch } from '../message-scheduler.js';
import type { RoleRuntimeState } from '../session-reconciler.js';

beforeEach(async () => {
  vi.useRealTimers();
  const { setupTestDb } = await import('../../db/__tests__/test-helpers.js');
  setupTestDb();
});

function state(role: Role, serverBusy: boolean): RoleRuntimeState {
  return {
    role,
    sessionId: `${role}-session`,
    serverStatus: serverBusy ? { type: 'busy' } : { type: 'idle' },
    serverBusy,
    localBusy: serverBusy,
    drift: 'none',
  };
}

describe('findRolesReadyForDispatch', () => {
  it('returns roles with unread messages when they are idle', async () => {
    const { insert } = await import('../../db/repository.js');
    insert('messages', {
      from_role: Role.USER,
      to_role: Role.PM,
      type: 'system',
      content: 'pm work',
      status: MessageStatus.Unread,
    });

    const roles = findRolesReadyForDispatch(
      new Map([
        [Role.PM, state(Role.PM, false)],
        [Role.DEV, state(Role.DEV, false)],
      ])
    );

    expect(roles).toEqual([Role.PM]);
  });

  it('skips busy roles and messages still in dispatch backoff', async () => {
    const { insert } = await import('../../db/repository.js');
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
      last_retry_at: Date.now(),
    });

    const roles = findRolesReadyForDispatch(
      new Map([
        [Role.PM, state(Role.PM, true)],
        [Role.DEV, state(Role.DEV, false)],
      ])
    );

    expect(roles).toEqual([]);
  });
});
