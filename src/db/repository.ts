import { getDb } from "./connection.js";

/** Cache of whether each table has an updated_at column (avoids repeated PRAGMA queries). */
const tableHasUpdatedAt = new Map<string, boolean>();

export interface QueryOptions {
  orderBy?: string;
  limit?: number;
  offset?: number;
}

export function select(
  table: string,
  where?: Record<string, any>,
  options?: QueryOptions
): any[] {
  const db = getDb();
  const params: any[] = [];
  let sql = `SELECT * FROM ${table}`;

  if (where && Object.keys(where).length > 0) {
    const clauses: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        clauses.push(`${key} IS NULL`);
      } else if (Array.isArray(value)) {
        const placeholders = value.map(() => "?").join(", ");
        clauses.push(`${key} IN (${placeholders})`);
        params.push(...value);
      } else {
        clauses.push(`${key} = ?`);
        params.push(value);
      }
    }
    sql += ` WHERE ${clauses.join(" AND ")}`;
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

  return db.prepare(sql).all(...params);
}

export function insert(
  table: string,
  data: Record<string, any>
): { lastInsertRowid: number | bigint } {
  const db = getDb();
  const keys = Object.keys(data);
  const placeholders = keys.map(() => "?").join(", ");
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`;
  const values = keys.map((k) => data[k]);
  const result = db.prepare(sql).run(...values);
  return { lastInsertRowid: result.lastInsertRowid };
}

export function update(
  table: string,
  where: Record<string, any>,
  data: Record<string, any>
): { changes: number } {
  const db = getDb();
  const params: any[] = [];

  const setClauses = Object.keys(data).map((key) => {
    params.push(data[key]);
    return `${key} = ?`;
  });

  // Auto-update updated_at if the table has the column (result cached per table)
  if (!data.updated_at) {
    let hasCol = tableHasUpdatedAt.get(table);
    if (hasCol === undefined) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      hasCol = cols.some((c) => c.name === "updated_at");
      tableHasUpdatedAt.set(table, hasCol);
    }
    if (hasCol) {
      setClauses.push("updated_at = CURRENT_TIMESTAMP");
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

  const sql = `UPDATE ${table} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")}`;
  const result = db.prepare(sql).run(...params);
  return { changes: result.changes };
}

export function del(
  table: string,
  where: Record<string, any>
): { changes: number } {
  const db = getDb();
  const params: any[] = [];
  const clauses: string[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === null) {
      clauses.push(`${key} IS NULL`);
    } else {
      clauses.push(`${key} = ?`);
      params.push(value);
    }
  }

  const sql = `DELETE FROM ${table} WHERE ${clauses.join(" AND ")}`;
  const result = db.prepare(sql).run(...params);
  return { changes: result.changes };
}

export function rawQuery(sql: string, params: any[] = []): any[] {
  const db = getDb();
  return db.prepare(sql).all(...params);
}

export function rawRun(
  sql: string,
  params: any[] = []
): { changes: number; lastInsertRowid: number } {
  const db = getDb();
  const result = db.prepare(sql).run(...params);
  return {
    changes: result.changes,
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}
