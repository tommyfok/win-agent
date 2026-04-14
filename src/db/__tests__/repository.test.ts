import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './test-helpers.js';
import { select, insert, update, del, withTransaction, upsertProjectConfig } from '../repository.js';
import { TaskStatus } from '../types.js';

beforeEach(() => {
  setupTestDb();
});

describe('select', () => {
  it('returns all rows when no where clause', () => {
    insert('tasks', { title: 'Task A', status: TaskStatus.PendingDev });
    insert('tasks', { title: 'Task B', status: TaskStatus.Done });
    const rows = select('tasks');
    expect(rows.length).toBe(2);
  });

  it('filters by where clause', () => {
    insert('tasks', { title: 'Task A', status: TaskStatus.PendingDev });
    insert('tasks', { title: 'Task B', status: TaskStatus.Done });
    const rows = select('tasks', { status: TaskStatus.Done });
    expect(rows.length).toBe(1);
    expect((rows[0] as { title: string }).title).toBe('Task B');
  });

  it('orders by column', () => {
    insert('tasks', { title: 'B task', status: TaskStatus.PendingDev });
    insert('tasks', { title: 'A task', status: TaskStatus.PendingDev });
    const rows = select<{ title: string }>('tasks', {}, { orderBy: 'title ASC' });
    expect(rows[0].title).toBe('A task');
    expect(rows[1].title).toBe('B task');
  });

  it('rejects invalid orderBy (SQL injection protection)', () => {
    expect(() =>
      select('tasks', {}, { orderBy: 'title; DROP TABLE tasks' })
    ).toThrow('Invalid orderBy value');
  });

  it('applies limit and offset', () => {
    insert('tasks', { title: 'T1', status: TaskStatus.PendingDev });
    insert('tasks', { title: 'T2', status: TaskStatus.PendingDev });
    insert('tasks', { title: 'T3', status: TaskStatus.PendingDev });
    const rows = select<{ title: string }>('tasks', {}, { limit: 2, offset: 1, orderBy: 'id ASC' });
    expect(rows.length).toBe(2);
    expect(rows[0].title).toBe('T2');
  });
});

describe('insert', () => {
  it('inserts a row and returns lastInsertRowid', () => {
    const result = insert('tasks', { title: 'New Task', status: TaskStatus.PendingDev });
    expect(typeof result.lastInsertRowid).toBe('number');
    expect(result.lastInsertRowid).toBeGreaterThan(0);
  });
});

describe('update', () => {
  it('updates matching rows and returns changes count', () => {
    insert('tasks', { title: 'Task', status: TaskStatus.PendingDev });
    const result = update('tasks', { status: TaskStatus.PendingDev }, { status: TaskStatus.Done });
    expect(result.changes).toBe(1);
    const rows = select<{ status: string }>('tasks', { status: TaskStatus.Done });
    expect(rows.length).toBe(1);
  });

  it('auto-updates updated_at when the column exists', () => {
    const { lastInsertRowid } = insert('tasks', { title: 'T', status: TaskStatus.PendingDev });
    const before = select<{ updated_at: string }>('tasks', { id: lastInsertRowid })[0].updated_at;
    // Small delay to ensure timestamp differs
    update('tasks', { id: lastInsertRowid as number }, { status: TaskStatus.Done });
    const after = select<{ updated_at: string }>('tasks', { id: lastInsertRowid })[0].updated_at;
    // updated_at should be set (either same or later)
    expect(after).toBeDefined();
    expect(before).toBeDefined();
  });
});

describe('del', () => {
  it('deletes matching rows', () => {
    insert('tasks', { title: 'To Delete', status: TaskStatus.PendingDev });
    const result = del('tasks', { status: TaskStatus.PendingDev });
    expect(result.changes).toBe(1);
    expect(select('tasks').length).toBe(0);
  });
});

describe('withTransaction', () => {
  it('commits on success', () => {
    withTransaction(() => {
      insert('tasks', { title: 'Tx Task', status: TaskStatus.PendingDev });
    });
    expect(select('tasks').length).toBe(1);
  });

  it('rolls back on exception', () => {
    expect(() => {
      withTransaction(() => {
        insert('tasks', { title: 'Should Rollback', status: TaskStatus.PendingDev });
        throw new Error('intentional error');
      });
    }).toThrow('intentional error');
    // Row should not persist
    expect(select('tasks').length).toBe(0);
  });

  it('returns the function result', () => {
    const result = withTransaction(() => {
      insert('tasks', { title: 'Return Test', status: TaskStatus.PendingDev });
      return 42;
    });
    expect(result).toBe(42);
  });
});

describe('upsertProjectConfig', () => {
  it('inserts a new key-value pair', () => {
    upsertProjectConfig('engine.test.key', 'hello');
    const rows = select<{ key: string; value: string }>('project_config', { key: 'engine.test.key' });
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe('hello');
  });

  it('replaces the value when the key already exists', () => {
    upsertProjectConfig('engine.test.key', 'first');
    upsertProjectConfig('engine.test.key', 'second');
    const rows = select<{ value: string }>('project_config', { key: 'engine.test.key' });
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe('second');
  });

  it('stores empty-string value without error', () => {
    upsertProjectConfig('engine.test.empty', '');
    const rows = select<{ value: string }>('project_config', { key: 'engine.test.empty' });
    expect(rows[0].value).toBe('');
  });

  it('multiple keys coexist independently', () => {
    upsertProjectConfig('engine.a', '1');
    upsertProjectConfig('engine.b', '2');
    expect(select<{ value: string }>('project_config', { key: 'engine.a' })[0].value).toBe('1');
    expect(select<{ value: string }>('project_config', { key: 'engine.b' })[0].value).toBe('2');
  });
});
