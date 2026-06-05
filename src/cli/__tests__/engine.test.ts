import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { insert, select } from '../../db/repository.js';
import { MessageStatus } from '../../db/types.js';
import { Role } from '../../engine/role-manager.js';
import { notifyActiveIterationsOnRestore } from '../engine.js';

beforeEach(() => {
  setupTestDb();
});

function createIteration(status = 'active'): number {
  return Number(insert('iterations', { name: 'Test Iter', status }).lastInsertRowid);
}

describe('notifyActiveIterationsOnRestore', () => {
  it('sends only one PM restore notification while the active iteration set is unchanged', () => {
    const iterId = createIteration();

    const first = notifyActiveIterationsOnRestore();
    const second = notifyActiveIterationsOnRestore();

    expect(first).toEqual({ activeCount: 1, notified: true });
    expect(second).toEqual({ activeCount: 1, notified: false });

    const msgs = select<{ status: string; content: string }>('messages', { to_role: Role.PM });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].status).toBe(MessageStatus.Unread);
    expect(msgs[0].content).toContain('1 个活跃迭代');

    const cfg = select<{ value: string }>('project_config', {
      key: 'engine.activeIterationRestoreNotifiedSet',
    });
    expect(cfg[0].value).toBe(JSON.stringify([iterId]));
  });

  it('sends a new PM restore notification when the active iteration set changes', () => {
    createIteration();
    notifyActiveIterationsOnRestore();

    createIteration();
    const changed = notifyActiveIterationsOnRestore();

    expect(changed).toEqual({ activeCount: 2, notified: true });

    const msgs = select<{ content: string }>('messages', { to_role: Role.PM });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toContain('2 个活跃迭代');
  });
});
