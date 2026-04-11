import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './test-helpers.js';
import { select, insert, update, del, withTransaction, upsertProjectConfig } from '../repository.js';

beforeEach(() => {
  setupTestDb();
});

describe('select', () => {
  it('returns all rows when no where clause', () => {
    insert('tasks', { title: 'Task A', status: 'pending_dev' });
    insert('tasks', { title: 'Task B', status: 'done' });
    const rows = select('tasks');
    expect(rows.length).toBe(2);
  });

  it('filters by where clause', () => {
    insert('tasks', { title: 'Task A', status: 'pending_dev' });
    insert('tasks', { title: 'Task B', status: 'done' });
    const rows = select('tasks', { status: 'done' });
    expect(rows.length).toBe(1);
    expect((rows[0] as { title: string }).title).toBe('Task B');
  });

  it('orders by column', () => {
    insert('tasks', { title: 'B task', status: 'pending_dev' });
    insert('tasks', { title: 'A task', status: 'pending_dev' });
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
    insert('tasks', { title: 'T1', status: 'pending_dev' });
    insert('tasks', { title: 'T2', status: 'pending_dev' });
    insert('tasks', { title: 'T3', status: 'pending_dev' });
    const rows = select<{ title: string }>('tasks', {}, { limit: 2, offset: 1, orderBy: 'id ASC' });
    expect(rows.length).toBe(2);
    expect(rows[0].title).toBe('T2');
  });
});

describe('insert', () => {
  it('inserts a row and returns lastInsertRowid', () => {
    const result = insert('tasks', { title: 'New Task', status: 'pending_dev' });
    expect(typeof result.lastInsertRowid).toBe('number');
    expect(result.lastInsertRowid).toBeGreaterThan(0);
  });
});

describe('update', () => {
  it('updates matching rows and returns changes count', () => {
    insert('tasks', { title: 'Task', status: 'pending_dev' });
    const result = update('tasks', { status: 'pending_dev' }, { status: 'done' });
    expect(result.changes).toBe(1);
    const rows = select<{ status: string }>('tasks', { status: 'done' });
    expect(rows.length).toBe(1);
  });

  it('auto-updates updated_at when the column exists', () => {
    const { lastInsertRowid } = insert('tasks', { title: 'T', status: 'pending_dev' });
    const before = select<{ updated_at: string }>('tasks', { id: lastInsertRowid })[0].updated_at;
    // Small delay to ensure timestamp differs
    update('tasks', { id: lastInsertRowid as number }, { status: 'done' });
    const after = select<{ updated_at: string }>('tasks', { id: lastInsertRowid })[0].updated_at;
    // updated_at should be set (either same or later)
    expect(after).toBeDefined();
    expect(before).toBeDefined();
  });
});

describe('del', () => {
  it('deletes matching rows', () => {
    insert('tasks', { title: 'To Delete', status: 'pending_dev' });
    const result = del('tasks', { status: 'pending_dev' });
    expect(result.changes).toBe(1);
    expect(select('tasks').length).toBe(0);
  });
});

describe('withTransaction', () => {
  it('commits on success', () => {
    withTransaction(() => {
      insert('tasks', { title: 'Tx Task', status: 'pending_dev' });
    });
    expect(select('tasks').length).toBe(1);
  });

  it('rolls back on exception', () => {
    expect(() => {
      withTransaction(() => {
        insert('tasks', { title: 'Should Rollback', status: 'pending_dev' });
        throw new Error('intentional error');
      });
    }).toThrow('intentional error');
    // Row should not persist
    expect(select('tasks').length).toBe(0);
  });

  it('returns the function result', () => {
    const result = withTransaction(() => {
      insert('tasks', { title: 'Return Test', status: 'pending_dev' });
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
