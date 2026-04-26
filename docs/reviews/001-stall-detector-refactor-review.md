# StallDetector 拆分重构 Code Review

> 评审范围：`develop` 上未提交的改动
>
> - 新增：`dispatch-intent.ts`、`idle-nudger.ts`、`message-scheduler.ts`、`scheduler-maintenance.ts`、`session-watchdog.ts`、`__tests__/message-scheduler.test.ts`
> - 修改：`scheduler.ts`、`scheduler-dispatch.ts`、`pm-idle-monitor.ts`
> - 删除：`stall-detector.ts`

## 1. 改动目标（评审者理解）

把原本 309 行单体的 `StallDetector` 按职责拆分为 4 个模块，并把每 tick 都会跑的"维护类"逻辑统一放到 30s 节流的 `SchedulerMaintenance` 里。

| 旧位置 | 新位置 | 职责 |
| --- | --- | --- |
| `stall-detector.ts` 中 `DispatchIntent` 接口 | `dispatch-intent.ts` | 类型定义 |
| `stall-detector.ts` PM/DEV 闲置提醒 | `idle-nudger.ts` | 写"PM 空闲提醒""DEV pending work 提醒"消息 |
| `stall-detector.ts` 卡住 session 检测 | `session-watchdog.ts` | 通过 `client.session.messages` 检测 stuck，返回 abort intent |
| `stall-detector.ts` 未读消息→intent | `message-scheduler.ts` | `detectMessageDispatchIntents`（dispatch 真正的入口） |
| `scheduler.ts` 内 `handleStuckSessions` + `checkAndUnblockDependencies` 直调 | `scheduler-maintenance.ts` | 30s 节流跑：依赖解锁 + idle 提醒 + stuck 检测 + abort |

## 2. 整体评价

总体方向正确：从"巨石 detector"切到"职责单一 + 集中维护节流"，可读性、性能都有提升。

### 值得肯定的点

1. **职责拆分清晰**：原 `StallDetector` 同时干 4 件事（type 定义 / 未读消息 intent / 卡住 session 检测 / idle 提醒），新结构每个文件 ≤ 220 行，命名也更准确——`StallDetector` 这个名字其实只有"卡住 session"才贴合。
2. **`MAINTENANCE_INTERVAL_MS = 30s` 节流**是实质性优化。原来每 tick（默认 1s）都会跑 `checkAndUnblockDependencies()`（全表扫描）和 `stallDetector.detect()`（含 `rawQuery` 未读消息扫描）。现在只有派发热路径 `detectMessageDispatchIntents` 留在每 tick，其他维护型工作集中调度，CPU/DB 压力显著下降。
3. **派发意图与维护意图解耦**：`schedulerTick` 逻辑变得直白——先维护、若 abort 则跳过、否则按未读消息 intent 派发。原来的 `intents.filter(reason !== 'stuck_session')` 这种 hacky 过滤被消除。
4. **`detectMessageDispatchIntents` 加了 `LIMIT 1`**（`message-scheduler.ts:28`），原 `StallDetector.detect` 的 `rawQuery` 没有 limit，会拉全部未读消息只为判空——一个小改进。
5. **测试同步建立**：`message-scheduler.test.ts` 覆盖 idle / busy / backoff 三种场景，关键路径有保障。

## 3. 需要处理的问题

按重要性从高到低排列。

### 3.1 [功能差异] 丢失了 intent 优先级排序

**问题**：原 `StallDetector.detect` 末尾有：

```ts
intents.sort((a, b) => priority[a.reason] - priority[b.reason]);
```

并且 `unread_messages` 与 `pending_work` 一起返回给 `tryDispatchNormalRole`——`scheduler-dispatch.ts:142 orderRolesForDispatch` 会用全部 intent 来排队角色派发顺序。

新代码（`scheduler.ts:100`）只把 `detectMessageDispatchIntents` 的结果传给 `tryDispatchNormalRole`，**`IdleNudger.detect` 返回的 `pending_work` intent 被丢弃了**（`SchedulerMaintenance.maybeRun` 只关心副作用——发提醒消息——并不返回 intents）。

**后果**：

- 如果 PM 闲置且有 pending_work 但**没有未读消息**，按原设计应该有一个 `pending_work` intent 让 `orderRolesForDispatch` 把 PM 排到前面去派发；现在直接没了。不过实际上 idle reminder 本身会写入一条 `to_role: PM, status: Unread` 的消息，下一 tick `detectMessageDispatchIntents` 自然能捡到，所以**功能等价但绕了一圈**：现 tick 不派发，下 tick 才派发，且每 30s 才会触发一次。
- `INTENT_PRIORITY` 中 `pending_work: 2` 这条路径在新结构里**永远不会被走到**——是死代码。

**建议**：选一个：

- **方案 A（推荐）**：从 `INTENT_PRIORITY` 移除 `pending_work`，并在 `dispatch-intent.ts` 注释里说明 idle reminder 通过"写消息→正常派发"模型工作。`DispatchIntent.reason` 也可以收窄为 `'unread_messages' | 'stuck_session'`，但 `stuck_session` 也只是 watchdog 内部用，可以进一步收窄（见 3.4）。
- **方案 B**：让 `SchedulerMaintenance.maybeRun` 也返回 pending intents 并 merge 进 dispatchIntents，保留旧行为。

### 3.2 [测试缺口] 新模块测试覆盖不足

只新增了 `message-scheduler.test.ts`，但同时新建的三个模块都没有测试：

- `IdleNudger`（最复杂，有写消息和写日志的副作用）
- `SessionWatchdog`（含 timeout race 逻辑）
- `SchedulerMaintenance`（含节流和 abort 流程）

原 `pm-idle-monitor.test.ts` 还在跑老类，并未迁移。`plans/002-proactive-reconciliation-opus47.md:257` 已明确要求"`PmIdleMonitor` 原有单测全部迁移到 StallDetector 并通过"——本次拆分把目标位置改成 `IdleNudger` 即可，但**仍需迁移**。

**建议**：

- 新增 `idle-nudger.test.ts`，迁移并扩展原 `pm-idle-monitor.test.ts` 的 4 种 (DEV busy × idle 时长) 真值表场景。
- 新增 `session-watchdog.test.ts`，覆盖：lastUpdate=0 不算 stuck / 超过阈值算 stuck / `client.session.messages` 超时返回 false / per-session 节流。
- `scheduler-maintenance.test.ts` 可选，至少验证 30s 节流以及 `abortedStuckSession` 的传播。

### 3.3 [清理] `pm-idle-monitor.ts` 该真正删除了

按 `plans/002-...md:243` 的原计划"直接删除"。本次只是把 `@deprecated` 指向从 `StallDetector` 改成 `IdleNudger`，文件目前唯一的存在意义是给 `pm-idle-monitor.test.ts` 用——是技术债。

**建议**：

- 把 `pm-idle-monitor.test.ts` 的内容迁到 `idle-nudger.test.ts`（见 3.2），然后**这次顺手删掉** `pm-idle-monitor.ts` 和原测试文件。
- 顺带：`PmIssue` 类型在 `idle-nudger.ts` 和 `pm-idle-monitor.ts` 完全重复定义，删除老文件后这个重复也消失。

### 3.4 [类型缩窄] `SchedulerMaintenance.abortStuckSessions` 不再校验 `reason`

```ts
private async abortStuckSessions(
  intents: Array<{ role: Role; details?: unknown }>,
  client: OpencodeClient
)
```

旧 `handleStuckSessions` 有 `if (intent.reason !== 'stuck_session') continue;`。新代码因为入参直接来自 `sessionWatchdog.detectStuckSessions`（确实只产生 stuck_session）**当前安全**，但参数类型放宽了，未来谁把别的 intent 也喂进来就会出错。

**建议**：最干净的做法——`SessionWatchdog.detectStuckSessions` 直接返回 `Array<{ role: Role; sessionId: string }>`，根本不用 `DispatchIntent` 这个为派发设计的容器；这里属于过度抽象。同时 `DispatchIntent.reason` 也可以缩成 `'unread_messages'`（配合 3.1 方案 A）。

### 3.5 [简化] `IdleNudger` 内部 `CHECK_INTERVAL_MS` 已被外层吸收

当前节流是三层叠加：

- `SchedulerMaintenance.MAINTENANCE_INTERVAL_MS = 30s`（外层）
- `IdleNudger.CHECK_INTERVAL_MS = 60s`（内层）
- `SessionWatchdog.STUCK_CHECK_INTERVAL_MS = 60s` per-session

`IdleNudger` 这层在新架构下没有意义——外层已经决定调用 cadence。`SessionWatchdog` per-session 的 60s 仍有价值（多 session 时避免每 30s 都 `client.session.messages` 一遍），保留。

**建议**：

- 删除 `IdleNudger.lastCheckAt` 和 `CHECK_INTERVAL_MS`，让 cadence 完全由 `SchedulerMaintenance` 控制。如要 60s 节奏，把 `MAINTENANCE_INTERVAL_MS` 改 60_000 即可。
- 这样 `IdleNudger.detect` 也不需要返回时机相关的逻辑，签名可以更纯。

### 3.6 [文档] `checkAndUnblockDependencies` 频率从 ~1Hz 降到 1/30s

任务依赖刚解锁的最坏延迟从 ~1s 拉到 30s。多半够用，但**值得在 commit message 或 `scheduler-maintenance.ts` 文件头注释里写一行**说明这是有意的取舍。

### 3.7 [可选] `detectMessageDispatchIntents` 每个 role 一次 `rawQuery`

```ts
for (const role of AGENT_ROLES) { rawQuery(...) }
```

可以改成一次 `GROUP BY to_role` 查询，但热路径每 tick 跑 ≤ 3 次小查询可接受，**保持现状即可**。

## 4. 合并门槛

| 严重度 | 项 | 必须合并前修 |
| --- | --- | --- |
| 高 | 3.1 `pending_work` intent 死代码 / 派发延迟 | ✅ |
| 高 | 3.2 `IdleNudger` / `SessionWatchdog` 测试 | ✅ |
| 中 | 3.3 删除 `pm-idle-monitor.ts` | 可下个 PR |
| 中 | 3.4 `SessionWatchdog` 返回类型缩窄 | 可下个 PR |
| 低 | 3.5 删除 `IdleNudger.CHECK_INTERVAL_MS` | 可下个 PR |
| 低 | 3.6 注释依赖检查频率变化 | 建议本 PR |
| 低 | 3.7 SQL 合并查询 | 不必 |

## 5. 后续 RFC 候选

- `DispatchIntent` 是否还需作为公共类型？如果 watchdog 不再用、idle nudger 不再向 dispatcher 反馈，最终它退化为"未读消息触发派发"的内部信号，可以考虑彻底取消这个抽象。
- `SchedulerMaintenance` 当前职责是"非派发的所有事情"，命名上可以；但如果将来要加新维护项（如 token 配额检查、磁盘清理），需要给它一个插件式的注册机制，避免又长成第二个 `StallDetector`。
