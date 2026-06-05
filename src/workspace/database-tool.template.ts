/**
 * Template for the per-role database tool deployed to `.opencode/tools/database_*.ts`.
 * Placeholders `__WIN_AGENT_ROLE__` and `__WIN_AGENT_DB_REL_PATH__` are replaced at deploy time
 * by `deployTools()` in sync-agents.ts.
 */
import { tool, type ToolContext, type ToolDefinition } from '@opencode-ai/plugin';
import path from 'node:path';

/** Hardcoded role identity — ctx.agent is unreliable */
const ROLE = '__WIN_AGENT_ROLE__';
const CURRENT_DISPATCH_TRACE_KEY = 'engine.currentDispatchTraceId';
const MESSAGE_PROTOCOL = 'win-agent.message.v1';
const DISPATCHABLE_MESSAGE_ROLES = ['PM', 'DEV'] as const;
const MESSAGE_TYPE_VALUES = [
  'directive',
  'feedback',
  'review_result',
  'cancel_task',
  'system',
  'notification',
  'reflection',
] as const;
const TASK_BOUND_MESSAGE_TYPES = new Set<string>([
  'directive',
  'feedback',
  'review_result',
  'cancel_task',
  'system',
  'notification',
]);
const GLOBAL_MESSAGE_TYPES = new Set<string>(['reflection']);

/** Task status values (hardcoded to avoid cross-module imports) */
const TASK_STATUS_VALUES = [
  'pending_pm',
  'pending_dev',
  'in_dev',
  'pending_review',
  'in_review',
  'done',
  'rejected',
  'cancelled',
  'paused',
  'blocked',
] as const;

/**
 * 状态转换的角色白名单。结构与 src/db/state-machine.ts 的 TASK_TRANSITION_ROLES 一致。
 * 未在此映射中的转换表示所有角色均可执行。
 */
const TASK_TRANSITION_ROLES: Partial<Record<string, Partial<Record<string, string[]>>>> = {
  pending_dev: {
    in_dev: ['DEV', 'system'],
  },
};

const z = tool.schema;

/** Minimal SQLite surface (bun:sqlite or better-sqlite3). */
type SqliteStatement = {
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => { lastInsertRowid: bigint | number; changes: number };
};

type SqliteDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

let _db: SqliteDb | null = null;

async function getDb(directory: string): Promise<SqliteDb> {
  if (!_db) {
    const dbPath = path.join(directory, '__WIN_AGENT_DB_REL_PATH__');
    // Runtime-agnostic: try bun:sqlite first, fall back to better-sqlite3
    try {
      const bunSqlite = await import('bun:sqlite');
      const BunDatabase = bunSqlite.Database ?? bunSqlite.default?.Database;
      _db = new BunDatabase(dbPath) as SqliteDb;
    } catch {
      const betterSqlite = await import('better-sqlite3');
      const BetterDatabase = betterSqlite.default ?? betterSqlite;
      _db = new (BetterDatabase as new (path: string) => SqliteDb)(dbPath);
    }
    _db.exec('PRAGMA journal_mode = WAL');
    _db.exec('PRAGMA foreign_keys = ON');
    try {
      const sqliteVec = await import('sqlite-vec');
      const load = sqliteVec.load ?? sqliteVec.default?.load;
      // sqlite-vec expects the native driver's Db shape; both runtimes are compatible at runtime
      if (load) load(_db as never);
    } catch {
      /* optional extension */
    }
  }
  return _db;
}

const TABLES = [
  'messages',
  'tasks',
  'task_dependencies',
  'knowledge',
  'logs',
  'memory',
  'iterations',
  'proposals',
  'project_config',
  'role_outputs',
  'task_events',
  'role_permissions',
] as const;

function parseJsonArg(val: unknown): unknown {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

function ensureObject(val: unknown, label: string): Record<string, unknown> {
  if (Array.isArray(val) || typeof val !== 'object' || val === null) {
    throw new Error(`${label} 必须是 JSON 对象（如 {"id":1}），收到: ${JSON.stringify(val)}`);
  }
  return val as Record<string, unknown>;
}

function ensureNonEmpty(obj: Record<string, unknown>, label: string): void {
  if (Object.keys(obj).length === 0) {
    throw new Error(`${label} 不能为空对象`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function messageValidationError(message: string): string {
  return `messages 校验失败: ${message}`;
}

function validateMessagePartialFields(data: Record<string, unknown>): string | null {
  if (
    data.to_role !== undefined &&
    (typeof data.to_role !== 'string' ||
      !DISPATCHABLE_MESSAGE_ROLES.includes(
        data.to_role as (typeof DISPATCHABLE_MESSAGE_ROLES)[number]
      ))
  ) {
    return messageValidationError(
      `to_role 必须是可调度角色 ${DISPATCHABLE_MESSAGE_ROLES.join('/')}，收到 ${JSON.stringify(data.to_role)}`
    );
  }

  if (
    data.type !== undefined &&
    (typeof data.type !== 'string' ||
      !MESSAGE_TYPE_VALUES.includes(data.type as (typeof MESSAGE_TYPE_VALUES)[number]))
  ) {
    return messageValidationError(
      `type 必须是合法类型 ${MESSAGE_TYPE_VALUES.join(', ')}，收到 ${JSON.stringify(data.type)}`
    );
  }

  if (
    data.related_task_id !== undefined &&
    data.related_task_id !== null &&
    !isPositiveInteger(data.related_task_id)
  ) {
    return messageValidationError('related_task_id 必须是正整数或 null');
  }

  if (
    data.related_iteration_id !== undefined &&
    data.related_iteration_id !== null &&
    !isPositiveInteger(data.related_iteration_id)
  ) {
    return messageValidationError('related_iteration_id 必须是正整数或 null');
  }

  return null;
}

function validateMessageRecord(record: Record<string, unknown>): string | null {
  const partialErr = validateMessagePartialFields(record);
  if (partialErr) return partialErr;

  const type = record.type === undefined ? 'directive' : record.type;
  if (typeof type !== 'string') {
    return messageValidationError(`type 必须是合法类型 ${MESSAGE_TYPE_VALUES.join(', ')}`);
  }

  if (
    typeof record.to_role !== 'string' ||
    !DISPATCHABLE_MESSAGE_ROLES.includes(
      record.to_role as (typeof DISPATCHABLE_MESSAGE_ROLES)[number]
    )
  ) {
    return messageValidationError(
      `to_role 必须是可调度角色 ${DISPATCHABLE_MESSAGE_ROLES.join('/')}，收到 ${JSON.stringify(record.to_role)}`
    );
  }

  if (TASK_BOUND_MESSAGE_TYPES.has(type) && !isPositiveInteger(record.related_task_id)) {
    return messageValidationError(`${type} 消息必须设置 related_task_id`);
  }

  if (
    GLOBAL_MESSAGE_TYPES.has(type) &&
    !isPositiveInteger(record.related_task_id) &&
    !isPositiveInteger(record.related_iteration_id)
  ) {
    return messageValidationError(`${type} 消息无 related_task_id 时必须设置 related_iteration_id`);
  }

  return validateMessageAttachmentConsistency(record, type);
}

function validateMessageAttachmentConsistency(
  record: Record<string, unknown>,
  messageType: string
): string | null {
  const rawAttachments = record.attachments;
  if (rawAttachments === null || rawAttachments === undefined || rawAttachments === '') {
    return null;
  }

  let parsed: unknown = rawAttachments;
  if (typeof rawAttachments === 'string') {
    try {
      parsed = JSON.parse(rawAttachments);
    } catch {
      return null;
    }
  }

  if (!isRecord(parsed) || parsed.protocol !== MESSAGE_PROTOCOL) {
    return null;
  }

  const protocolErr = validateMessageProtocolPayload(parsed);
  if (protocolErr) {
    return messageValidationError(`attachments 协议无效: ${protocolErr}`);
  }

  if (parsed.type !== messageType) {
    return messageValidationError(
      `attachments.type 与 type 不一致: attachments.type=${String(parsed.type)}, type=${messageType}`
    );
  }

  const attachmentTaskId = parsed.task_id === undefined ? null : parsed.task_id;
  const relatedTaskId = record.related_task_id === undefined ? null : record.related_task_id;
  if (attachmentTaskId !== relatedTaskId) {
    return messageValidationError(
      `attachments.task_id 与 related_task_id 不一致: attachments.task_id=${String(attachmentTaskId)}, related_task_id=${String(relatedTaskId)}`
    );
  }

  const attachmentIterationId = parsed.iteration_id === undefined ? null : parsed.iteration_id;
  const relatedIterationId =
    record.related_iteration_id === undefined ? null : record.related_iteration_id;
  if (attachmentIterationId !== relatedIterationId) {
    return messageValidationError(
      `attachments.iteration_id 与 related_iteration_id 不一致: attachments.iteration_id=${String(attachmentIterationId)}, related_iteration_id=${String(relatedIterationId)}`
    );
  }

  return null;
}

function validateMessageProtocolPayload(payload: Record<string, unknown>): string | null {
  if (
    typeof payload.type !== 'string' ||
    !MESSAGE_TYPE_VALUES.includes(payload.type as (typeof MESSAGE_TYPE_VALUES)[number])
  ) {
    return `type 必须是合法类型 ${MESSAGE_TYPE_VALUES.join(', ')}`;
  }

  if (payload.task_id !== undefined && !isPositiveInteger(payload.task_id)) {
    return 'task_id 必须是正整数';
  }

  if (payload.iteration_id !== undefined && !isPositiveInteger(payload.iteration_id)) {
    return 'iteration_id 必须是正整数';
  }

  if (TASK_BOUND_MESSAGE_TYPES.has(payload.type) && !isPositiveInteger(payload.task_id)) {
    return `${payload.type} 消息必须设置 task_id`;
  }

  if (
    GLOBAL_MESSAGE_TYPES.has(payload.type) &&
    !isPositiveInteger(payload.task_id) &&
    !isPositiveInteger(payload.iteration_id)
  ) {
    return `${payload.type} 消息必须设置 task_id 或 iteration_id`;
  }

  return null;
}

function buildWhereClauses(where: Record<string, unknown>, params: unknown[]): string[] {
  const whereClauses: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === null) {
      whereClauses.push(`${key} IS NULL`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        whereClauses.push('0');
        continue;
      }
      whereClauses.push(`${key} IN (${value.map(() => '?').join(', ')})`);
      params.push(...value);
    } else {
      whereClauses.push(`${key} = ?`);
      params.push(value);
    }
  }
  return whereClauses;
}

function validateMessageUpdate(
  db: SqliteDb,
  where: Record<string, unknown>,
  data: Record<string, unknown>
): string | null {
  const partialErr = validateMessagePartialFields(data);
  if (partialErr) return partialErr;

  const params: unknown[] = [];
  const whereClauses = buildWhereClauses(where, params);
  const rows = db
    .prepare(`SELECT * FROM messages WHERE ${whereClauses.join(' AND ')}`)
    .all(...params) as Array<Record<string, unknown>>;

  for (const row of rows) {
    const merged = { ...row, ...data };
    const rowErr = validateMessageRecord(merged);
    if (rowErr) {
      return `${rowErr}（message id=${String(row.id)}）`;
    }
  }

  return null;
}

/** Cache PRAGMA results per table to avoid repeated calls within one tool invocation */
const _colCache = new Map<string, string[]>();

function getTableColumns(db: SqliteDb, table: string): string[] {
  let cached = _colCache.get(table);
  if (!cached) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    cached = cols.map((c) => c.name);
    _colCache.set(table, cached);
  }
  return cached;
}

function validateColumns(db: SqliteDb, table: string, keys: string[]): void {
  const validCols = getTableColumns(db, table);
  const invalid = keys.filter((k) => !validCols.includes(k));
  if (invalid.length > 0) {
    throw new Error(
      `列名错误: ${invalid.join(', ')} 不存在于 ${table} 表。有效列: ${validCols.join(', ')}`
    );
  }
}

function getProjectConfigValue(db: SqliteDb, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM project_config WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value || null;
  } catch {
    return null;
  }
}

/** Validate order_by to prevent SQL injection. Only allows "col [ASC|DESC][, ...]" */
function validateOrderBy(db: SqliteDb, table: string, orderBy: string): void {
  const validCols = getTableColumns(db, table);
  const parts = orderBy.split(',').map((p) => p.trim());
  for (const part of parts) {
    const tokens = part.split(/\s+/);
    const col = tokens[0];
    const dir = tokens[1]?.toUpperCase();
    if (!col || !validCols.includes(col)) {
      throw new Error(
        `order_by 列名错误: ${col ?? '(空)'} 不存在于 ${table} 表。有效列: ${validCols.join(', ')}`
      );
    }
    if (dir && dir !== 'ASC' && dir !== 'DESC') {
      throw new Error(`order_by 排序方向错误: ${dir}，只允许 ASC 或 DESC`);
    }
    if (tokens.length > 2) {
      throw new Error(`order_by 格式错误: "${part}"，格式应为 "列名 [ASC|DESC]"`);
    }
  }
}

/** Serialize a value for SQLite binding. Objects/arrays → JSON string. */
function toSqlValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object' && !ArrayBuffer.isView(val as ArrayBufferView))
    return JSON.stringify(val);
  return val;
}

/**
 * Check if the current agent role has permission for the given operation on a table.
 * Returns null if allowed, or an error string if denied.
 */
function checkPermission(
  db: SqliteDb,
  agent: string,
  table: string,
  operation: string,
  data?: Record<string, unknown>
): string | null {
  if (!agent) return null;
  const rows = db
    .prepare(
      'SELECT conditions FROM role_permissions WHERE role = ? AND table_name = ? AND operation = ?'
    )
    .all(agent, table, operation) as Array<{ conditions: string | null }>;
  if (rows.length === 0) {
    return `权限拒绝: ${agent} 无权对 ${table} 执行 ${operation}`;
  }
  const row = rows[0];
  if (row.conditions && data) {
    try {
      const conds = JSON.parse(row.conditions) as Record<string, unknown>;
      for (const [key, expected] of Object.entries(conds)) {
        if (key.endsWith('_in')) {
          const baseKey = key.slice(0, -3);
          if (Array.isArray(expected) && data[baseKey] !== undefined) {
            if (!expected.includes(data[baseKey])) {
              return `权限拒绝: ${agent} 对 ${table}.${baseKey} 只能使用值 [${expected.join(', ')}]，收到 "${String(data[baseKey])}"`;
            }
          }
          continue;
        }
        if (data[key] !== undefined && data[key] !== expected) {
          return `权限拒绝: ${agent} 对 ${table}.${key} 只能使用值 "${String(expected)}"，收到 "${String(data[key])}"`;
        }
      }
    } catch {
      /* ignore malformed conditions */
    }
  }
  return null;
}

export const query: ToolDefinition = tool({
  description: '查询数据库表记录',
  args: {
    table: z.enum(TABLES).describe('表名'),
    where: z.string().optional().describe('查询条件，JSON 对象字符串，如 {"status":"unread"}'),
    order_by: z.string().optional().describe("排序字段，如 'created_at DESC'"),
    limit: z.number().optional().describe('返回条数限制'),
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const db = await getDb(ctx.directory);
    const permErr = checkPermission(db, ROLE, String(args.table), 'select');
    if (permErr) return JSON.stringify({ error: permErr });

    const rawWhere = parseJsonArg(args.where);

    const params: unknown[] = [];
    let sql = `SELECT * FROM ${String(args.table)}`;

    const where =
      rawWhere && typeof rawWhere === 'object' && !Array.isArray(rawWhere)
        ? (rawWhere as Record<string, unknown>)
        : null;
    if (where && Object.keys(where).length > 0) {
      validateColumns(db, String(args.table), Object.keys(where));
      const clauses: string[] = [];
      for (const [key, value] of Object.entries(where)) {
        if (value === null) {
          clauses.push(`${key} IS NULL`);
        } else if (Array.isArray(value)) {
          if (value.length === 0) {
            clauses.push('0');
            continue;
          }
          clauses.push(`${key} IN (${value.map(() => '?').join(', ')})`);
          params.push(...value);
        } else {
          clauses.push(`${key} = ?`);
          params.push(value);
        }
      }
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    if (args.order_by) {
      validateOrderBy(db, String(args.table), String(args.order_by));
      sql += ` ORDER BY ${args.order_by}`;
    }
    if (args.limit != null) {
      sql += ' LIMIT ?';
      params.push(args.limit);
    }

    const rows = db.prepare(sql).all(...params);
    return JSON.stringify(rows, null, 2);
  },
});

export const insert: ToolDefinition = tool({
  description: '向数据库表插入记录',
  args: {
    table: z.enum(TABLES).describe('表名'),
    data: z
      .string()
      .describe(
        '要插入的数据，JSON 对象字符串，如 {"from_role":"PM","to_role":"DEV","content":"...","status":"unread"}'
      ),
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const db = await getDb(ctx.directory);

    const data = ensureObject(parseJsonArg(args.data), 'data');
    ensureNonEmpty(data, 'data');

    const permErr = checkPermission(db, ROLE, String(args.table), 'insert', data);
    if (permErr) return JSON.stringify({ error: permErr });

    if (args.table === 'task_dependencies' && data.task_id && data.depends_on) {
      if (data.task_id === data.depends_on) {
        return JSON.stringify({ error: '不能让任务依赖自身' });
      }
      const visited = new Set<number>();
      const stack: number[] = [Number(data.depends_on)];
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined) continue;
        if (current === Number(data.task_id)) {
          return JSON.stringify({
            error: `添加依赖会形成循环: task#${String(data.task_id)} → task#${String(data.depends_on)} → ... → task#${String(data.task_id)}`,
          });
        }
        if (visited.has(current)) continue;
        visited.add(current);
        const deps = db
          .prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ?')
          .all(current) as Array<{ depends_on: number }>;
        for (const dep of deps) stack.push(dep.depends_on);
      }
    }

    if (args.table === 'messages' && data.status) {
      const VALID_MSG_STATUS = ['unread', 'read', 'deferred'];
      if (!VALID_MSG_STATUS.includes(String(data.status))) {
        data.status = 'unread';
      }
    }
    if (args.table === 'tasks' && data.status) {
      if (
        !TASK_STATUS_VALUES.includes(String(data.status) as (typeof TASK_STATUS_VALUES)[number])
      ) {
        return JSON.stringify({
          error: `无效的任务状态: ${String(data.status)}，有效值: ${TASK_STATUS_VALUES.join(', ')}`,
        });
      }
    }

    const keys = Object.keys(data);
    validateColumns(db, String(args.table), keys);
    if (args.table === 'messages') {
      const validationErr = validateMessageRecord(data);
      if (validationErr) return JSON.stringify({ error: validationErr });
    }
    const placeholders = keys.map(() => '?').join(', ');
    const sql = `INSERT INTO ${String(args.table)} (${keys.join(', ')}) VALUES (${placeholders})`;
    const values = keys.map((k) => toSqlValue(data[k]));
    const result = db.prepare(sql).run(...values);
    return JSON.stringify({ id: Number(result.lastInsertRowid) });
  },
});

export const update: ToolDefinition = tool({
  description: '更新数据库表记录',
  args: {
    table: z.enum(TABLES).describe('表名'),
    where: z.string().describe('更新条件，JSON 对象字符串，如 {"id":1}'),
    data: z.string().describe('要更新的字段，JSON 对象字符串，如 {"status":"done"}'),
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const db = await getDb(ctx.directory);

    const where = ensureObject(parseJsonArg(args.where), 'where');
    const data = ensureObject(parseJsonArg(args.data), 'data');
    ensureNonEmpty(where, 'where');
    ensureNonEmpty(data, 'data');

    const permErr = checkPermission(db, ROLE, String(args.table), 'update', data);
    if (permErr) return JSON.stringify({ error: permErr });

    if (args.table === 'messages' && data.status) {
      const VALID_MSG_STATUS = ['unread', 'read', 'deferred'];
      if (!VALID_MSG_STATUS.includes(String(data.status))) {
        data.status = 'unread';
      }
    }
    if (args.table === 'tasks' && data.status) {
      if (
        !TASK_STATUS_VALUES.includes(String(data.status) as (typeof TASK_STATUS_VALUES)[number])
      ) {
        return JSON.stringify({
          error: `无效的任务状态: ${String(data.status)}，有效值: ${TASK_STATUS_VALUES.join(', ')}`,
        });
      }
      // Reject with empty reason is forbidden
      if (String(data.status) === 'rejected') {
        const hasReason =
          data.rejection_reason != null && String(data.rejection_reason).trim() !== '';
        if (!hasReason) {
          return JSON.stringify({
            error: '任务状态设为 rejected 时必须提供非空 rejection_reason',
          });
        }
      }
      // Role-based transition check
      if (where.id != null) {
        const prev = db.prepare('SELECT status FROM tasks WHERE id = ?').get(where.id) as
          | { status: string }
          | undefined;
        if (prev) {
          const allowedRoles = TASK_TRANSITION_ROLES[prev.status]?.[String(data.status)];
          if (allowedRoles && !allowedRoles.includes(ROLE)) {
            return JSON.stringify({
              error: `角色 ${ROLE} 无权将任务状态从 ${prev.status} 更改为 ${String(data.status)}，允许的角色: ${allowedRoles.join(', ')}`,
            });
          }
        }
      }
    }

    validateColumns(db, String(args.table), Object.keys(data));
    validateColumns(db, String(args.table), Object.keys(where));
    if (args.table === 'messages') {
      const validationErr = validateMessageUpdate(db, where, data);
      if (validationErr) return JSON.stringify({ error: validationErr });
    }

    if (args.table === 'tasks' && data.status && where.id != null) {
      const prev = db.prepare('SELECT status FROM tasks WHERE id = ?').get(where.id) as
        | { status: string }
        | undefined;

      try {
        if (prev) {
          const reason = data.rejection_reason != null ? data.rejection_reason : null;
          const traceId = getProjectConfigValue(db, CURRENT_DISPATCH_TRACE_KEY);
          if (getTableColumns(db, 'task_events').includes('trace_id')) {
            db.prepare(
              'INSERT INTO task_events (task_id, from_status, to_status, changed_by, reason, trace_id) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(where.id, prev.status, data.status, ROLE, reason, traceId);
          } else {
            db.prepare(
              'INSERT INTO task_events (task_id, from_status, to_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)'
            ).run(where.id, prev.status, data.status, ROLE, reason);
          }
        }
      } catch {
        /* best-effort event log */
      }
    }

    const params: unknown[] = [];
    const setClauses = Object.keys(data).map((key) => {
      params.push(toSqlValue(data[key]));
      return `${key} = ?`;
    });
    if (!data.updated_at) {
      const cols = db.prepare(`PRAGMA table_info(${String(args.table)})`).all() as Array<{
        name: string;
      }>;
      if (cols.some((c) => c.name === 'updated_at')) {
        setClauses.push('updated_at = CURRENT_TIMESTAMP');
      }
    }

    const whereClauses: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        whereClauses.push(`${key} IS NULL`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          whereClauses.push('0');
          continue;
        }
        whereClauses.push(`${key} IN (${value.map(() => '?').join(', ')})`);
        params.push(...value);
      } else {
        whereClauses.push(`${key} = ?`);
        params.push(value);
      }
    }

    const sql = `UPDATE ${String(args.table)} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;
    const result = db.prepare(sql).run(...params);
    return JSON.stringify({ changes: result.changes });
  },
});
