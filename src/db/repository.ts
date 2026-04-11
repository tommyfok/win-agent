import { getDb } from './connection.js';

/** Cache of whether each table has an updated_at column (avoids repeated PRAGMA queries). */
const tableHasUpdatedAt = new Map<string, boolean>();

export interface QueryOptions {
  orderBy?: string;
  limit?: number;
  offset?: number;
}

/** Primitive values accepted by SQLite prepared statements. */
export type SqlValue = string | number | bigint | boolean | null | Buffer;

export function select<T = Record<string, SqlValue>>(
  table: string,
  where?: Record<string, SqlValue>,
  options?: QueryOptions
): T[] {
  const db = getDb();
  const params: SqlValue[] = [];
  let sql = `SELECT * FROM ${table}`;

  if (where && Object.keys(where).length > 0) {
    const clauses: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        clauses.push(`${key} IS NULL`);
      } else if (Array.isArray(value)) {
        const placeholders = (value as SqlValue[]).map(() => '?').join(', ');
        clauses.push(`${key} IN (${placeholders})`);
        params.push(...(value as SqlValue[]));
      } else {
        clauses.push(`${key} = ?`);
        params.push(value);
      }
    }
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }

  if (options?.orderBy) {
    // Whitelist: allow "column [ASC|DESC]" or "table.column [ASC|DESC]"
    if (!/^[\w.]+(\s+(ASC|DESC))?$/i.test(options.orderBy)) {
      throw new Error(`Invalid orderBy value: ${options.orderBy}`);
    }
    sql += ` ORDER BY ${options.orderBy}`;
  }
  if (options?.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }
  if (options?.offset !== undefined) {
    sql += ` OFFSET ?`;
    params.push(options.offset);
  }

  return db.prepare(sql).all(...params) as T[];
}

export function insert(
  table: string,
  data: Record<string, SqlValue>
): { lastInsertRowid: number | bigint } {
  const db = getDb();
  const keys = Object.keys(data);
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  const values = keys.map((k) => data[k]);
  const result = db.prepare(sql).run(...values);
  return { lastInsertRowid: result.lastInsertRowid };
}

export function update(
  table: string,
  where: Record<string, SqlValue>,
  data: Record<string, SqlValue>
): { changes: number } {
  const db = getDb();
  const params: SqlValue[] = [];

  const setClauses = Object.keys(data).map((key) => {
    params.push(data[key]);
    return `${key} = ?`;
  });

  // Auto-update updated_at if the table has the column (result cached per table)
  if (!data.updated_at) {
    let hasCol = tableHasUpdatedAt.get(table);
    if (hasCol === undefined) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      hasCol = cols.some((c) => c.name === 'updated_at');
      tableHasUpdatedAt.set(table, hasCol);
    }
    if (hasCol) {
      setClauses.push('updated_at = CURRENT_TIMESTAMP');
    }
  }

  const whereClauses: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === null) {
      whereClauses.push(`${key} IS NULL`);
    } else {
      whereClauses.push(`${key} = ?`);
      params.push(value);
    }
  }

  const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;
  const result = db.prepare(sql).run(...params);
  return { changes: result.changes };
}

export function del(table: string, where: Record<string, SqlValue>): { changes: number } {
  const db = getDb();
  const params: SqlValue[] = [];
  const clauses: string[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === null) {
      clauses.push(`${key} IS NULL`);
    } else {
      clauses.push(`${key} = ?`);
      params.push(value);
    }
  }

  const sql = `DELETE FROM ${table} WHERE ${clauses.join(' AND ')}`;
  const result = db.prepare(sql).run(...params);
  return { changes: result.changes };
}

export function rawQuery<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): T[] {
  const db = getDb();
  return db.prepare(sql).all(...params) as T[];
}

export function rawRun(
  sql: string,
  params: SqlValue[] = []
): { changes: number; lastInsertRowid: number } {
  const db = getDb();
  const result = db.prepare(sql).run(...params);
  return {
    changes: result.changes,
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

/**
 * Upsert a key-value pair in project_config (INSERT OR REPLACE).
 */
export function upsertProjectConfig(key: string, value: string): void {
  rawRun(
    `INSERT OR REPLACE INTO project_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
    [key, value]
  );
}

/**
 * Execute a function inside a SQLite transaction.
 * Uses better-sqlite3's synchronous transaction API — the callback must be synchronous.
 * On success, commits and returns the result. On exception, rolls back and rethrows.
 */
export function withTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
