import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insert as databaseInsert, update as databaseUpdate } from '../database-tool.template.js';

const TEST_ROLE = '__WIN_AGENT_ROLE__';

let workspaceDir: string;
let db: Database.Database;

beforeAll(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-dbtool-'));
  db = new Database(path.join(workspaceDir, '__WIN_AGENT_DB_REL_PATH__'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE role_permissions (
      role        TEXT NOT NULL,
      table_name  TEXT NOT NULL,
      operation   TEXT NOT NULL,
      conditions  TEXT,
      PRIMARY KEY (role, table_name, operation)
    );

    CREATE TABLE iterations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending_dev',
      iteration_id    INTEGER REFERENCES iterations(id)
    );

    CREATE TABLE messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_role   TEXT NOT NULL,
      to_role     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'directive',
      content     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'unread',
      related_task_id INTEGER REFERENCES tasks(id),
      related_iteration_id INTEGER REFERENCES iterations(id),
      attachments  TEXT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_retry_at INTEGER
    );
  `);
});

afterAll(() => {
  db.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(`
    DELETE FROM messages;
    DELETE FROM tasks;
    DELETE FROM iterations;
    DELETE FROM role_permissions;

    INSERT INTO role_permissions (role, table_name, operation, conditions)
      VALUES ('${TEST_ROLE}', 'messages', 'insert', NULL);
    INSERT INTO role_permissions (role, table_name, operation, conditions)
      VALUES ('${TEST_ROLE}', 'messages', 'update', NULL);

    INSERT INTO iterations (id, status) VALUES (1, 'active');
    INSERT INTO iterations (id, status) VALUES (2, 'active');
    INSERT INTO tasks (id, title, status, iteration_id) VALUES (1, 'Task 1', 'pending_dev', 1);
    INSERT INTO tasks (id, title, status, iteration_id) VALUES (2, 'Task 2', 'pending_dev', 2);
  `);
});

describe('database tool message validation', () => {
  it('rejects invalid to_role values on message insert', async () => {
    const result = await insertMessage({
      from_role: 'PM',
      to_role: 'assistant',
      type: 'directive',
      content: 'work',
      related_task_id: 1,
      status: 'unread',
    });

    expect(result.error).toContain('to_role');
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 0 });
  });

  it('rejects unknown message types on message insert', async () => {
    const result = await insertMessage({
      from_role: 'PM',
      to_role: 'DEV',
      type: 'unknown',
      content: 'work',
      related_task_id: 1,
      status: 'unread',
    });

    expect(result.error).toContain('type');
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 0 });
  });

  it('rejects task-bound message inserts without related_task_id', async () => {
    const result = await insertMessage({
      from_role: 'PM',
      to_role: 'DEV',
      type: 'directive',
      content: 'work',
      status: 'unread',
    });

    expect(result.error).toContain('related_task_id');
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 0 });
  });

  it('rejects protocol attachments that disagree with message fields', async () => {
    const result = await insertMessage({
      from_role: 'PM',
      to_role: 'DEV',
      type: 'directive',
      content: 'work',
      related_task_id: 1,
      related_iteration_id: 1,
      attachments: JSON.stringify({
        protocol: 'win-agent.message.v1',
        type: 'directive',
        task_id: 2,
        iteration_id: 1,
      }),
      status: 'unread',
    });

    expect(result.error).toContain('attachments.task_id');
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 0 });
  });

  it('allows global reflection inserts with related_iteration_id', async () => {
    const result = await insertMessage({
      from_role: 'system',
      to_role: 'DEV',
      type: 'reflection',
      content: 'reflect',
      related_iteration_id: 1,
      attachments: JSON.stringify({
        protocol: 'win-agent.message.v1',
        type: 'reflection',
        iteration_id: 1,
      }),
      status: 'unread',
    });

    expect(result).toMatchObject({ id: expect.any(Number) });
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 1 });
  });

  it('rejects message updates that would create protocol attachment mismatches', async () => {
    const inserted = await insertMessage({
      from_role: 'PM',
      to_role: 'DEV',
      type: 'directive',
      content: 'work',
      related_task_id: 1,
      related_iteration_id: 1,
      attachments: JSON.stringify({
        protocol: 'win-agent.message.v1',
        type: 'directive',
        task_id: 1,
        iteration_id: 1,
      }),
      status: 'unread',
    });

    const result = await updateMessage(
      { id: inserted.id },
      {
        attachments: JSON.stringify({
          protocol: 'win-agent.message.v1',
          type: 'directive',
          task_id: 2,
          iteration_id: 1,
        }),
      }
    );

    expect(result.error).toContain('attachments.task_id');
    expect(
      db.prepare('SELECT attachments FROM messages WHERE id = ?').get(inserted.id)
    ).toMatchObject({
      attachments: expect.stringContaining('"task_id":1'),
    });
  });
});

async function insertMessage(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(
    await databaseInsert.execute(
      {
        table: 'messages',
        data: JSON.stringify(data),
      },
      toolContext()
    )
  ) as Record<string, unknown>;
}

async function updateMessage(
  where: Record<string, unknown>,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await databaseUpdate.execute(
      {
        table: 'messages',
        where: JSON.stringify(where),
        data: JSON.stringify(data),
      },
      toolContext()
    )
  ) as Record<string, unknown>;
}

function toolContext() {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: TEST_ROLE,
    directory: workspaceDir,
    worktree: workspaceDir,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  } as never;
}
