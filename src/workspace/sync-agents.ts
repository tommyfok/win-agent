import fs from "node:fs";
import path from "node:path";

/**
 * Agent frontmatter configuration per role.
 * Controls which tools each role can access and permission levels.
 *
 * Dual-layer permissions:
 * - opencode agent frontmatter controls tool visibility (static)
 * - database tool's internal checkPermission controls fine-grained DB access (dynamic)
 */
interface AgentFrontmatter {
  description: string;
  mode: string;
  tools: Record<string, boolean>;
  permission: Record<string, string | Record<string, string>>;
}

const AGENT_CONFIGS: Record<string, AgentFrontmatter> = {
  PM: {
    description: "产品经理 - 需求管理、任务派发、进度管控、用户沟通",
    mode: "subagent",
    tools: {
      database_query: true,
      database_insert: true,
      database_update: true,
      read: true,
      write: true,
      edit: true,
      bash: false,
      glob: true,
      grep: true,
    },
    permission: {
      write: {
        ".win-agent/roles/*": "allow",
        "*": "deny",
      },
      edit: {
        ".win-agent/roles/*": "allow",
        "*": "deny",
      },
      bash: "deny",
    },
  },
  SA: {
    description: "架构师 - 技术方案设计、任务拆分、验收标准定义",
    mode: "subagent",
    tools: {
      database_query: true,
      database_insert: true,
      database_update: true,
      read: true,
      write: false,
      edit: false,
      bash: false,
      glob: true,
      grep: true,
    },
    permission: {
      edit: "deny",
      bash: "deny",
    },
  },
  DEV: {
    description: "程序员 - 代码实现、自测、任务状态更新",
    mode: "subagent",
    tools: {
      database_query: true,
      database_insert: true,
      database_update: true,
      read: true,
      write: true,
      edit: true,
      bash: true,
      glob: true,
      grep: true,
    },
    permission: {
      edit: "allow",
      bash: "allow",
    },
  },
  QA: {
    description: "QA工程师 - 验收测试、缺陷记录、回归验证",
    mode: "subagent",
    tools: {
      database_query: true,
      database_insert: true,
      database_update: true,
      read: true,
      write: false,
      edit: false,
      bash: true,
      glob: true,
      grep: true,
    },
    permission: {
      edit: "deny",
      bash: {
        "git diff*": "allow",
        "git log*": "allow",
        "git show*": "allow",
        "npm test*": "allow",
        "npx*": "allow",
        "*": "ask",
      },
    },
  },
  OPS: {
    description: "运营工程师 - 知识库维护、角色优化、流程调优、指标分析",
    mode: "subagent",
    tools: {
      database_query: true,
      database_insert: true,
      database_update: true,
      read: true,
      write: true,
      edit: true,
      bash: false,
      glob: true,
      grep: true,
    },
    permission: {
      write: {
        ".win-agent/*": "allow",
        "*": "deny",
      },
      edit: {
        ".win-agent/*": "allow",
        "*": "deny",
      },
      bash: "deny",
    },
  },
};

/**
 * Generate YAML frontmatter string from agent config.
 */
function buildFrontmatter(config: AgentFrontmatter): string {
  const lines: string[] = ["---"];
  lines.push(`description: "${config.description}"`);
  lines.push(`mode: ${config.mode}`);

  // Tools
  lines.push("tools:");
  for (const [tool, enabled] of Object.entries(config.tools)) {
    lines.push(`  ${tool}: ${enabled}`);
  }

  // Permission
  lines.push("permission:");
  for (const [key, value] of Object.entries(config.permission)) {
    if (typeof value === "string") {
      lines.push(`  ${key}: ${value}`);
    } else {
      lines.push(`  ${key}:`);
      for (const [pattern, perm] of Object.entries(value)) {
        lines.push(`    "${pattern}": "${perm}"`);
      }
    }
  }

  lines.push("---");
  return lines.join("\n");
}

/**
 * Sync role prompts from .win-agent/roles/ to .opencode/agents/.
 * Reads pure markdown prompts, prepends opencode frontmatter, writes to agent dir.
 */
export function syncAgents(workspace: string): string[] {
  const rolesDir = path.join(workspace, ".win-agent", "roles");
  const opencodeDir = path.join(workspace, ".opencode");
  const agentsDir = path.join(opencodeDir, "agents");

  // Ensure .opencode/agents/ exists
  fs.mkdirSync(agentsDir, { recursive: true });

  // Ensure opencode.json has permission: allow (agents run autonomously)
  const configFile = path.join(opencodeDir, "opencode.json");
  let opencodeConfig: Record<string, any> = {};
  if (fs.existsSync(configFile)) {
    try { opencodeConfig = JSON.parse(fs.readFileSync(configFile, "utf-8")); } catch {}
  }
  if (opencodeConfig.permission !== "allow") {
    opencodeConfig.permission = "allow";
    fs.writeFileSync(configFile, JSON.stringify(opencodeConfig, null, 2), "utf-8");
  }

  const synced: string[] = [];

  for (const [role, config] of Object.entries(AGENT_CONFIGS)) {
    const promptFile = path.join(rolesDir, `${role}.md`);
    if (!fs.existsSync(promptFile)) {
      console.log(`   ⚠️  角色文件不存在: ${role}.md`);
      continue;
    }

    const promptContent = fs.readFileSync(promptFile, "utf-8");
    const frontmatter = buildFrontmatter(config);
    const agentContent = `${frontmatter}\n\n${promptContent}`;

    const agentFile = path.join(agentsDir, `${role}.md`);
    fs.writeFileSync(agentFile, agentContent, "utf-8");
    synced.push(role);
  }

  return synced;
}

/**
 * Deploy custom tools to .opencode/tools/.
 * Copies the database tool template to the workspace.
 */
export function deployTools(workspace: string): void {
  const toolsDir = path.join(workspace, ".opencode", "tools");
  fs.mkdirSync(toolsDir, { recursive: true });

  // Find the database tool template
  // In dev: src/tools/database-tool.ts
  // In dist: the content is embedded
  const toolContent = getDatabaseToolContent(workspace);
  const toolFile = path.join(toolsDir, "database.ts");
  fs.writeFileSync(toolFile, toolContent, "utf-8");
}

/**
 * Generate the database tool content with the correct DB path embedded.
 */
function getDatabaseToolContent(workspace: string): string {
  const dbRelPath = ".win-agent/win-agent.db";
  return `// Auto-generated by win-agent — do not edit manually
import { tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import path from "node:path";

const z = tool.schema;

let _db: InstanceType<typeof Database> | null = null;

async function getDb(directory: string) {
  if (!_db) {
    const dbPath = path.join(directory, "${dbRelPath}");
    _db = new Database(dbPath);
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA foreign_keys = ON");
    try {
      const sqliteVec = await import("sqlite-vec");
      const load = sqliteVec.load ?? sqliteVec.default?.load;
      if (load) load(_db);
    } catch {}
  }
  return _db;
}

const TABLES = [
  "messages", "tasks", "task_dependencies", "knowledge", "logs",
  "memory", "workflow_instances", "iterations", "proposals", "project_config",
  "role_outputs", "task_events", "role_permissions",
] as const;

function parseJsonArg(val: any): any {
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

function ensureObject(val: any, label: string): Record<string, any> {
  if (Array.isArray(val) || typeof val !== "object" || val === null) {
    throw new Error(\`\${label} 必须是 JSON 对象（如 {"id":1}），收到: \${JSON.stringify(val)}\`);
  }
  return val;
}

function ensureNonEmpty(obj: Record<string, any>, label: string): void {
  if (Object.keys(obj).length === 0) {
    throw new Error(\`\${label} 不能为空对象\`);
  }
}

/** Cache PRAGMA results per table to avoid repeated calls within one tool invocation */
const _colCache = new Map<string, string[]>();
function getTableColumns(db: InstanceType<typeof Database>, table: string): string[] {
  let cached = _colCache.get(table);
  if (!cached) {
    const cols = db.prepare(\`PRAGMA table_info(\${table})\`).all() as Array<{ name: string }>;
    cached = cols.map((c: any) => c.name);
    _colCache.set(table, cached);
  }
  return cached;
}

function validateColumns(db: InstanceType<typeof Database>, table: string, keys: string[]): void {
  const validCols = getTableColumns(db, table);
  const invalid = keys.filter((k: string) => !validCols.includes(k));
  if (invalid.length > 0) {
    throw new Error(
      \`列名错误: \${invalid.join(", ")} 不存在于 \${table} 表。有效列: \${validCols.join(", ")}\`
    );
  }
}

/** Validate order_by to prevent SQL injection. Only allows "col [ASC|DESC][, ...]" */
function validateOrderBy(db: InstanceType<typeof Database>, table: string, orderBy: string): void {
  const validCols = getTableColumns(db, table);
  const parts = orderBy.split(",").map((p: string) => p.trim());
  for (const part of parts) {
    const tokens = part.split(/\\s+/);
    const col = tokens[0];
    const dir = tokens[1]?.toUpperCase();
    if (!validCols.includes(col)) {
      throw new Error(\`order_by 列名错误: \${col} 不存在于 \${table} 表。有效列: \${validCols.join(", ")}\`);
    }
    if (dir && dir !== "ASC" && dir !== "DESC") {
      throw new Error(\`order_by 排序方向错误: \${dir}，只允许 ASC 或 DESC\`);
    }
    if (tokens.length > 2) {
      throw new Error(\`order_by 格式错误: "\${part}"，格式应为 "列名 [ASC|DESC]"\`);
    }
  }
}

/** Serialize a value for SQLite binding. Objects/arrays → JSON string. */
function toSqlValue(val: any): any {
  if (val === null || val === undefined) return null;
  if (typeof val === "object" && !ArrayBuffer.isView(val)) return JSON.stringify(val);
  return val;
}

export const query = tool({
  description: "查询数据库表记录",
  args: {
    table: z.enum(TABLES).describe("表名"),
    where: z.string().optional().describe("查询条件，JSON 对象字符串，如 {\\"status\\":\\"unread\\"}"),
    order_by: z.string().optional().describe("排序字段，如 'created_at DESC'"),
    limit: z.number().optional().describe("返回条数限制"),
  },
  async execute(args: any, ctx: any) {
    const db = await getDb(ctx.directory);
    const rawWhere = parseJsonArg(args.where);

    const params: any[] = [];
    let sql = \`SELECT * FROM \${args.table}\`;

    const where = rawWhere && typeof rawWhere === "object" && !Array.isArray(rawWhere) ? rawWhere : null;
    if (where && Object.keys(where).length > 0) {
      validateColumns(db, args.table, Object.keys(where));
      const clauses: string[] = [];
      for (const [key, value] of Object.entries(where)) {
        if (value === null) {
          clauses.push(\`\${key} IS NULL\`);
        } else if (Array.isArray(value)) {
          if (value.length === 0) { clauses.push("0"); continue; }
          clauses.push(\`\${key} IN (\${value.map(() => "?").join(", ")})\`);
          params.push(...value);
        } else {
          clauses.push(\`\${key} = ?\`);
          params.push(value);
        }
      }
      sql += \` WHERE \${clauses.join(" AND ")}\`;
    }
    if (args.order_by) {
      validateOrderBy(db, args.table, args.order_by);
      sql += \` ORDER BY \${args.order_by}\`;
    }
    if (args.limit != null) { sql += " LIMIT ?"; params.push(args.limit); }

    const rows = db.prepare(sql).all(...params);
    return JSON.stringify(rows, null, 2);
  },
});

export const insert = tool({
  description: "向数据库表插入记录",
  args: {
    table: z.enum(TABLES).describe("表名"),
    data: z.string().describe("要插入的数据，JSON 对象字符串，如 {\\"from_role\\":\\"PM\\",\\"to_role\\":\\"SA\\",\\"content\\":\\"...\\",\\"status\\":\\"unread\\"}"),
  },
  async execute(args: any, ctx: any) {
    const db = await getDb(ctx.directory);

    const data = ensureObject(parseJsonArg(args.data), "data");
    ensureNonEmpty(data, "data");

    const keys = Object.keys(data);
    validateColumns(db, args.table, keys);
    const placeholders = keys.map(() => "?").join(", ");
    const sql = \`INSERT INTO \${args.table} (\${keys.join(", ")}) VALUES (\${placeholders})\`;
    const values = keys.map((k: string) => toSqlValue(data[k]));
    const result = db.prepare(sql).run(...values);
    return JSON.stringify({ id: Number(result.lastInsertRowid) });
  },
});

export const update = tool({
  description: "更新数据库表记录",
  args: {
    table: z.enum(TABLES).describe("表名"),
    where: z.string().describe("更新条件，JSON 对象字符串，如 {\\"id\\":1}"),
    data: z.string().describe("要更新的字段，JSON 对象字符串，如 {\\"status\\":\\"done\\"}"),
  },
  async execute(args: any, ctx: any) {
    const db = await getDb(ctx.directory);

    const where = ensureObject(parseJsonArg(args.where), "where");
    const data = ensureObject(parseJsonArg(args.data), "data");
    ensureNonEmpty(where, "where");
    ensureNonEmpty(data, "data");

    validateColumns(db, args.table, Object.keys(data));
    validateColumns(db, args.table, Object.keys(where));

    if (args.table === "tasks" && data.status && where?.id) {
      try {
        const prev = db.prepare("SELECT status FROM tasks WHERE id = ?").get(where.id);
        if (prev) {
          db.prepare(
            "INSERT INTO task_events (task_id, from_status, to_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)"
          ).run(where.id, prev.status, data.status, ctx.agent || "unknown", data.rejection_reason || null);
        }
      } catch {}
    }

    const params: any[] = [];
    const setClauses = Object.keys(data).map((key: string) => {
      params.push(toSqlValue(data[key]));
      return \`\${key} = ?\`;
    });
    if (!data.updated_at) {
      const cols = db.prepare(\`PRAGMA table_info(\${args.table})\`).all() as Array<{ name: string }>;
      if (cols.some((c: any) => c.name === "updated_at")) {
        setClauses.push("updated_at = CURRENT_TIMESTAMP");
      }
    }

    const whereClauses: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        whereClauses.push(\`\${key} IS NULL\`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) { whereClauses.push("0"); continue; }
        whereClauses.push(\`\${key} IN (\${value.map(() => "?").join(", ")})\`);
        params.push(...value);
      } else {
        whereClauses.push(\`\${key} = ?\`);
        params.push(value);
      }
    }

    const sql = \`UPDATE \${args.table} SET \${setClauses.join(", ")} WHERE \${whereClauses.join(" AND ")}\`;
    const result = db.prepare(sql).run(...params);
    return JSON.stringify({ changes: result.changes });
  },
});
`;
}
