import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../schema.js';

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
}

describe('runMigrations', () => {
  it('adds trace columns for existing databases', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE iterations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_dev',
        assigned_to TEXT,
        iteration_id INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_role TEXT NOT NULL,
        to_role TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'directive',
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unread',
        related_task_id INTEGER,
        related_iteration_id INTEGER,
        attachments TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        content TEXT NOT NULL,
        related_task_id INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'pending',
        submitted_by TEXT NOT NULL
      );
      CREATE TABLE memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE role_outputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        session_id TEXT NOT NULL,
        input_summary TEXT NOT NULL,
        output_text TEXT NOT NULL,
        related_iteration_id INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        reason TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    runMigrations(db);

    expect(columns(db, 'logs')).toContain('trace_id');
    expect(columns(db, 'role_outputs')).toContain('trace_id');
    expect(columns(db, 'task_events')).toContain('trace_id');
    expect(columns(db, 'messages')).toContain('retry_count');
    expect(columns(db, 'messages')).toContain('last_retry_at');
  });
});
