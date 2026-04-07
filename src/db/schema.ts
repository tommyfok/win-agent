import type Database from "better-sqlite3";

const TABLE_SCHEMAS: Record<string, string> = {
  messages: `
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_role   TEXT NOT NULL,
      to_role     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'directive',
      content     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'unread',
      related_task_id INTEGER REFERENCES tasks(id),
      related_workflow_id INTEGER REFERENCES workflow_instances(id),
      attachments  TEXT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  tasks: `
    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      description     TEXT,
      acceptance_criteria TEXT,
      acceptance_process  TEXT,
      priority        TEXT NOT NULL DEFAULT 'medium',
      status          TEXT NOT NULL DEFAULT 'pending_dev',
      assigned_to     TEXT,
      implementation_notes TEXT,
      rejection_reason    TEXT,
      pre_suspend_status  TEXT,
      workflow_id     INTEGER REFERENCES workflow_instances(id),
      iteration       INTEGER NOT NULL DEFAULT 0,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  task_dependencies: `
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id      INTEGER NOT NULL REFERENCES tasks(id),
      depends_on   INTEGER NOT NULL REFERENCES tasks(id),
      PRIMARY KEY (task_id, depends_on)
    )`,

  knowledge: `
    CREATE TABLE IF NOT EXISTS knowledge (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      category    TEXT NOT NULL,
      tags        TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      created_by  TEXT NOT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  logs: `
    CREATE TABLE IF NOT EXISTS logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      role            TEXT NOT NULL,
      action          TEXT NOT NULL,
      content         TEXT NOT NULL,
      related_task_id INTEGER REFERENCES tasks(id),
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  memory: `
    CREATE TABLE IF NOT EXISTS memory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      content     TEXT NOT NULL,
      trigger     TEXT NOT NULL DEFAULT 'context_limit',
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  workflow_instances: `
    CREATE TABLE IF NOT EXISTS workflow_instances (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      template        TEXT NOT NULL,
      phase           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',
      context         TEXT,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  iterations: `
    CREATE TABLE IF NOT EXISTS iterations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )`,

  role_permissions: `
    CREATE TABLE IF NOT EXISTS role_permissions (
      role        TEXT NOT NULL,
      table_name  TEXT NOT NULL,
      operation   TEXT NOT NULL,
      conditions  TEXT,
      PRIMARY KEY (role, table_name, operation)
    )`,

  proposals: `
    CREATE TABLE IF NOT EXISTS proposals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'suggestion',
      submitted_by TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      resolution  TEXT,
      related_task_id     INTEGER REFERENCES tasks(id),
      related_workflow_id INTEGER REFERENCES workflow_instances(id),
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  project_config: `
    CREATE TABLE IF NOT EXISTS project_config (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  role_outputs: `
    CREATE TABLE IF NOT EXISTS role_outputs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      role                TEXT NOT NULL,
      session_id          TEXT NOT NULL,
      input_summary       TEXT NOT NULL,
      output_text         TEXT NOT NULL,
      input_tokens        INTEGER DEFAULT 0,
      output_tokens       INTEGER DEFAULT 0,
      related_task_id     INTEGER REFERENCES tasks(id),
      related_workflow_id INTEGER REFERENCES workflow_instances(id),
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,

  task_events: `
    CREATE TABLE IF NOT EXISTS task_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id),
      from_status TEXT,
      to_status   TEXT NOT NULL,
      changed_by  TEXT NOT NULL,
      reason      TEXT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
};

/** Default embedding dimension (512 for local bge-small-zh-v1.5, 1536 for OpenAI) */
let embeddingDimension = 512;

/**
 * Set the embedding dimension before creating tables.
 * Must be called before createAllTables() if using non-default dimension.
 */
export function setEmbeddingDimension(dim: number): void {
  embeddingDimension = dim;
}

function getVectorTableSQL(): string[] {
  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(
      id INTEGER PRIMARY KEY,
      embedding float[${embeddingDimension}]
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
      id INTEGER PRIMARY KEY,
      embedding float[${embeddingDimension}]
    )`,
  ];
}

/** Indexes for scheduler polling and common queries */
const INDEX_STATEMENTS: string[] = [
  "CREATE INDEX IF NOT EXISTS idx_messages_dispatch ON messages(to_role, status)",
  "CREATE INDEX IF NOT EXISTS idx_messages_workflow ON messages(related_workflow_id)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, assigned_to)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_iteration ON tasks(iteration)",
  "CREATE INDEX IF NOT EXISTS idx_memory_role ON memory(role, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_logs_role ON logs(role, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, submitted_by)",
  "CREATE INDEX IF NOT EXISTS idx_role_outputs_role ON role_outputs(role, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_role_outputs_workflow ON role_outputs(related_workflow_id)",
  "CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at)",
];

// Table creation order matters due to foreign key references
const CREATE_ORDER = [
  "workflow_instances",
  "tasks",
  "task_dependencies",
  "messages",
  "knowledge",
  "logs",
  "memory",
  "iterations",
  "proposals",
  "role_permissions",
  "project_config",
  "role_outputs",
  "task_events",
];

export function createAllTables(db: Database.Database): void {
  for (const table of CREATE_ORDER) {
    db.exec(TABLE_SCHEMAS[table]);
  }
  for (const stmt of getVectorTableSQL()) {
    db.exec(stmt);
  }
  for (const stmt of INDEX_STATEMENTS) {
    db.exec(stmt);
  }
}

export function getMissingTables(db: Database.Database): string[] {
  const existing = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => (row as { name: string }).name)
  );

  const missing: string[] = [];
  for (const table of CREATE_ORDER) {
    if (!existing.has(table)) {
      missing.push(table);
    }
  }
  // Check virtual tables
  if (!existing.has("knowledge_vec")) missing.push("knowledge_vec");
  if (!existing.has("memory_vec")) missing.push("memory_vec");
  return missing;
}

export function patchMissingTables(db: Database.Database): string[] {
  const missing = getMissingTables(db);
  for (const table of missing) {
    if (TABLE_SCHEMAS[table]) {
      db.exec(TABLE_SCHEMAS[table]);
    }
  }
  // Patch virtual tables
  const vecSQL = getVectorTableSQL();
  if (missing.includes("knowledge_vec")) {
    db.exec(vecSQL[0]);
  }
  if (missing.includes("memory_vec")) {
    db.exec(vecSQL[1]);
  }
  // Always ensure indexes exist
  for (const stmt of INDEX_STATEMENTS) {
    db.exec(stmt);
  }
  return missing;
}
