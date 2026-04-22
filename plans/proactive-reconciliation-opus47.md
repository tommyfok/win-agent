# schedulerTick 主动状态盘点 — 架构演进提案

> 模型：claude-opus-4-7
> 依赖：`plans/ticker-fix-opus47.md`（先行修完 B1–B4 / S1 / S3 / S4 / S5）
> 目标：把 `schedulerTick` 从**基于内存标志位的消息泵**演进为**基于 opencode 真实 session 状态的状态收敛器**，让调度决策以服务端真相为准。

---

## 0. 动机

当前 `schedulerTick` 的派发决策几乎完全依赖 **进程内内存态**：

- `roleManager.busyRoles` — 角色是否在处理派发
- `pmLastDispatchEnd` / `devLastDispatchEnd` — 角色最近一次完成时间
- `lastDispatchedRole` — 轮转基准
- `healthFailCount` — 服务端是否可达

一旦这些内存态和 opencode 服务端的真实 session 状态**失同步**，调度就会卡在"看起来活着、其实啥也不做"的死局。常见触发路径：

| # | 触发场景 | 后果 |
|---|---|---|
| 1 | engine 崩过一次但 opencode server 没重启 | 重启后 `busyRoles` = ∅，但可能 server 端 session 仍 busy → 重复派发 / race |
| 2 | `finally` 因异常没跑完（极端情况） | `busy=true` 残留 → 该角色永远被跳过 |
| 3 | 用户通过外部工具 / 其它进程直接调了 `session.abort` | engine 内存态还以为在忙 |
| 4 | session prompt 超时但 abortController 没能真正打断（见 `improve-sessions-opus47.md` R1/R2/R5）| scheduler 内存态"完成"了，但 server 端还 busy |
| 5 | `PmIdleMonitor` 只能看到 "PM 久未被派发"，看不到 "PM session 实际空闲但 DB 里有该派发的东西" | 产品视角下明明有活没人干，触发器看不见 |

这些场景都可以通过**每 tick 查一次服务端真实状态**消解。SDK 也恰好提供了廉价接口做这件事（见 §1）。

---

## 1. SDK 能力摘录（`@opencode-ai/sdk@1.3.13`）

### 1.1 `session.status()` — 主力

```ts
// GET /session/status
const statusMap = await client.session.status();
// statusMap: { [sessionID]: SessionStatus }
// SessionStatus =
//   | { type: "idle" }
//   | { type: "busy" }
//   | { type: "retry", attempt: number, message: string, next: number }
```

- **一次调用拿全部 session 状态**。成本等同于 `session.list()`（已在 health check 中使用）。
- 状态语义清晰：
  - `idle` = 对话已停止，在等下一次 prompt。
  - `busy` = 正在执行 prompt（含工具调用等）。
  - `retry` = LLM 侧在退避重试。`attempt` 和 `next`（epoch ms）可以判断"短暂受挫" vs "长时间卡住"。
- **当前代码库零调用**（全仓 grep 确认过），是未被利用的现成能力。

### 1.2 `session.messages({ path:{ id }, query:{ limit } })` — 辅助

```ts
const msgs = await client.session.messages({
  path: { id: sessionId },
  query: { limit: 5 },
});
// msgs: Array<{ info: Message, parts: Array<Part> }>
```

拿最近 N 条消息。用于：
- 判断 busy 的 session 是"还在有产出"还是"真卡死了"（检查最近 message/part 的时间戳）。
- 决定是否需要 `session.abort` 强制打断。

仅在发现可疑 session 时按 id 调用，不是每 tick 必发。

### 1.3 事件流（SSE，备选）

```ts
// GET /event   (SSE 流)
// EventSubscribeResponse = Event
// Event 包含:
//   EventSessionStatus   { sessionID, status: SessionStatus }
//   EventSessionIdle     { sessionID }
//   EventSessionError    { sessionID?, error? }
//   EventMessageUpdated  / EventMessagePartUpdated  (流式 token,高频)
```

push 模式。可以做到状态变化即时感知，但需要：
- SSE client + 断线重连 + catch-up 逻辑
- 本地状态缓存（因为 tick 决策仍然需要"所有 session 最新状态"的快照）

**不建议一上来做**。阶段 1 用 poll 已够用，等性能/延迟成为瓶颈再考虑。

### 1.4 其它

- `session.abort({ path:{ id } })` —— 已在使用。
- `session.get({ path:{ id } })` —— 已在使用，用于 resume 校验。
- `session.list()` —— 已在使用（health check）。

---

## 2. 目标设计

### 2.1 核心原则

> **服务端 `session.status()` 是派发决策的真相源。`roleManager` / 时间戳降级为辅助缓存与节流依据，不作为"能否派发"的唯一门槛。**

### 2.2 新组件

#### `SessionStateReconciler`（新）

```ts
export interface RoleRuntimeState {
  role: Role;
  sessionId: string | null;
  serverStatus: SessionStatus | 'no-session' | 'unknown';
  serverBusy: boolean;          // busy || retry
  localBusy: boolean;           // roleManager.isBusy(role)
  drift: 'none' | 'stale-busy' | 'phantom-busy';
  // stale-busy: localBusy=true, serverBusy=false → 清内存态
  // phantom-busy: localBusy=false, serverBusy=true → 标记内存态为 busy
}

export class SessionStateReconciler {
  async reconcile(
    client: OpencodeClient,
    sessionManager: SessionManager,
    roleManager: RoleManager
  ): Promise<Map<Role, RoleRuntimeState>>;
}
```

每个 tick 调用一次 `reconcile(...)`：

1. `client.session.status()` 拿全量状态。
2. 对每个 AGENT_ROLES 角色，查 sessionManager 得到其当前 session id（PM 是 `activeSessions`，DEV 需要按 Option B 的"当前 task group"来选 —— 见 §3.2）。
3. 对比 `localBusy` 与 `serverBusy`，产出 drift 分类。
4. 按分类自动纠正：
   - `stale-busy` → `roleManager.setBusy(role, false)` + 写日志
   - `phantom-busy` → `roleManager.setBusy(role, true)` + 写日志（防止 scheduler 同时派发）
5. 返回 `Map<Role, RoleRuntimeState>` 供后续决策使用。

#### `StallDetector`（新，取代 PmIdleMonitor）

```ts
export interface DispatchIntent {
  role: Role;
  reason: 'unread_messages' | 'pending_work' | 'stuck_session';
  details?: unknown;
}

export class StallDetector {
  async detect(
    states: Map<Role, RoleRuntimeState>,
    roleManager: RoleManager
  ): Promise<DispatchIntent[]>;
}
```

对 **每个** idle 或 stale 的角色，按以下顺序检查：

1. DB 里有该角色的 `Unread` 消息（已过 retry backoff）→ `unread_messages`
2. 有该角色职责性的未完成事务：
   - PM：`task_not_dispatched` / `task_blocked` / `task_pending_review` / DEV 空闲但有 InDev task / PM unread from user & DEV
   - DEV：自己 session 对应的 task 仍在 `InDev` 但 DB 里没给 DEV 发任何 directive（被跳过的指令）
3. 对 `serverBusy` 且最近 N 分钟无 message/part 更新的 session：`stuck_session`（建议 abort + 重派）

`PmIdleMonitor` 被该组件完全吸收。"PM 空闲 + DEV 空闲 + 有事可干"不再需要两层 threshold，直接由 "idle + 有 unread/pending_work" 决定。

### 2.3 新的 schedulerTick 流程

```ts
async function schedulerTick(...) {
  // 1. 健康检查(保留)
  if (shouldRunHealthCheck()) {
    await runHealthCheck();
  }
  if (healthFailCount >= MAX_HEALTH_FAILURES) return;

  // 2. 状态盘点 — 新增
  const states = await reconciler.reconcile(client, sessionManager, roleManager);

  // 3. 依赖解阻塞(保留)
  checkAndUnblockDependencies();

  // 4. PM deferred 消息升级(保留,但改用 states 中的 PM idle 判定)
  promoteDeferredPmMessages(states.get(Role.PM));

  // 5. 卡住 session 兜底(新) —— 对 stuck_session 主动 abort
  await handleStuckSessions(states, client);

  // 6. 检测所有派发意图 — 替代原有 PmIdleMonitor
  const intents = await stallDetector.detect(states, roleManager);

  // 7. 派发 —— 保留 Option B 的 per-task-group 语义,并按轮转顺序选择一个 intent 执行
  await tryDispatchNormalRole(client, sessionManager, roleManager, intents, states);
}
```

---

## 3. 分阶段落地

### 阶段 1（MVP，低侵入）—— 接入 `session.status` 做状态收敛

#### 目标

- 不改派发逻辑整体形态
- 只在 tick 开头加 `reconcileSessionState`
- 消除 "busy 标志和服务端不同步" 这一类 deadlock

#### 改动点

| 文件 | 变更 |
|---|---|
| `src/engine/session-manager.ts` | 暴露 `getRoleSessionId(role: Role): string \| null` 供盘点模块拿到"当前该角色的主 session"（PM 简单，DEV 按 currentDispatch.taskId 选或返回 null）|
| `src/engine/session-reconciler.ts`（新）| 实现 `SessionStateReconciler`（纯读 + 修正 `RoleManager`）|
| `src/engine/scheduler.ts` | `schedulerTick` 在 health check 之后、业务动作之前插入一行 `const states = await reconciler.reconcile(...)` |
| `src/engine/scheduler-dispatch.ts` | `tryDispatchNormalRole` 接受 `states`，用 `serverStatus` 取代 `roleManager.isBusy(role)` 做派发前过滤 |
| `src/engine/opencode-server.ts` | `checkHealth` 可复用 `session.status()` 代替 `session.list()`，顺便拿到 status map（小优化，合并到 reconciler 里） |

#### 关键实现细节

- `session.status()` 的返回 key 是 session id。若 sessionManager 的某角色 session 不在返回 map 里，说明 server 侧已清理 → 记为 `no-session`，派发前触发重建逻辑（复用 `getSession` / `createRoleSession`）。
- `retry` 视为 `serverBusy=true`，但不触发 `stuck_session` 告警（LLM 正常退避中）。
- `reconcile` 本身失败（网络抖动）→ 不抛，返回空 map，scheduler 退化到旧路径（按内存态派发），但累计 `healthFailCount`。

#### 验收标准

- [ ] 手动在外部调 `POST /session/{id}/abort` 中断 DEV session（engine 内存态仍 busy=true）→ 下一个 tick log 中出现 `reconcile: stale-busy role=DEV`，且 DEV 可以被重新派发。
- [ ] 模拟在 engine 内存外启动另一个进程向 PM session 发 prompt → 下一个 tick log 中出现 `reconcile: phantom-busy role=PM`，scheduler 跳过向 PM 派发直到外部结束。
- [ ] 连续 100 个 tick 下 `session.status()` p99 < 50ms（本地环境）。
- [ ] 所有 `plans/ticker-fix-opus47.md` 中的 E2E 测试保持绿。

---

### 阶段 2 —— 引入 StallDetector，吸收 PmIdleMonitor

#### 目标

- 派发意图统一用 `DispatchIntent` 描述
- 主动发现 "服务端 idle + DB 有活" 的场景（不仅限于 PM）
- 删除或标记弃用 `PmIdleMonitor`

#### 改动点

| 文件 | 变更 |
|---|---|
| `src/engine/stall-detector.ts`（新）| `StallDetector.detect(states, roleManager): DispatchIntent[]` |
| `src/engine/pm-idle-monitor.ts` | 保留"提醒文案 / 记日志"的工具函数，核心检查逻辑迁入 StallDetector；或直接删除，由 StallDetector 写提醒消息。本计划倾向**直接删除** |
| `src/engine/scheduler.ts` | `schedulerTick` 调 StallDetector，把 intents 传进 dispatch |
| `src/engine/scheduler-dispatch.ts` | `tryDispatchNormalRole` 改为按 intents 优先级 + 轮转顺序选一个角色派发；仍保持"一个 tick 一个派发"的 V1 语义 |

#### 细节

- **优先级**：`unread_messages > stuck_session > pending_work`。原因：未读消息是显式事件，优先级最高；stuck session 次之（防止僵局）；pending_work 是主动提醒，最后考虑。
- **"idle reminder" 消息**继续发，但由 StallDetector 在 `pending_work` intent 被选中且角色为 PM 时统一触发（合并当前 PmIdleMonitor 的文案拼装）。
- **DEV 的 pending_work**：检测"DEV session idle 且有 DB 未读"是冗余（那会走 unread_messages 分支）；真正有用的是"DEV session idle 但 task 仍 InDev 且 DEV 没收到最近一条 directive"—— 生成一条 system 消息补发。

#### 验收标准

- [ ] 构造 PM idle > 10 分钟 + DEV idle + 有 pending_review task → StallDetector 产出 `pending_work(PM)`，scheduler 给 PM 发提醒消息。
- [ ] 构造 PM idle + DEV idle + DEV 有未读 directive 但 dev session 状态是 idle → StallDetector 产出 `unread_messages(DEV)` 优先于 PM reminder，scheduler 本 tick 派发 DEV。
- [ ] 回归：`PmIdleMonitor` 原有单测全部迁移到 `StallDetector` 并通过。

---

### 阶段 3（可选）—— 引入 `stuck_session` 兜底

#### 目标

对"server 侧 busy 但长时间无产出"的 session 主动干预。

#### 判定

```ts
// 对每个 serverBusy 的 session:
const msgs = await client.session.messages({
  path: { id },
  query: { limit: 3 },
});
const lastUpdate = Math.max(...msgs.flatMap(m => [m.info.time?.completed, m.parts.map(p => p.time?.end)]).filter(Boolean));
if (now - lastUpdate > STUCK_THRESHOLD_MS /* 默认 5 min */) {
  // 判定 stuck
}
```

#### 动作

1. 写日志 `stuck_session_detected`
2. 调 `client.session.abort({ path: { id } })`
3. 将该 session 对应的 task/PM 的最近那条 unread → deferred 或回退到 unread（看业务选择）
4. 触发重派（下一 tick 就会走）

#### 验收标准

- [ ] 人为让 LLM 卡超过 5 分钟 → 引擎自动 abort 并重派，期间 scheduler 不被整个阻塞（验证 `session.messages` 调用本身也要有 timeout）。

---

### 阶段 4（可选）—— SSE push 化

仅在阶段 1–3 跑稳后、且 poll 成本/延迟成为瓶颈时再做。否则不做。

---

## 4. 迁移与兼容

- **`PmIdleMonitor` 删除时机**：阶段 2 完成。之前在 `ticker-fix-opus47.md` 的 B4（条件写反）只做最小 `&&` → `||` 修复，文件头加 `@deprecated` 注释，等阶段 2 整个文件删除。
- **时间戳状态**：`pmLastDispatchEnd` / `devLastDispatchEnd` / `lastDispatchedRole` 保留作为**辅助** —— 用于轮转优先级和 cooldown，不再作为 busy 判定。
- **`healthFailCount`**：保留但和新 reconciler 合并计数（都基于 HTTP 请求结果）。

## 5. 风险与回避

| 风险 | 回避 |
|---|---|
| `session.status()` 自身 hang | 给 reconcile 包 `Promise.race` + 超时（3s），失败降级到内存态 |
| reconciler 纠正 busy 标志时与 dispatch 的 `finally` race | `reconcile` 只改 `busyRoles` Set 本身，`tryDispatchNormalRole` 读到已纠正后的值不会出现死循环；冲突时优先以 server 为准 |
| session id 漂移（rotate 后旧 id 仍出现在 status map） | reconciler 按 sessionManager 当前 id 为准，忽略 status map 里的孤儿 session（留给 cleanupOldSessions） |
| 外部进程（talk 命令）用 PM session 发 prompt | 这是 feature 不是 bug：reconciler 标 phantom-busy，scheduler 跳过直到外部结束。加日志便于观察 |

## 6. 落地顺序（整体）

```
ticker-fix-opus47.md 全部落完 (前置)
  ↓
阶段 1: SessionStateReconciler (最大收益/最低风险)
  ↓
阶段 2: StallDetector + 删 PmIdleMonitor
  ↓
阶段 3: stuck_session 兜底 (按需)
  ↓
阶段 4: SSE push (最后,通常不做)
```

## 7. 不在本计划范围

- 并发派发 / 多 worker：仍为 V1 串行。
- `scheduler-dispatch.ts` 的模块级单例改造（`SchedulerState` 对象化）：独立一期，可以和阶段 1 合并也可以分开。
- Memory rotator / session rotate 时机与 reconciler 的协作细节（例如 rotate 期间 session 状态）：阶段 1 先观察，必要时专项 RFC。
