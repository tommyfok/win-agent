import { loadConfig } from '../config/index.js';
import { getDb } from '../db/connection.js';
import { rawQuery } from '../db/repository.js';
import { MessageStatus, TaskStatus } from '../db/types.js';
import { Role } from '../engine/role-manager.js';
import { CURRENT_DISPATCH_TRACE_KEY } from '../engine/trace.js';

const AGENT_QUEUE_ROLES = [Role.PM, Role.DEV] as const;
const DEFAULT_PM_COOLDOWN_MS = 3000;

export interface SchedulerExplanationSnapshot {
  overview: {
    lastDispatchedRole: string | null;
    currentDispatchTrace: string | null;
    pmCooldownRemainingMs: number;
  };
  roleQueues: Array<{
    role: Role;
    unread: number;
    deferred: number;
    dispatching: number;
  }>;
  dispatchingMessages: Array<{
    id: number;
    toRole: string;
    fromRole: string;
    relatedTaskId: number | null;
    taskTitle: string | null;
    relatedIterationId: number | null;
    traceId: string | null;
    ageMinutes: number;
  }>;
  blockedTasks: Array<{
    id: number;
    title: string;
    status: string;
    iterationId: number | null;
    incompleteDependencies: Array<{
      id: number;
      title: string;
      status: string;
    }>;
  }>;
  autoTriggerCandidates: string[];
  recentEvents: Array<{
    kind: string;
    role: string;
    content: string;
    relatedTaskId: number | null;
    traceId: string | null;
    createdAt: string;
  }>;
}

interface CollectOptions {
  now?: Date;
  pmCooldownMs?: number;
}

interface ProjectConfigRow {
  key: string;
  value: string;
}

interface MessageQueueCountRow {
  to_role: Role;
  status: string;
  cnt: number;
}

interface DispatchingMessageRow {
  id: number;
  to_role: string;
  from_role: string;
  related_task_id: number | null;
  related_iteration_id: number | null;
  created_at: string;
  task_title: string | null;
  trace_id?: string | null;
}

interface BlockedTaskRow {
  id: number;
  title: string;
  status: string;
  iteration_id: number | null;
}

interface DependencyRow {
  task_id: number;
  dep_id: number;
  dep_title: string;
  dep_status: string;
}

interface ActiveIterationStatsRow {
  id: number;
  total: number;
  done: number;
  rejected: number;
  remaining: number;
}

interface RecentEventRow {
  kind: string;
  role: string;
  content: string;
  related_task_id: number | null;
  trace_id?: string | null;
  created_at: string;
}

export function collectSchedulerExplanationSnapshot(
  options: CollectOptions = {}
): SchedulerExplanationSnapshot {
  const now = options.now ?? new Date();
  const pmCooldownMs = options.pmCooldownMs ?? readPmCooldownMs();
  const columns = {
    messages: getColumnNames('messages'),
    logs: getColumnNames('logs'),
    role_outputs: getColumnNames('role_outputs'),
  };

  const config = readProjectConfig();
  const pmLastDispatchEnd = parseInteger(config['engine.pmLastDispatchEnd']);
  const pmCooldownRemainingMs = Math.max(0, pmCooldownMs - (now.getTime() - pmLastDispatchEnd));

  return {
    overview: {
      lastDispatchedRole: config['engine.lastDispatchedRole'] || null,
      currentDispatchTrace:
        config[CURRENT_DISPATCH_TRACE_KEY] ||
        config['engine.currentDispatchTrace'] ||
        config['engine.currentDispatch.traceId'] ||
        config['engine.currentTraceId'] ||
        null,
      pmCooldownRemainingMs,
    },
    roleQueues: collectRoleQueues(),
    dispatchingMessages: collectDispatchingMessages(now, columns.messages.has('trace_id')),
    blockedTasks: collectBlockedTasks(),
    autoTriggerCandidates: collectAutoTriggerCandidates(),
    recentEvents: collectRecentEvents({
      logsHasTrace: columns.logs.has('trace_id'),
      roleOutputsHasTrace: columns.role_outputs.has('trace_id'),
    }),
  };
}

export function formatSchedulerExplanation(snapshot: SchedulerExplanationSnapshot): string[] {
  const lines: string[] = ['\n🧭 调度解释:'];
  const cooldown =
    snapshot.overview.pmCooldownRemainingMs > 0
      ? `PM cooldown 剩余 ${formatDuration(snapshot.overview.pmCooldownRemainingMs)}`
      : 'PM 无 cooldown';
  lines.push(
    `   概览: last=${snapshot.overview.lastDispatchedRole ?? '-'} | trace=${
      snapshot.overview.currentDispatchTrace ?? '-'
    } | ${cooldown}`
  );

  lines.push('   角色队列:');
  for (const q of snapshot.roleQueues) {
    lines.push(
      `     ${q.role}: unread ${q.unread} / deferred ${q.deferred} / dispatching ${q.dispatching}`
    );
  }

  lines.push('   当前处理中:');
  if (snapshot.dispatchingMessages.length === 0) {
    lines.push('     无 dispatching 消息');
  } else {
    for (const msg of snapshot.dispatchingMessages) {
      const task = msg.relatedTaskId
        ? `task#${msg.relatedTaskId}${msg.taskTitle ? `「${msg.taskTitle}」` : ''}`
        : '无关联任务';
      const iter = msg.relatedIterationId ? ` | iter#${msg.relatedIterationId}` : '';
      const trace = msg.traceId ? ` | trace=${msg.traceId}` : '';
      lines.push(
        `     msg#${msg.id} ${msg.fromRole}→${msg.toRole} | ${task}${iter} | ${msg.ageMinutes}m${trace}`
      );
    }
  }

  lines.push('   阻塞任务:');
  if (snapshot.blockedTasks.length === 0) {
    lines.push('     无阻塞任务');
  } else {
    for (const task of snapshot.blockedTasks) {
      const deps =
        task.incompleteDependencies.length > 0
          ? task.incompleteDependencies.map((d) => `#${d.id}「${d.title}」(${d.status})`).join(', ')
          : '未记录未完成依赖';
      const iter = task.iterationId ? ` | iter#${task.iterationId}` : '';
      lines.push(`     task#${task.id}「${task.title}」(${task.status})${iter} | 依赖: ${deps}`);
    }
  }

  lines.push('   自动触发候选:');
  if (snapshot.autoTriggerCandidates.length === 0) {
    lines.push('     暂无明显候选');
  } else {
    for (const candidate of snapshot.autoTriggerCandidates) {
      lines.push(`     ${candidate}`);
    }
  }

  lines.push('   最近事件:');
  if (snapshot.recentEvents.length === 0) {
    lines.push('     无调度/自动触发事件');
  } else {
    for (const event of snapshot.recentEvents) {
      const trace = event.traceId ? ` | trace=${event.traceId}` : '';
      const task = event.relatedTaskId ? ` | task#${event.relatedTaskId}` : '';
      lines.push(
        `     [${formatTime(event.createdAt)}] ${event.kind} ${event.role}${task}${trace}: ${summarize(
          event.content
        )}`
      );
    }
  }

  return lines;
}

function readProjectConfig(): Record<string, string> {
  const rows = rawQuery<ProjectConfigRow>('SELECT key, value FROM project_config');
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function collectRoleQueues(): SchedulerExplanationSnapshot['roleQueues'] {
  const rows = rawQuery<MessageQueueCountRow>(
    `SELECT to_role, status, COUNT(*) as cnt
     FROM messages
     WHERE to_role IN (?, ?)
       AND status IN (?, ?, ?)
     GROUP BY to_role, status`,
    [Role.PM, Role.DEV, MessageStatus.Unread, MessageStatus.Deferred, MessageStatus.Dispatching]
  );
  const countByRole = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const counts = countByRole.get(row.to_role) ?? {};
    counts[row.status] = row.cnt;
    countByRole.set(row.to_role, counts);
  }

  return AGENT_QUEUE_ROLES.map((role) => {
    const counts = countByRole.get(role) ?? {};
    return {
      role,
      unread: counts[MessageStatus.Unread] ?? 0,
      deferred: counts[MessageStatus.Deferred] ?? 0,
      dispatching: counts[MessageStatus.Dispatching] ?? 0,
    };
  });
}

function collectDispatchingMessages(
  now: Date,
  hasTraceColumn: boolean
): SchedulerExplanationSnapshot['dispatchingMessages'] {
  const traceSelect = hasTraceColumn ? 'm.trace_id' : 'NULL as trace_id';
  const rows = rawQuery<DispatchingMessageRow>(
    `SELECT m.id, m.to_role, m.from_role, m.related_task_id, m.related_iteration_id,
            m.created_at, t.title as task_title, ${traceSelect}
     FROM messages m
     LEFT JOIN tasks t ON t.id = m.related_task_id
     WHERE m.status = ?
     ORDER BY m.created_at ASC
     LIMIT 5`,
    [MessageStatus.Dispatching]
  );

  return rows.map((row) => ({
    id: row.id,
    toRole: row.to_role,
    fromRole: row.from_role,
    relatedTaskId: row.related_task_id,
    taskTitle: row.task_title,
    relatedIterationId: row.related_iteration_id,
    traceId: row.trace_id ?? null,
    ageMinutes: diffMinutes(now, row.created_at),
  }));
}

function collectBlockedTasks(): SchedulerExplanationSnapshot['blockedTasks'] {
  const rows = rawQuery<BlockedTaskRow>(
    `SELECT DISTINCT t.id, t.title, t.status, t.iteration_id
     FROM tasks t
     LEFT JOIN task_dependencies td ON td.task_id = t.id
     LEFT JOIN tasks dep ON dep.id = td.depends_on
     WHERE t.status = ?
        OR (td.depends_on IS NOT NULL AND dep.status IS NOT NULL AND dep.status != ?)
     ORDER BY t.updated_at DESC, t.id ASC
     LIMIT 5`,
    [TaskStatus.Blocked, TaskStatus.Done]
  );

  if (rows.length === 0) return [];

  const dependencies = rawQuery<DependencyRow>(
    `SELECT td.task_id, dep.id as dep_id, dep.title as dep_title, dep.status as dep_status
     FROM task_dependencies td
     JOIN tasks dep ON dep.id = td.depends_on
     WHERE dep.status != ?
     ORDER BY dep.id ASC`,
    [TaskStatus.Done]
  );
  const depsByTask = new Map<number, DependencyRow[]>();
  for (const dep of dependencies) {
    const list = depsByTask.get(dep.task_id) ?? [];
    list.push(dep);
    depsByTask.set(dep.task_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    iterationId: row.iteration_id,
    incompleteDependencies: (depsByTask.get(row.id) ?? []).map((dep) => ({
      id: dep.dep_id,
      title: dep.dep_title,
      status: dep.dep_status,
    })),
  }));
}

function collectAutoTriggerCandidates(): string[] {
  const rows = rawQuery<ActiveIterationStatsRow>(
    `SELECT i.id,
            COUNT(t.id) as total,
            SUM(CASE WHEN t.status = ? THEN 1 ELSE 0 END) as done,
            SUM(CASE WHEN t.status = ? THEN 1 ELSE 0 END) as rejected,
            SUM(CASE WHEN t.id IS NOT NULL AND t.status NOT IN (?, ?) THEN 1 ELSE 0 END) as remaining
     FROM iterations i
     LEFT JOIN tasks t ON t.iteration_id = i.id AND t.status != ?
     WHERE i.status = 'active'
     GROUP BY i.id
     ORDER BY i.created_at DESC
     LIMIT 5`,
    [
      TaskStatus.Done,
      TaskStatus.Rejected,
      TaskStatus.Done,
      TaskStatus.Cancelled,
      TaskStatus.Cancelled,
    ]
  );

  const candidates: string[] = [];
  for (const row of rows) {
    if (row.total <= 0) continue;
    if (row.remaining <= 1) {
      candidates.push(
        `迭代 #${row.id} 接近 all done: done ${row.done}/${row.total}, remaining ${row.remaining}`
      );
    }
    if (row.total >= 3) {
      const rate = row.rejected / row.total;
      if (rate >= 0.24) {
        candidates.push(
          `迭代 #${row.id} 打回率接近阈值: ${Math.round(rate * 100)}% (${row.rejected}/${row.total})`
        );
      }
    }
  }
  return candidates.slice(0, 5);
}

function collectRecentEvents(options: {
  logsHasTrace: boolean;
  roleOutputsHasTrace: boolean;
}): SchedulerExplanationSnapshot['recentEvents'] {
  const logTrace = options.logsHasTrace ? 'trace_id' : 'NULL as trace_id';
  const outputTrace = options.roleOutputsHasTrace ? 'trace_id' : 'NULL as trace_id';
  return rawQuery<RecentEventRow>(
    `SELECT * FROM (
       SELECT action as kind, role, content, related_task_id, ${logTrace}, created_at
       FROM logs
       WHERE action IN ('dispatch', 'dispatch_failed', 'auto_trigger', 'trigger_fired')
       UNION ALL
       SELECT 'dispatch' as kind, role, input_summary as content, related_task_id, ${outputTrace}, created_at
       FROM role_outputs
     )
     ORDER BY created_at DESC
     LIMIT 5`
  ).map((row) => ({
    kind: row.kind,
    role: row.role,
    content: row.content,
    relatedTaskId: row.related_task_id,
    traceId: row.trace_id ?? null,
    createdAt: row.created_at,
  }));
}

function getColumnNames(table: string): Set<string> {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function readPmCooldownMs(): number {
  try {
    return loadConfig().engine?.pmCooldownMs ?? DEFAULT_PM_COOLDOWN_MS;
  } catch {
    return DEFAULT_PM_COOLDOWN_MS;
  }
}

function parseInteger(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function diffMinutes(now: Date, dateStr: string): number {
  const then = new Date(dateStr);
  const diffMs = now.getTime() - then.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return Math.floor(diffMs / 60000);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return remainSeconds > 0 ? `${minutes}m ${remainSeconds}s` : `${minutes}m`;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function summarize(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 80) return singleLine;
  return `${singleLine.slice(0, 77)}...`;
}
