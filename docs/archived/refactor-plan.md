# win-agent 重构计划

> 基于 2026-04-12 架构审查结果，按优先级分阶段执行。

---

## P0：模块拆分与职责内聚（必须先做）

### P0-0 拆分过大文件，明确单一职责

**问题**：三个文件职责混乱、函数过长，是后续所有重构的障碍。

| 文件 | 行数 | 实际承担的职责 |
|------|------|---------------|
| `session-manager.ts` | 586 | 会话创建、记忆写入（两处重复逻辑）、上下文轮转、持久化、恢复中断、清理过期会话 |
| `dispatcher.ts` | 417 | 消息过滤、依赖检查、知识注入、任务上下文组装、Prompt 构建、输出持久化、日志写入 |
| `opencode-server.ts` | 367 | 进程启动、健康检查、配置构建、进程树清理、客户端生命周期 |

**`dispatchToRole` 函数本身就 130 行**，一个函数做了 7 件事（过滤→依赖检查→获取 session→知识注入→构建 Prompt→调用 LLM→持久化），完全违反单一职责。

**`writeAllMemories` 与 `rotateSession` 中的记忆写入逻辑几乎完全重复**（各自约 40 行），说明"写记忆"本该是独立模块。

---

#### 拆分方案

**`session-manager.ts` → 3 个模块**

```
engine/session-manager.ts       # 只保留会话创建/获取/释放（~150 行）
engine/memory-writer.ts         # 记忆写入逻辑（去重两处重复，~80 行）
engine/session-store.ts         # sessions.json 持久化与恢复（~100 行）
```

- `rotateSession` 和 `writeAllMemories` 均调用 `memory-writer.ts` 中的 `writeMemory(role, sessionId)`，消除重复
- `persistSessionIds` / `loadSessionIds` / `checkAndResumeInterrupted` 移入 `session-store.ts`

**`dispatcher.ts` → 3 个模块**

```
engine/dispatcher.ts            # 只保留主流程编排（~80 行）
engine/prompt-builder.ts        # Prompt 组装：知识注入 + 任务上下文 + 消息格式化（~150 行）
engine/dispatch-filter.ts       # 消息过滤 + 依赖检查（~80 行）
```

- `dispatchToRole` 缩减为：调用 filter → 获取 session → 调用 prompt-builder → 调用 LLM → 持久化，每步一行
- `buildDispatchPrompt` / `getTaskContext` 移入 `prompt-builder.ts`
- 过滤循环（当前 dispatcher.ts:114-146）移入 `dispatch-filter.ts`

**`opencode-server.ts` → 2 个模块**

```
engine/opencode-server.ts       # 进程生命周期（启动/停止/健康检查，~200 行）
engine/opencode-config.ts       # 配置构建逻辑（从 win-agent config 映射到 opencode config，~100 行）
```

**改动点**：
- 创建以上 5 个新文件，移动代码（不改逻辑）
- 更新 `scheduler.ts` 和 `engine/index.ts` 的 import 路径
- 删除 `memory-writer` 中的重复逻辑，保留一份

**验收标准**：
- [ ] 无单个文件超过 250 行
- [ ] 无单个函数超过 50 行（`dispatchToRole` 重点关注）
- [ ] `rotateSession` 和 `writeAllMemories` 共用同一个 `writeMemory` 函数，无重复代码
- [ ] 拆分后行为与拆分前完全一致（依赖 P0-2 的测试验证）

---

## P0：数据一致性与测试基础（必须先做）

### P0-1 数据库事务支持

**问题**：多步数据库操作无原子性，引擎崩溃会产生脏数据。

**典型场景**：
- dispatcher：消息标记已读 + 写入 role_outputs（两步分离）
- 任务状态流转：tasks + task_events + messages 三表联动
- 依赖解除：恢复任务状态 + 发送通知消息

**方案**：在 `db/repository.ts` 中封装 `withTransaction(fn)` 工具函数，利用 `better-sqlite3` 的同步 `.transaction()` API。

```typescript
// db/repository.ts 新增
export function withTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
```

**改动点**：
- `db/repository.ts`：新增 `withTransaction`
- `engine/dispatcher.ts`：消息状态更新 + 输出持久化合并为一个事务
- `engine/dependency-checker.ts`：任务状态恢复 + 消息发送合并为一个事务
- `engine/auto-trigger.ts`：迭代状态更新 + 通知消息合并为一个事务
- `engine/iteration-checker.ts`：清理操作包裹在事务中

**验收标准**：
- [ ] `withTransaction` 函数存在且有单元测试
- [ ] dispatcher 的消息标记+输出持久化在同一事务内
- [ ] 任意步骤抛出异常时，整体回滚，数据库状态一致

---

### P0-2 补充核心模块单元测试

**问题**：零测试覆盖，重构无安全网。

**测试框架**：使用 `vitest`（与 TypeScript 项目集成最佳，支持 ESM）。

**优先覆盖模块**（按风险排序）：

#### `engine/dependency-checker.ts`
- 任务有未满足依赖时，状态变为 `blocked`
- 依赖全部完成后，状态恢复 `pre_suspend_status`
- `pre_suspend_status` 为空时的降级处理
- 发送解除阻塞通知消息

#### `engine/auto-trigger.ts`
- 脚手架完成触发（greenfield 模式）
- 所有任务完成触发迭代结束
- 拒绝率超过 30% 触发（≥3 个任务时）
- 拒绝率不足 30% 不触发
- 触发不重复（幂等性）

#### `engine/memory-rotator.ts`
- input token 超过阈值（80%）触发轮转
- output token 骤降超过 30% 触发焦虑检测
- 两次输出历史不足时不触发焦虑
- 轮转后 outputHistory 重置

#### `db/repository.ts`
- select / insert / update / delete 基本操作
- orderBy 白名单校验（SQL 注入防护）
- `withTransaction` 成功提交
- `withTransaction` 异常回滚

**测试数据库策略**：使用 `:memory:` SQLite 数据库，每个测试用例独立初始化 schema。

**改动点**：
- 新增 `vitest.config.ts`
- 新增 `src/**/__tests__/` 目录结构
- `package.json` 新增 `"test": "vitest run"` 脚本

**验收标准**：
- [ ] 以上 4 个模块核心逻辑有测试覆盖
- [ ] `npm test` 可一键运行
- [ ] CI 中测试通过是合并前提

---

## P1：架构解耦与状态管理

### P1-1 解耦调度器：引入内部事件总线

**问题**：`scheduler.ts` 直接调用 5 个编排模块，是"上帝模块"，任何模块改动都波及调度器。

**方案**：引入轻量级内部事件总线（Node.js 内置 `EventEmitter`，无需额外依赖），调度器只负责触发事件，各模块自行订阅。

```typescript
// engine/event-bus.ts（新增）
import { EventEmitter } from 'events';
export const engineBus = new EventEmitter();

// 事件清单
export const EngineEvents = {
  DISPATCH_COMPLETE: 'dispatch:complete',   // { role, tokens, messageIds }
  TASK_STATUS_CHANGED: 'task:statusChanged', // { taskId, from, to }
  ITERATION_COMPLETED: 'iteration:completed', // { iterationId }
} as const;
```

**调度器变化**：
```typescript
// 改动前（scheduler.ts）
await checkAutoTriggers(db, workspaceDir);
await checkIterationReview(db, workspaceDir);
await checkDependencies(db);

// 改动后
engineBus.emit(EngineEvents.DISPATCH_COMPLETE, { role, tokens });
// auto-trigger、iteration-checker、dependency-checker 各自监听事件
```

**改动点**：
- 新增 `engine/event-bus.ts`
- `engine/scheduler.ts`：移除对 auto-trigger、iteration-checker、dependency-checker 的直接调用，改为 emit 事件
- `engine/auto-trigger.ts`：改为订阅 `DISPATCH_COMPLETE` 事件
- `engine/iteration-checker.ts`：改为订阅 `ITERATION_COMPLETED` 事件
- `engine/dependency-checker.ts`：改为订阅 `TASK_STATUS_CHANGED` 事件

**验收标准**：
- [ ] scheduler.ts 不再 import auto-trigger、iteration-checker、dependency-checker
- [ ] 各模块通过事件总线解耦
- [ ] 新增事件总线的单元测试

---

### P1-2 显式状态机：消息与任务状态流转

**问题**：消息状态（`unread → deferred → read`）、任务状态（`pending_dev → blocked → pending_dev`）流转逻辑散落在多个文件中，无法一眼看清完整流转图。

**方案**：在 `db/types.ts` 中定义状态机转换表，所有状态变更通过统一入口 `transitionTaskStatus()` / `transitionMessageStatus()` 执行，非法转换抛出异常。

```typescript
// db/state-machine.ts（新增）
const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending_pm:  ['in_review', 'cancelled'],
  pending_dev: ['in_dev', 'blocked', 'cancelled'],
  in_dev:      ['pending_review', 'rejected', 'cancelled'],
  blocked:     ['pending_dev'],
  in_review:   ['done', 'rejected'],
  rejected:    ['pending_dev', 'cancelled'],
  done:        [],
  cancelled:   [],
};

export function transitionTaskStatus(
  current: TaskStatus,
  next: TaskStatus,
  taskId: number,
): void {
  if (!TASK_TRANSITIONS[current]?.includes(next)) {
    throw new Error(`非法任务状态转换: ${current} → ${next} (task #${taskId})`);
  }
  // 执行实际数据库更新 + 写入 task_events
}
```

**改动点**：
- 新增 `db/state-machine.ts`
- `engine/dependency-checker.ts`：用 `transitionTaskStatus` 替换直接 update
- `engine/auto-trigger.ts`：用 `transitionTaskStatus` 替换直接 update
- `engine/dispatcher.ts`：用 `transitionMessageStatus` 替换直接 update
- 为状态机转换表编写单元测试（覆盖合法/非法转换）

**验收标准**：
- [ ] 所有任务状态变更通过 `transitionTaskStatus` 执行
- [ ] 非法转换在测试中可被捕获
- [ ] 完整状态流转图在文件顶部注释中有说明

---

### P1-3 持久化引擎运行时状态

**问题**：`outputHistory`、`lastDispatchedRole`、`pmLastDispatchEnd` 仅存在内存中，引擎重启后丢失，导致公平性和焦虑检测失效。

**方案**：将这三项状态写入 `project_config` 表（已有的 KV 存储），以 key 区分：

| Key | Value | 更新时机 |
|-----|-------|---------|
| `engine.lastDispatchedRole` | `'PM' \| 'DEV'` | 每次 dispatch 后 |
| `engine.pmLastDispatchEnd` | Unix 时间戳（ms） | PM dispatch 完成后 |
| `engine.outputHistory.PM` | JSON 序列化的 token 数组 | 每次 PM dispatch 后 |
| `engine.outputHistory.DEV` | JSON 序列化的 token 数组 | 每次 DEV dispatch 后 |

**改动点**：
- `engine/scheduler.ts`：启动时从 `project_config` 恢复 `lastDispatchedRole` 和 `pmLastDispatchEnd`
- `engine/memory-rotator.ts`：启动时从 `project_config` 恢复 `outputHistory`；每次更新后写回
- 写入操作包裹在非阻塞的 `try/catch` 中（状态持久化失败不应阻塞调度）

**验收标准**：
- [ ] 引擎重启后 `lastDispatchedRole` 恢复正确
- [ ] 引擎重启后 `outputHistory` 继续积累，不归零
- [ ] PM 冷却时间在重启后按剩余时间继续计算

---

## P2：可观测性与配置化

### P2-1 结构化日志

**问题**：当前日志为自由文本，生产排查只能 grep，无法关联跨 dispatch 的操作链。

**方案**：引入 `pino`（高性能 JSON logger，与项目技术栈兼容），每个 dispatch 生成 `traceId`，贯穿整个操作链。

```typescript
// utils/logger.ts（新增）
import pino from 'pino';
export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// 使用示例（dispatcher.ts）
const log = logger.child({ traceId, role, messageId });
log.info({ tokens: result.tokens }, 'dispatch complete');
log.warn({ error: e.message }, 'knowledge injection failed');
```

**改动点**：
- 新增 `utils/logger.ts`
- `engine/dispatcher.ts`：替换 `console.log` 为结构化日志，关键路径加 warn/error
- `engine/scheduler.ts`：dispatch 开始/结束记录结构化日志
- `engine/memory-rotator.ts`：轮转事件记录结构化日志
- `package.json`：新增 `pino` 依赖

**验收标准**：
- [ ] 每个 dispatch 有 traceId
- [ ] 知识注入失败、输出持久化失败输出 warn 而非静默
- [ ] 日志可被 `pino-pretty` 格式化为人类可读格式（开发环境）

---

### P2-2 配置化魔法数字

**问题**：0.8、0.3、30%、1000ms 等阈值硬编码在代码中，调优需改代码。

**方案**：将所有阈值迁移到 `.win-agent/config.json` 的 `engine` 字段，并在 `config/index.ts` 中定义带默认值的类型。

```typescript
// config/index.ts 新增 EngineConfig 类型
interface EngineConfig {
  tickIntervalMs: number;          // 默认 1000
  pmCooldownMs: number;            // 默认 3000
  contextRotationThreshold: number; // 默认 0.8
  outputAnxietyThreshold: number;   // 默认 0.3
  rejectionRateThreshold: number;   // 默认 0.3
  minTasksForRejectionStats: number; // 默认 3
  memoryExpiryDays: number;         // 默认 90
  dispatchTimeoutMs: number;        // 默认 3600000
}
```

**改动点**：
- `config/index.ts`：新增 `EngineConfig` 接口，`loadConfig` 返回含默认值的完整配置
- `engine/scheduler.ts`：从 config 读取 `tickIntervalMs`、`pmCooldownMs`
- `engine/memory-rotator.ts`：从 config 读取 `contextRotationThreshold`、`outputAnxietyThreshold`
- `engine/auto-trigger.ts`：从 config 读取 `rejectionRateThreshold`、`minTasksForRejectionStats`
- `engine/iteration-checker.ts`：从 config 读取 `memoryExpiryDays`
- `engine/retry.ts`：从 config 读取 `dispatchTimeoutMs`
- 文档：在 README 中说明各配置项含义与默认值

**验收标准**：
- [ ] 所有魔法数字从 config 读取
- [ ] 修改 config.json 后重启引擎生效
- [ ] 配置项有默认值，缺省时不报错

---

## P3：完整性补强

### P3-1 传递依赖检查

**问题**：`dependency-checker.ts` 只检查直接依赖，A→B→C 场景中 B 被阻塞时 A 不会自动阻塞。

**方案**：在 `dependency-checker.ts` 中改用递归 CTE 查询获取传递依赖：

```sql
WITH RECURSIVE transitive_deps AS (
  SELECT depends_on FROM task_dependencies WHERE task_id = ?
  UNION ALL
  SELECT td.depends_on FROM task_dependencies td
  JOIN transitive_deps rec ON rec.depends_on = td.task_id
)
SELECT t.id, t.status FROM tasks t
WHERE t.id IN (SELECT depends_on FROM transitive_deps)
  AND t.status != 'done'
```

**改动点**：
- `engine/dependency-checker.ts`：替换现有依赖查询为递归 CTE
- 新增单元测试覆盖 A→B→C 三层传递依赖场景

**验收标准**：
- [ ] A→B→C 场景：C 未完成时，A 被正确阻塞
- [ ] C 完成后，B 自动解除阻塞；B 完成后，A 自动解除阻塞

---

### P3-2 嵌入向量缓存

**问题**：同一文本在单次调度周期内可能被多次嵌入，浪费计算资源（本地模型）或 API 费用（OpenAI）。

**方案**：在 `embedding/index.ts` 中添加 LRU 内存缓存，以文本内容哈希为 key，生命周期为单次引擎运行。

```typescript
// embedding/index.ts
import { LRUCache } from 'lru-cache';
const cache = new LRUCache<string, number[]>({ max: 500 });

export async function embed(text: string): Promise<number[]> {
  const key = hashText(text);
  if (cache.has(key)) return cache.get(key)!;
  const vector = await provider.embed(text);
  cache.set(key, vector);
  return vector;
}
```

**改动点**：
- `embedding/index.ts`：新增 LRU 缓存层
- `package.json`：新增 `lru-cache` 依赖（已被大量项目使用，稳定）

**验收标准**：
- [ ] 同一文本在同一次运行中只调用一次底层 embed
- [ ] 缓存命中时无 I/O 或 API 调用

---

### P3-3 OpenCode Server 运行期健康检查

**问题**：引擎运行期间 OpenCode server 失联后，调度器继续尝试 dispatch，每次超时后才失败，5 分钟才发现问题。

**方案**：在调度器主循环中每 30 秒执行一次轻量 healthcheck，失败超过 3 次后暂停 dispatch 并记录告警日志。

**改动点**：
- `engine/opencode-server.ts`：导出 `checkHealth()` 函数（已有，暴露即可）
- `engine/scheduler.ts`：新增健康检查计数器，连续失败 3 次时跳过 dispatch 并输出 error 日志

**验收标准**：
- [ ] OpenCode server 不可达时，调度器在 90 秒内停止尝试 dispatch
- [ ] 健康检查恢复后，调度器自动恢复

---

## 执行顺序总结

```
P0-0 模块拆分（先拆，后续改动才有清晰边界）
    ↓
P0-1 事务支持
    ↓
P0-2 单元测试（拆分后的小模块更易测试）
    ↓
P1-2 状态机（依赖 P0-2 的测试基础）
    ↓
P1-1 事件总线解耦（依赖 P1-2 的稳定状态流转）
    ↓
P1-3 运行时状态持久化
    ↓
P2-1 结构化日志  ←→  P2-2 配置化（可并行）
    ↓
P3-1 传递依赖  ←→  P3-2 嵌入缓存  ←→  P3-3 健康检查（可并行）
```

---

## 验收总览

| 阶段 | 关键指标 |
|------|---------|
| P0 | 事务覆盖率：dispatcher/dependency-checker/auto-trigger；测试覆盖率：4 个核心模块 |
| P1 | scheduler.ts 不直接 import 编排模块；所有状态变更通过状态机入口；重启后状态恢复 |
| P2 | 关键路径有 traceId；所有魔法数字可配置 |
| P3 | 传递依赖测试通过；嵌入缓存命中；健康检查 90 秒内响应 |
