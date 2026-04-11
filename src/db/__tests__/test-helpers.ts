import type Database from 'better-sqlite3';
import { openDb } from '../connection.js';

/**
 * Set up an in-memory SQLite test database with the non-vector tables.
 * Calls openDb(':memory:') which sets the getDb() singleton used by repository.ts.
 * Does NOT create vector tables (knowledge_vec, memory_vec) — not needed for unit tests.
 */
export function setupTestDb(): Database.Database {
  const db = openDb(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS iterations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      reviewed_at  DATETIME
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      description     TEXT,
      acceptance_criteria TEXT,
      acceptance_process  TEXT,
      priority        TEXT NOT NULL DEFAULT 'medium',
      status          TEXT NOT NULL DEFAULT 'pending_dev',
      assigned_to     TEXT,
      pre_suspend_status  TEXT,
      iteration_id    INTEGER REFERENCES iterations(id),
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id      INTEGER NOT NULL REFERENCES tasks(id),
      depends_on   INTEGER NOT NULL REFERENCES tasks(id),
      PRIMARY KEY (task_id, depends_on)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_role   TEXT NOT NULL,
      to_role     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'directive',
      content     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'unread',
      related_task_id INTEGER REFERENCES tasks(id),
      related_iteration_id INTEGER REFERENCES iterations(id),
      attachments  TEXT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      role            TEXT NOT NULL,
      action          TEXT NOT NULL,
      content         TEXT NOT NULL,
      related_task_id INTEGER REFERENCES tasks(id),
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_config (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id),
      from_status TEXT,
      to_status   TEXT NOT NULL,
      changed_by  TEXT NOT NULL,
      reason      TEXT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS role_outputs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      role                TEXT NOT NULL,
      session_id          TEXT NOT NULL,
      input_summary       TEXT NOT NULL,
      output_text         TEXT NOT NULL,
      input_tokens        INTEGER DEFAULT 0,
      output_tokens       INTEGER DEFAULT 0,
      related_task_id     INTEGER REFERENCES tasks(id),
      related_iteration_id INTEGER REFERENCES iterations(id),
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      content     TEXT NOT NULL,
      trigger     TEXT NOT NULL DEFAULT 'context_limit',
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}
