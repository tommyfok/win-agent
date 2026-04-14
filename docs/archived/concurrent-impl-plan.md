# 并行调度实施方案：V1 串行 → V2 并行

## 背景

当前引擎采用 V1 串行调度：每 tick 只调度一个角色，`client.session.prompt()` 同步阻塞等待 LLM 返回。DEV 在跑时 QA 只能等，PM 在等时 DEV 也不能调度。

目标：利用 opencode SDK 的 `promptAsync()` + SSE 事件流，实现多角色/多任务并行调度。

```
V1:  prompt(DEV) ──阻塞──> 完成 → prompt(QA) ──阻塞──> 完成
V2:  promptAsync(DEV) ──┐
     promptAsync(QA)  ──┤──> session.idle 事件触发后续逻辑
     promptAsync(PM)  ──┘
```

## 核心 API

```typescript
// 异步发送 prompt（fire-and-forget，返回 204）
client.session.promptAsync({ path: { id }, body: { agent, parts } })

// SSE 事件订阅
const { stream } = await client.event.subscribe()
for await (const event of stream) { ... }

// 关键事件类型
type EventSessionIdle  = { type: "session.idle";  properties: { sessionID: string } }
type EventSessionError = { type: "session.error"; properties: { sessionID?: string; error: ... } }

// 获取 session 消息（用于提取 token 用量）
client.session.messages({ path: { id } }) → Message[]
```

## 并发安全分析

- JavaScript 单线程事件循环：Map/Set 在 `await` 之间的访问天然安全
- 不同任务的 session 完全隔离（key = `"taskId-role"`）
- PM 只有一个 session → 同一时刻只允许一个 PM dispatch
- better-sqlite3 同步调用，无竞态
- `outputHistory` 按 `"role:taskId"` 分桶后无冲突

---

## 实施阶段

### Phase 1：事件监听基础设施

**新增 `src/engine/event-listener.ts`**

```typescript
interface InFlightDispatch {
  role: Role;
  sessionId: string;
  messages: MessageRow[];
  taskId: number | null;
  startTime: number;
}

interface EventListenerCallbacks {
  onComplete: (dispatch: InFlightDispatch) => Promise<void>;
  onError: (dispatch: InFlightDispatch, error: unknown) => void;
}

// 模块状态
const inFlightDispatches = new Map<string, InFlightDispatch>();  // sessionId → metadata
let abortController: AbortController | null = null;

export function startEventListener(client, callbacks): void;
export function stopEventListener(): void;
export function registerInFlight(sessionId, dispatch): void;
export function getInFlightCount(): number;
```

事件处理逻辑：
- `session.idle` → 查找 `inFlightDispatches`，触发 `onComplete` 回调
- `session.error` → 查找 `inFlightDispatches`，触发 `onError` 回调
- 未匹配的 sessionId 忽略（可能是 `rotateSession` 等非调度 session）

**修改 `src/engine/scheduler.ts`**

- `startSchedulerLoop()` 启动时调用 `startEventListener()`
- `stopSchedulerLoop()` 停止时调用 `stopEventListener()`，并等待 in-flight 排空

### Phase 2：RoleManager 支持任务级忙碌追踪

**修改 `src/engine/role-manager.ts`**

```typescript
export class RoleManager {
  private busySessions: Set<string> = new Set();

  // PM 级别忙碌检查
  isBusy(role: string): boolean {
    return this.busySessions.has(role);
  }

  // DEV/QA 任务级忙碌检查
  isTaskBusy(role: string, taskId: number): boolean {
    return this.busySessions.has(`${role}:${taskId}`);
  }

  setBusy(role: string, busy: boolean, taskId?: number): void {
    const key = taskId != null ? `${role}:${taskId}` : role;
    if (busy) this.busySessions.add(key);
    else this.busySessions.delete(key);
  }

  // 检查某角色是否有任何活跃调度
  hasAnyBusy(role: string): boolean {
    for (const key of this.busySessions) {
      if (key === role || key.startsWith(`${role}:`)) return true;
    }
    return false;
  }
}
```

### Phase 3：异步 Dispatch 函数

**修改 `src/engine/dispatcher.ts`**

新增 `dispatchToRoleAsync()` — 与 `dispatchToRole()` 步骤 0-3 相同（过滤、获取 session、知识检索、构建 prompt），但第 4 步改为 `promptAsync`：

```typescript
export async function dispatchToRoleAsync(
  client: OpencodeClient,
  sessionManager: SessionManager,
  role: Role,
  messages: MessageRow[]
): Promise<{ sessionId: string; taskId: number | null } | null> {
  // ... 步骤 0-3 同 dispatchToRole ...

  // 步骤 4：异步发送 prompt
  await client.session.promptAsync({
    path: { id: sessionId },
    body: { agent: role, parts: [{ type: "text", text: prompt }] },
  });

  // 步骤 5：提前标记消息为 read，防止下一 tick 重复调度
  for (const msg of messages) {
    update("messages", { id: msg.id }, { status: MessageStatus.Read });
  }

  return { sessionId, taskId };
}
```

新增 `dispatchToRoleGroupedAsync()` — 按 task 分组后 `Promise.all` 并行 fire：

```typescript
export async function dispatchToRoleGroupedAsync(
  client, sessionManager, role, messages, roleManager
): Promise<void> {
  const groups = groupByTask(messages);
  await Promise.all(groups.map(async (group) => {
    const taskId = group[0].related_task_id;
    if (taskId && roleManager.isTaskBusy(role, taskId)) return;
    roleManager.setBusy(role, true, taskId ?? undefined);
    const result = await dispatchToRoleAsync(client, sessionManager, role, group);
    if (result) {
      registerInFlight(result.sessionId, {
        role, sessionId: result.sessionId, messages: group,
        taskId, startTime: Date.now(),
      });
    }
  }));
}
```

### Phase 4：完成回调 & Token 提取

在 `event-listener.ts` 或 `dispatcher.ts` 中实现 `handleDispatchComplete()`：

```typescript
async function handleDispatchComplete(
  client, sessionManager, roleManager, dispatch
): Promise<void> {
  const { role, sessionId, taskId } = dispatch;

  // 1. 获取最后一条 assistant 消息
  const msgs = await client.session.messages({ path: { id: sessionId } });
  const lastAssistant = [...(msgs.data ?? [])].reverse()
    .find(m => m.info.role === "assistant");

  // 2. 提取 token 用量
  const inputTokens = lastAssistant?.info?.tokens?.input ?? 0;
  const outputTokens = lastAssistant?.info?.tokens?.output ?? 0;

  // 3. 持久化 LLM 输出到 role_outputs 表
  // ... (同现有 dispatchToRole 步骤 6)

  // 4. 内存轮转检查
  await checkAndRotate(sessionManager, role, sessionId, inputTokens, outputTokens, taskId);

  // 5. 释放忙碌状态
  roleManager.setBusy(role, false, taskId ?? undefined);

  // 6. PM 专属：cooldown + consecutive 计数
  if (role === "PM") {
    pmLastDispatchEnd = Date.now();
    pmConsecutiveCount++;
  } else {
    pmConsecutiveCount = 0;
  }

  // 7. 后置检查
  checkAutoTriggers();
  checkWorkflowCompletion(sessionManager);
}
```

错误处理 `handleDispatchError()`：

```typescript
function handleDispatchError(roleManager, dispatch, error): void {
  // 记录日志
  insert("logs", { role: dispatch.role, action: "dispatch_error", content: String(error) });

  // 释放忙碌状态
  roleManager.setBusy(dispatch.role, false, dispatch.taskId ?? undefined);

  // 将消息标记回 Unread，下一 tick 重试
  for (const msg of dispatch.messages) {
    update("messages", { id: msg.id }, { status: MessageStatus.Unread });
  }
}
```

### Phase 5：重构 Scheduler 主循环

**修改 `src/engine/scheduler.ts`** — `schedulerTick` 变为轻量非阻塞：

```typescript
async function schedulerTick(client, sessionManager, roleManager): Promise<void> {
  checkAndUnblockDependencies();

  // 提升 deferred 消息（PM 空闲且无 unread 时）
  if (!roleManager.isBusy("PM")) {
    const pmUnread = select("messages", { to_role: "PM", status: MessageStatus.Unread });
    if (pmUnread.length === 0) {
      rawRun(`UPDATE messages SET status = '${MessageStatus.Unread}'
              WHERE status = '${MessageStatus.Deferred}' AND to_role = 'PM'`);
    }
  }

  // 1. 用户消息优先（PM 不忙时）
  if (!roleManager.isBusy("PM")) {
    const userMsgs = select("messages",
      { from_role: "user", to_role: "PM", status: MessageStatus.Unread },
      { orderBy: "created_at ASC" });
    if (userMsgs.length > 0) {
      roleManager.setBusy("PM", true);
      const result = await dispatchToRoleAsync(client, sessionManager, "PM", userMsgs);
      if (result) registerInFlight(result.sessionId, { ... });
      pmConsecutiveCount = 0;
    }
  }

  // 2. 遍历所有角色（不再 break，每个角色都检查）
  for (const role of AGENT_ROLES) {
    if (role === "PM") {
      if (roleManager.isBusy("PM")) continue;
      if (Date.now() - pmLastDispatchEnd < PM_COOLDOWN_MS) continue;
      // ... starvation 检查 ...
      const messages = select("messages",
        { to_role: "PM", status: MessageStatus.Unread },
        { orderBy: "created_at ASC" });
      if (messages.length === 0) continue;
      roleManager.setBusy("PM", true);
      const result = await dispatchToRoleAsync(client, sessionManager, "PM", messages);
      if (result) registerInFlight(result.sessionId, { ... });
    } else {
      // DEV/QA：按 task 分组并行调度
      const messages = select("messages",
        { to_role: role, status: MessageStatus.Unread },
        { orderBy: "created_at ASC" });
      if (messages.length === 0) continue;
      await dispatchToRoleGroupedAsync(client, sessionManager, role, messages, roleManager);
    }
  }

  // 注意：checkAutoTriggers + checkWorkflowCompletion 不再在这里调用
  // 它们在 handleDispatchComplete 回调中触发（每次调度完成后立即执行）
}
```

关键变化：
- 移除 `break`（每个角色每 tick 都检查）
- 移除 `await dispatchToRole()` 的阻塞等待
- 移除 tick 末尾的 `checkAutoTriggers()` / `checkWorkflowCompletion()`（移到完成回调）
- 每 tick 只做"检查 + fire"，几乎 O(1)

### Phase 6（可选）：memory-rotator 优化

**修改 `src/engine/memory-rotator.ts`**

将 `outputHistory` 的 key 从 `role` 改为 `"role:taskId"`：

```typescript
// before
const key = role;        // "DEV" — 多个 task 共享同一历史
// after
const key = taskId != null ? `${role}:${taskId}` : role;  // "DEV:42" — 每个 task 独立历史
```

这样 task#1 的输出抖动不会误触发 task#2 的 anxiety rotation。

---

## 涉及文件

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/engine/event-listener.ts` | **新增** | SSE 事件订阅、in-flight 追踪、事件路由 |
| `src/engine/scheduler.ts` | 重构 | 启停事件监听、移除串行阻塞、改为 fire-and-forget |
| `src/engine/dispatcher.ts` | 新增函数 | `dispatchToRoleAsync()`、`dispatchToRoleGroupedAsync()`、`handleDispatchComplete()` |
| `src/engine/role-manager.ts` | 扩展 | 任务级忙碌追踪 `isTaskBusy()` / `hasAnyBusy()` |
| `src/engine/memory-rotator.ts` | 小改 | `outputHistory` key 加 taskId |
| `src/engine/session-manager.ts` | 不变 | `rotateSession()` 保持同步 `prompt()` |

## 保留同步 prompt 的场景

- `session-manager.ts` 的 `rotateSession()` — 必须拿到 memory 内容才能创建新 session
- `session-manager.ts` 的 `writeAllMemories()` — 引擎关停时的同步写入

## 验证方案

1. **单元验证**：启动引擎后观察日志，确认多角色同时出现 `📨 调度 → DEV/QA/PM` 而非串行等待
2. **事件流验证**：确认 `session.idle` 事件正确触发完成回调，token 用量正确提取
3. **错误恢复验证**：模拟 session error，确认消息回退为 Unread 并在下一 tick 重试
4. **deferred 消息验证**：确认 auto-trigger 的 deferred 消息在 PM 空闲时正确提升并单独处理
5. **memory rotation 验证**：确认 80% 阈值和 anxiety 检测在并行模式下仍正确工作
6. **回退方案**：保留 `dispatchToRole()`（同步版），可通过环境变量 `PARALLEL_DISPATCH=false` 切回 V1
