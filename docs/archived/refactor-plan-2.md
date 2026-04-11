# win-agent 重构计划（第二阶段）

> 基于 2026-04-12 代码审查结果，覆盖原 refactor-plan.md 中尚未落地的所有改动。
> 已完成项：P0-0 大部分文件拆分、P0-2 单元测试框架与 4 个核心测试文件。

---

## P0-0 收尾：消除剩余超标文件

**现状**：以下文件仍超过 250 行限制，或核心函数超过 50 行。

| 文件 | 当前行数 | 问题 |
|------|---------|------|
| `engine/session-manager.ts` | 326 | `waitForSessionsReady`（约 30 行）、`cleanupOldSessions`（约 30 行）、`createRoleSession`（约 48 行）可进一步内聚 |
| `engine/scheduler.ts` | 325 | `schedulerTick` 函数约 175 行，严重违反单函数 50 行限制 |
| `engine/auto-trigger.ts` | 282 | `generateIterationStats` 函数 82 行，`checkAllTasksDone` 约 45 行 |

### 改动点

#### `engine/scheduler.ts`（325 → ≤250 行）

`schedulerTick` 拆分为以下子函数，每个函数 ≤50 行：

```
dispatchUserMessages(client, sessionManager, roleManager, abortController) → Promise<boolean>
  // 处理 user→PM 优先分支（scheduler.ts:169-224）
  // 返回 true 表示已调度，调用方直接 return

dispatchNormalRole(client, sessionManager, roleManager, role, abortController) → Promise<void>
  // 处理单个 role 的正常调度（scheduler.ts:253-318）

promoteDeferredTriggers(roleManager)
  // 提升 deferred 触发消息（scheduler.ts:155-165）
```

`schedulerTick` 本身缩减为：调用 `checkAndUnblockDependencies` → 调用 `promoteDeferredTriggers` → 调用 `dispatchUserMessages`（如已调度则 return）→ 遍历 roleOrder 调用 `dispatchNormalRole` → 调用后置检查。

#### `engine/auto-trigger.ts`（282 → ≤250 行）

将 `generateIterationStats`（auto-trigger.ts:199-282，82 行）提取到独立文件：

```
engine/iteration-stats.ts   # generateIterationStats 函数（~90 行）
```

`auto-trigger.ts` 保留触发逻辑，import `generateIterationStats` from `./iteration-stats.js`。

#### `engine/session-manager.ts`（326 → ≤250 行）

`waitForSessionsReady`（session-manager.ts:97-122）移入 `session-store.ts`，作为独立导出函数：

```typescript
// session-store.ts 新增
export async function waitForSessionsReady(
  client: OpencodeClient,
  activeSessions: Map<string, string>
): Promise<void>
```

`session-manager.ts` 改为 `await waitForSessionsReady(this.client, this.activeSessions)`。

**验收标准**：
- [ ] 所有文件 ≤250 行
- [ ] `schedulerTick` 主体 ≤50 行
- [ ] `generateIterationStats` 已迁移到 `iteration-stats.ts`

---

## P0-1 数据库事务：实际使用 `withTransaction`

**现状**：`db/repository.ts` 已导出 `withTransaction`，但所有引擎模块均未调用，多步数据库操作仍无原子性。

### 改动点

#### `engine/dispatcher.ts`

步骤 5（标记消息已读，dispatcher.ts:132-134）+ 步骤 6（插入 role_outputs，dispatcher.ts:153-167）+ 插入 logs（dispatcher.ts:169-175）合并为一个事务：

```typescript
// 替换现有分散写入
import { withTransaction } from '../db/repository.js';

withTransaction(() => {
  for (const msg of messages) {
    update('messages', { id: msg.id }, { status: MessageStatus.Read });
  }
  if (outputText.length > 0) {
    dbInsert('role_outputs', { ... });
  }
  dbInsert('logs', { ... });
});
```

#### `engine/dependency-checker.ts`：`checkAndUnblockDependencies`

将 `update tasks` + `insert task_events` + 两次 `insert messages`（dependency-checker.ts:45-79）包裹在 `withTransaction` 中：

```typescript
withTransaction(() => {
  update('tasks', { id: task.id }, { status: restoreStatus, pre_suspend_status: null });
  insert('task_events', { ... });
  insert('messages', { /* PM 通知 */ });
  if (assignedRole && assignedRole !== 'PM' && existing.length === 0) {
    insert('messages', { /* assigned role 通知 */ });
  }
});
```

注意：`existing` 的查询需在事务外执行（只读），事务内只做写操作。

#### `engine/auto-trigger.ts`：`checkAllTasksDone`

将 `rawRun`（更新 iteration status）+ `insert messages` + `insert logs`（auto-trigger.ts:116-138）包裹在 `withTransaction` 中。

#### `engine/dependency-checker.ts`：`checkAndBlockUnmetDependencies`

将 `update tasks` + `insert task_events`（dependency-checker.ts:15-24）包裹在 `withTransaction` 中。

**验收标准**：
- [ ] dispatcher 的消息标记 + 输出持久化 + 日志在同一事务内
- [ ] dependency-checker 的任务状态更新 + 事件记录 + 通知消息在同一事务内
- [ ] auto-trigger 的迭代状态更新 + 通知消息在同一事务内
- [ ] 对应测试文件（`src/db/__tests__/repository.test.ts`）补充 `withTransaction` 回滚测试用例

---

## P1-1 事件总线：解耦调度器

**现状**：`engine/scheduler.ts` 在 dispatch 完成后直接调用 `checkAutoTriggers()`（第 221、323 行）和 `checkIterationReview(sessionManager)`（第 222、324 行），并在每 tick 开始时调用 `checkAndUnblockDependencies()`（第 152 行）。这三个直接 import 使 scheduler 成为"上帝模块"。

### 改动点

**新增 `engine/event-bus.ts`**：

```typescript
import { EventEmitter } from 'node:events';

export const engineBus = new EventEmitter();

export const EngineEvents = {
  /** 一次 dispatch 完成后触发。payload: { role, inputTokens, outputTokens } */
  DISPATCH_COMPLETE: 'dispatch:complete',
  /** 任务状态变化时触发。payload: { taskId, from, to } */
  TASK_STATUS_CHANGED: 'task:statusChanged',
  /** 迭代标记为 completed 时触发。payload: { iterationId } */
  ITERATION_COMPLETED: 'iteration:completed',
} as const;
```

**`engine/scheduler.ts`**：
- 移除对 `checkAutoTriggers`、`checkIterationReview`、`checkAndUnblockDependencies` 的直接调用
- dispatch 完成后改为 `engineBus.emit(EngineEvents.DISPATCH_COMPLETE, { role, inputTokens, outputTokens })`
- tick 开始时发出 `EngineEvents.TASK_STATUS_CHANGED`（任务状态变化事件由 dependency-checker 内部 emit，scheduler 无需关心）
- 在 `startSchedulerLoop` 中保留 `checkAndUnblockDependencies` 的调用，或改为通过事件触发

**`engine/auto-trigger.ts`**：
- 在模块初始化时订阅 `DISPATCH_COMPLETE`：
  ```typescript
  engineBus.on(EngineEvents.DISPATCH_COMPLETE, () => checkAutoTriggers());
  ```
- 移除从 scheduler 直接调用的入口

**`engine/iteration-checker.ts`**：
- 在模块初始化时订阅 `DISPATCH_COMPLETE`：
  ```typescript
  engineBus.on(EngineEvents.DISPATCH_COMPLETE, ({ role }) => {
    if (role === 'PM') checkIterationReview(sessionManager);
  });
  ```
- `checkIterationReview` 的 `sessionManager` 参数需通过 `init(sessionManager)` 或 module-level 变量注入

**`engine/dependency-checker.ts`**：
- 任务状态恢复后，emit `TASK_STATUS_CHANGED`（供未来扩展监听）
- scheduler 通过定时调用（保留 tick 内一次 `checkAndUnblockDependencies` 即可）

**验收标准**：
- [ ] `engine/event-bus.ts` 存在，导出 `engineBus` 和 `EngineEvents`
- [ ] `scheduler.ts` 不再直接 import `auto-trigger`、`iteration-checker`
- [ ] `checkAutoTriggers` 和 `checkIterationReview` 通过事件总线触发

---

## P1-2 状态机：统一任务状态流转

**现状**：`dependency-checker.ts` 直接调用 `update('tasks', ...)` 改变任务状态，`auto-trigger.ts` 用 `rawRun("UPDATE iterations ...")` 改变迭代状态，无合法性校验。

### 改动点

**新增 `db/state-machine.ts`**：

```typescript
import { update, insert } from './repository.js';
import type { TaskStatus } from './types.js';

/**
 * 合法的任务状态流转图
 *
 * pending_pm  → in_review | cancelled
 * pending_dev → in_dev | blocked | cancelled
 * in_dev      → pending_review | rejected | cancelled
 * blocked     → pending_dev
 * in_review   → done | rejected
 * rejected    → pending_dev | cancelled
 * done        → (终态)
 * cancelled   → (终态)
 */
const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending_pm:     ['in_review', 'cancelled'],
  pending_dev:    ['in_dev', 'blocked', 'cancelled'],
  in_dev:         ['pending_review', 'rejected', 'cancelled'],
  pending_review: ['in_review', 'rejected', 'cancelled'],
  blocked:        ['pending_dev'],
  in_review:      ['done', 'rejected'],
  rejected:       ['pending_dev', 'cancelled'],
  done:           [],
  cancelled:      [],
};

export function transitionTaskStatus(
  taskId: number,
  from: TaskStatus,
  to: TaskStatus,
  changedBy: string,
  reason: string
): void {
  const allowed = TASK_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new Error(`非法任务状态转换: ${from} → ${to} (task #${taskId})`);
  }
  update('tasks', { id: taskId }, { status: to, pre_suspend_status: to === 'blocked' ? from : null });
  insert('task_events', { task_id: taskId, from_status: from, to_status: to, changed_by: changedBy, reason });
}
```

**`engine/dependency-checker.ts`**：
- `checkAndBlockUnmetDependencies`：将 `update('tasks', ...)` + `insert('task_events', ...)` 替换为 `transitionTaskStatus(taskId, currentStatus as TaskStatus, 'blocked', 'system', reason)`
- `checkAndUnblockDependencies`：将对应写入替换为 `transitionTaskStatus(task.id, 'blocked', restoreStatus as TaskStatus, 'system', '依赖已全部完成，自动解除阻塞')`

**补充测试**：在 `src/db/__tests__/` 新增 `state-machine.test.ts`，覆盖合法转换、非法转换抛出异常。

**验收标准**：
- [ ] `db/state-machine.ts` 存在，导出 `transitionTaskStatus` 和 `TASK_TRANSITIONS`
- [ ] `dependency-checker.ts` 不再直接 `update('tasks', ...)`（改状态的部分）
- [ ] 非法转换在测试中可被捕获

---

## P1-3 运行时状态持久化

**现状**：`lastDispatchedRole`（scheduler.ts:75）、`pmLastDispatchEnd`（scheduler.ts:69）、`outputHistory`（memory-rotator.ts:49）均为内存变量，引擎重启后清零，导致轮转公平性和焦虑检测失效。

### 改动点

**`engine/scheduler.ts`**：

在 `startSchedulerLoop` 启动时，从 `project_config` 表恢复状态：

```typescript
// 启动时恢复
import { select, insert, update } from '../db/repository.js';

function loadSchedulerState(): void {
  const rows = select<{ key: string; value: string }>('project_config', {});
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (map['engine.lastDispatchedRole']) {
    lastDispatchedRole = map['engine.lastDispatchedRole'];
  }
  if (map['engine.pmLastDispatchEnd']) {
    pmLastDispatchEnd = parseInt(map['engine.pmLastDispatchEnd'], 10);
  }
}

function saveSchedulerState(): void {
  try {
    upsertProjectConfig('engine.lastDispatchedRole', lastDispatchedRole ?? '');
    upsertProjectConfig('engine.pmLastDispatchEnd', String(pmLastDispatchEnd));
  } catch { /* 非阻塞 */ }
}
```

`upsertProjectConfig` 封装在 `db/repository.ts` 或 `db/project-config.ts` 中（INSERT OR REPLACE）。

在 `schedulerTick` 的 finally 块中（scheduler.ts:308-315）调用 `saveSchedulerState()`。

**`engine/memory-rotator.ts`**：

在 `checkAndRotate` 调用 `recordOutputTokens` 后，将 `outputHistory` 持久化：

```typescript
function saveOutputHistory(role: string): void {
  try {
    const history = outputHistory.get(role) ?? [];
    upsertProjectConfig(`engine.outputHistory.${role}`, JSON.stringify(history));
  } catch { /* 非阻塞 */ }
}

function loadOutputHistory(): void {
  try {
    // 启动时调用，从 project_config 恢复所有角色的 outputHistory
    const rows = select<{ key: string; value: string }>('project_config', {});
    for (const row of rows) {
      if (row.key.startsWith('engine.outputHistory.')) {
        const role = row.key.replace('engine.outputHistory.', '');
        outputHistory.set(role, JSON.parse(row.value));
      }
    }
  } catch { /* 非阻塞 */ }
}
```

导出 `loadOutputHistory`，在引擎启动时（`engine/index.ts` 或 `startSchedulerLoop` 前）调用。

**验收标准**：
- [ ] 引擎重启后 `lastDispatchedRole` 正确恢复，轮转公平性不清零
- [ ] 引擎重启后 `outputHistory` 继续积累，焦虑检测不失效
- [ ] PM 冷却时间在重启后按剩余时间继续计算（`pmLastDispatchEnd` 恢复）
- [ ] 持久化失败不影响正常调度（try/catch 包裹）

---

## P2-1 结构化日志

**现状**：全代码库使用 `console.log`/`console.error`，无 traceId，生产排查只能 grep。

### 改动点

**`package.json`**：新增依赖 `pino`。

**新增 `src/utils/logger.ts`**：

```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // 开发环境可设置 LOG_LEVEL=debug，配合 pino-pretty 格式化
});
```

**`engine/dispatcher.ts`**：
- 在 `dispatchToRole` 入口生成 `traceId = crypto.randomUUID().slice(0, 8)`
- 创建 `const log = logger.child({ traceId, role })`
- 将 `console.log`（dispatcher.ts:147-150）替换为 `log.info({ inputTokens, outputTokens }, 'dispatch complete')`
- 将知识注入 catch 块（dispatcher.ts:104-106）改为 `log.warn({ error: e }, 'knowledge injection failed')`
- 将输出持久化 catch 块（dispatcher.ts:165-167）改为 `log.warn('output persistence failed')`

**`engine/scheduler.ts`**：
- dispatch 开始时：`logger.info({ role, messageCount: messages.length }, 'dispatch start')`
- dispatch 完成时：`logger.info({ role, inputTokens, outputTokens }, 'dispatch done')`
- 调度器异常（scheduler.ts:109）：`logger.error({ err }, 'scheduler error')`

**`engine/memory-rotator.ts`**：
- 轮转触发时：`logger.info({ role, usagePct, threshold }, 'session rotation triggered')`
- 焦虑检测触发时：`logger.info({ role, outputTokens, avg }, 'context anxiety rotation')`

**验收标准**：
- [ ] 每个 dispatch 有 traceId，贯穿 dispatcher 日志
- [ ] 知识注入失败、输出持久化失败输出 warn 而非静默
- [ ] 不再使用 `console.log`（dispatcher、scheduler、memory-rotator 三个文件）

---

## P2-2 配置化魔法数字（收尾）

**现状**：`contextRotation` 阈值已可配置，但以下魔法数字仍硬编码：

| 位置 | 硬编码值 | 含义 |
|------|---------|------|
| `scheduler.ts:68` | `PM_COOLDOWN_MS = 3000` | PM dispatch 后冷却时间 |
| `scheduler.ts:123` | `sleep(1000)` | 调度循环间隔 |
| `auto-trigger.ts:164` | `stats.total < 3` | 统计打回率的最少任务数 |
| `auto-trigger.ts:166` | `rate <= 0.3` | 打回率告警阈值 |
| `dispatcher.ts:125` | `5 * 60 * 1000` | dispatch 超时时间 |
| `session-manager.ts:98` | `maxWait = 60_000` | session 初始化等待超时 |

### 改动点

**`config/index.ts`**：在 `WinAgentConfig` 中新增 `engine` 字段：

```typescript
export interface EngineConfig {
  /** 调度循环间隔，默认 1000ms */
  tickIntervalMs?: number;
  /** PM dispatch 后冷却时间，默认 3000ms */
  pmCooldownMs?: number;
  /** 触发打回率告警的最少任务数，默认 3 */
  minTasksForRejectionStats?: number;
  /** 打回率告警阈值，默认 0.3（30%） */
  rejectionRateThreshold?: number;
  /** 单次 dispatch 超时时间，默认 300000ms（5 分钟） */
  dispatchTimeoutMs?: number;
  /** session 初始化等待超时，默认 60000ms */
  sessionInitTimeoutMs?: number;
}

export interface WinAgentConfig {
  // ...已有字段...
  engine?: EngineConfig;
}
```

**各模块**：调用 `loadConfig().engine ?? {}` 读取配置，使用 `?? 默认值` 兜底，缺省不报错。

**验收标准**：
- [ ] `WinAgentConfig` 有 `engine` 字段，含上表所有项
- [ ] 上表 6 处硬编码均改为从 config 读取
- [ ] 缺省 config 时，行为与现有完全一致（默认值相同）

---

## P3-1 传递依赖检查

**现状**：`dependency-checker.ts:8-13`（`checkAndBlockUnmetDependencies`）和 `dependency-checker.ts:36-40`（`checkAndUnblockDependencies`）均使用简单 JOIN 查询，只检查直接依赖，A→B→C 场景下 C 未完成时 A 不会被阻塞。

### 改动点

**`engine/dependency-checker.ts`**：

`checkAndBlockUnmetDependencies` 内的查询替换为递归 CTE：

```sql
WITH RECURSIVE transitive_deps AS (
  SELECT depends_on FROM task_dependencies WHERE task_id = ?
  UNION ALL
  SELECT td.depends_on
  FROM task_dependencies td
  JOIN transitive_deps rec ON rec.depends_on = td.task_id
)
SELECT t.id, t.title FROM tasks t
WHERE t.id IN (SELECT depends_on FROM transitive_deps)
  AND t.status != 'done'
```

`checkAndUnblockDependencies` 内的查询同样替换：

```sql
WITH RECURSIVE transitive_deps AS (
  SELECT depends_on FROM task_dependencies WHERE task_id = ?
  UNION ALL
  SELECT td.depends_on
  FROM task_dependencies td
  JOIN transitive_deps rec ON rec.depends_on = td.task_id
)
SELECT 1 FROM tasks t
WHERE t.id IN (SELECT depends_on FROM transitive_deps)
  AND t.status != 'done'
LIMIT 1
```

**补充测试**：在 `src/engine/__tests__/dependency-checker.test.ts` 新增三层传递依赖场景（A→B→C，C 未完成时 A blocked，C 完成后 B 解除，B 完成后 A 解除）。

**验收标准**：
- [ ] 三层传递依赖测试通过
- [ ] 直接依赖测试（原有）不回归

---

## P3-2 嵌入向量 LRU 缓存

**现状**：`embedding/index.ts` 无缓存，同一文本在单次引擎运行中可能多次嵌入。

### 改动点

**`package.json`**：新增依赖 `lru-cache`。

**`embedding/index.ts`**（需先读取文件确认当前结构）：

```typescript
import { LRUCache } from 'lru-cache';
import crypto from 'node:crypto';

// 生命周期：单次引擎运行；max 500 条约 2MB（每条向量 1536 float32）
const embedCache = new LRUCache<string, number[]>({ max: 500 });

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// 在现有 embed 函数入口处加缓存检查
export async function embed(text: string): Promise<number[]> {
  const key = hashText(text);
  const cached = embedCache.get(key);
  if (cached) return cached;
  const vector = await /* 现有调用逻辑 */;
  embedCache.set(key, vector);
  return vector;
}
```

**验收标准**：
- [ ] 同一文本在同一次运行中底层 embed 只调用一次
- [ ] 缓存命中时无网络或本地模型调用

---

## P3-3 OpenCode Server 运行期健康检查

**现状**：`engine/scheduler.ts` 无健康检查机制，OpenCode server 失联后调度器继续尝试 dispatch，每次等待 5 分钟超时后才失败。

### 改动点

**`engine/scheduler.ts`**：

新增健康检查状态变量：

```typescript
let healthFailCount = 0;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_HEALTH_FAILURES = 3;
let lastHealthCheckAt = 0;
```

在 `schedulerTick` 开头（`checkAndUnblockDependencies` 之前）插入：

```typescript
// 每 30 秒执行一次健康检查
if (Date.now() - lastHealthCheckAt > HEALTH_CHECK_INTERVAL_MS) {
  lastHealthCheckAt = Date.now();
  const healthy = await checkHealth(client); // 已有函数，从 opencode-server.ts 导出
  if (!healthy) {
    healthFailCount++;
    logger.error({ healthFailCount }, 'opencode server health check failed');
    if (healthFailCount >= MAX_HEALTH_FAILURES) {
      logger.error('opencode server unreachable, suspending dispatch');
      return; // 跳过本轮调度
    }
  } else {
    if (healthFailCount >= MAX_HEALTH_FAILURES) {
      logger.info('opencode server recovered, resuming dispatch');
    }
    healthFailCount = 0;
  }
}
```

**`engine/opencode-server.ts`**：确认 `checkHealth(client)` 已导出（审查结论：已有，仅需 export）。

**验收标准**：
- [ ] OpenCode server 不可达时，调度器在 90 秒内（3 次 × 30 秒间隔）停止 dispatch
- [ ] 健康检查恢复后，`healthFailCount` 清零，调度自动恢复
- [ ] 健康检查失败输出 error 日志（非 console.error）

---

## 执行顺序

```
P0-0 收尾（拆 schedulerTick、提取 generateIterationStats、移 waitForSessionsReady）
    ↓
P0-1 事务（dispatcher + dependency-checker + auto-trigger 使用 withTransaction）
    ↓
P1-2 状态机（新增 db/state-machine.ts，dependency-checker 切换到 transitionTaskStatus）
    ↓
P1-1 事件总线（新增 event-bus.ts，scheduler 解耦）
    ↓
P1-3 状态持久化（scheduler + memory-rotator 写入/恢复 project_config）
    ↓
P2-2 配置化（EngineConfig 接口 + 6 处硬编码改读 config）
    ↓
P2-1 结构化日志（pino + logger.ts + dispatcher/scheduler/memory-rotator 切换）
    ↓
P3-1 传递依赖  ←→  P3-2 嵌入缓存  ←→  P3-3 健康检查（可并行）
```

---

## 验收总览

| 阶段 | 关键指标 |
|------|---------|
| P0-0 收尾 | 所有文件 ≤250 行；`schedulerTick` ≤50 行 |
| P0-1 | dispatcher/dependency-checker/auto-trigger 的多步写入均在事务内 |
| P1-1 | scheduler.ts 不直接 import auto-trigger、iteration-checker |
| P1-2 | dependency-checker 不再直接 `update('tasks', ...)`（改状态部分）；非法转换有测试覆盖 |
| P1-3 | 重启后 lastDispatchedRole、pmLastDispatchEnd、outputHistory 正确恢复 |
| P2-1 | dispatcher 每次 dispatch 有 traceId；关键失败路径输出 warn/error |
| P2-2 | `WinAgentConfig.engine` 存在；6 处硬编码改为读 config |
| P3-1 | 三层传递依赖测试通过 |
| P3-2 | 同文本单次运行只 embed 一次 |
| P3-3 | 3 次健康检查失败后暂停 dispatch，恢复后自动继续 |
