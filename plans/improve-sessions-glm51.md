# Session 异常停止问题修复方案

## 问题背景

win-agent 的 session 在工作过程中出现突然停止、无响应、无进一步动作的异常行为。

## 根因分析

| # | 问题 | 文件位置 | 严重程度 |
|---|------|----------|----------|
| 1 | 调度循环阻塞 — `session.prompt()` 超时默认1小时，期间整个调度循环被阻塞，无法处理其他任务 | `src/engine/scheduler.ts:76` | 高 |
| 2 | Session 初始化超时后静默继续 — 未就绪的 session 被使用，后续 dispatch 失败或无响应 | `src/engine/session-store.ts:178` | 高 |
| 3 | Dispatch 失败后消息被标记为已读 — 3次重试全部失败后，消息丢失，用户输入被忽略 | `src/engine/scheduler-dispatch.ts:213` | 高 |
| 4 | 无外部看门狗 — 进程存在但不代表功能正常，事件循环卡死无法检测 | N/A | 中 |
| 5 | Opencode server 异常后无自恢复 — 健康检查挂起调度但不重启 server | `src/engine/scheduler.ts:107-123` | 中 |
| 6 | getTaskSession 映射丢失 — 创建新 session 失败时旧映射已删除，task 进入无 session 状态 | `src/engine/session-manager.ts:129-142` | 低 |
| 7 | Dispatch 超时时间过长 — 默认1小时，session 无响应时等待过久 | `src/config/index.ts` | 低 |

## 改进项

### 改进项一：为调度循环添加全局超时看门狗

**目标**：防止单次 dispatch 阻塞整个调度循环。

**修改文件**：`src/engine/scheduler.ts`

**实现细节**：
- 为每个调度 tick 添加独立的全局超时保护
- 超时后终止当前 dispatch，恢复调度循环
- 超时时记录日志并标记消息为失败

```typescript
// scheduler.ts
const SCHEDULER_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000; // 10分钟全局超时

async function tryDispatchWithWatchdog(
  role: Role,
  client: OpenCodeClient,
  signal: AbortSignal
): Promise<void> {
  const controller = new AbortController();
  const combinedSignal = AbortSignal.any([signal, controller.signal]);

  const timeout = setTimeout(() => {
    controller.abort();
    logger.warn({ role }, '调度 tick 超时，强制终止 dispatch');
  }, SCHEDULER_DISPATCH_TIMEOUT_MS);

  try {
    await tryDispatchNormalRole(role, client, { signal: combinedSignal });
  } finally {
    clearTimeout(timeout);
  }
}
```

**验收标准**：单个 dispatch 超时不会阻塞后续调度循环。

---

### 改进项二：Session 初始化超时后自动重建

**目标**：避免使用未就绪的 session。

**修改文件**：`src/engine/session-store.ts`

**实现细节**：
- 初始化超时后，先释放当前 session，再重新创建
- 最多重试 2 次，超过重试次数则抛出异常，阻止引擎以不健康状态启动
- 增加配置项 `sessionInitMaxRetries`

```typescript
// session-store.ts
const MAX_INIT_RETRIES = loadConfig().engine?.sessionInitMaxRetries ?? 2;

async function initSessionWithRetry(
  role: Role,
  client: OpenCodeClient,
  maxWait: number
): Promise<string> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_INIT_RETRIES; attempt++) {
    try {
      const sessionId = await createRoleSession(role, client);
      const ready = await pollSessionReady(sessionId, client, maxWait);
      if (ready) return sessionId;

      logger.warn({ role, attempt }, 'Session 初始化超时，释放并重建');
      await releaseSession(role);
    } catch (err) {
      lastError = err as Error;
      logger.error({ role, attempt, err }, 'Session 创建失败');
      await releaseSession(role);
    }
  }
  throw new Error(`${role} session 初始化失败（已重试 ${MAX_INIT_RETRIES} 次）: ${lastError?.message}`);
}
```

**验收标准**：session 初始化超时后能自动恢复，不再以未就绪状态继续运行。

---

### 改进项三：Dispatch 失败后消息进入重试队列

**目标**：避免 dispatch 失败导致消息永久丢失。

**修改文件**：
- `src/db/schema.ts` — 增加 `retry_count` 字段
- `src/db/repository.ts` — 修改消息查询逻辑，增加 `MAX_DISPATCH_RETRIES` 常量
- `src/engine/scheduler-dispatch.ts` — 修改失败处理逻辑

**实现细节**：

1. 在 messages 表增加 `retry_count` 字段（默认 0）

```typescript
// schema.ts
retry_count: { type: 'number', default: 0 }
```

2. 修改 dispatch 失败处理逻辑

```typescript
// scheduler-dispatch.ts
const MAX_DISPATCH_RETRIES = 3;

} catch (err) {
  if (err instanceof AbortError) throw err;

  for (const msg of messages) {
    const retries = (msg.retry_count ?? 0) + 1;
    if (retries >= MAX_DISPATCH_RETRIES) {
      update('messages', { id: msg.id }, {
        status: MessageStatus.Read,
        retry_count: retries
      });
      insert('logs', {
        role: Role.SYS,
        action: 'dispatch_abandoned',
        content: `消息 ${msg.id} 重试 ${retries} 次后放弃`
      });
    } else {
      update('messages', { id: msg.id }, {
        retry_count: retries
      });
    }
  }

  insert('logs', { role: Role.SYS, action: 'dispatch_failed', content: err.message });
}
```

3. 修改消息查询逻辑 — 只查询未超过重试次数的 pending 消息

```typescript
// repository.ts
function getNextPendingMessages(role: Role): Message[] {
  return query(
    'messages',
    { target_role: role, status: MessageStatus.Pending }
  ).filter(m => (m.retry_count ?? 0) < MAX_DISPATCH_RETRIES);
}
```

**验收标准**：dispatch 失败的消息不会被直接丢弃，而是进入重试队列，最多重试 3 次。

---

### 改进项四：添加引擎看门狗

**目标**：检测引擎调度循环是否真正在运行，而非只是进程存在。

**新增文件**：`src/engine/watchdog.ts`

**修改文件**：
- `src/cli/engine.ts` — 集成看门狗
- `src/engine/scheduler.ts` — 添加活跃时间戳更新

**实现细节**：

1. 在调度器中维护最近活跃时间

```typescript
// scheduler.ts
export let lastSchedulerActivityAt = 0;

function updateActivity() {
  lastSchedulerActivityAt = Date.now();
}

// 在每个调度 tick 成功后调用
updateActivity();
```

2. 实现看门狗

```typescript
// watchdog.ts
import { lastSchedulerActivityAt } from './scheduler';

const WATCHDOG_INTERVAL_MS = 60_000;          // 1分钟检查一次
const ENGINE_STUCK_THRESHOLD_MS = 10 * 60_000; // 10分钟无活动视为卡死

export function startWatchdog(): NodeJS.Timer {
  return setInterval(async () => {
    const idleMs = Date.now() - lastSchedulerActivityAt;
    if (lastSchedulerActivityAt > 0 && idleMs > ENGINE_STUCK_THRESHOLD_MS) {
      logger.error({ idleMs }, '看门狗检测到引擎长时间无调度活动');
      insert('logs', {
        role: Role.SYS,
        action: 'watchdog_stuck_detected',
        content: `引擎已 ${Math.round(idleMs / 60000)} 分钟无调度活动`
      });
      // 方案A: 通知用户后等待手动处理
      // 方案B: 自动重启引擎
    }
  }, WATCHDOG_INTERVAL_MS);
}
```

3. 在引擎启动时集成看门狗

```typescript
// cli/engine.ts
import { startWatchdog } from '../engine/watchdog';

const watchdogTimer = startWatchdog();
// 在 graceful shutdown 的 cleanup 中：
clearInterval(watchdogTimer);
```

**验收标准**：看门狗能检测到引擎调度循环卡死，并记录日志。

---

### 改进项五：Opencode server 异常自恢复

**目标**：当 opencode server 崩溃或无响应时，自动重启。

**修改文件**：`src/engine/scheduler.ts`

**实现细节**：
- 健康检查连续失败后，尝试重启 opencode server
- 重启成功后恢复调度
- 重启失败则记录错误并保持挂起状态

```typescript
// scheduler.ts
let healthFailures = 0;
const MAX_HEALTH_FAILURES = 3;

async function healthCheck(): Promise<boolean> {
  try {
    await client.session.list();
    healthFailures = 0;
    return true;
  } catch {
    healthFailures++;
    if (healthFailures >= MAX_HEALTH_FAILURES) {
      logger.error('opencode server 不可达，尝试重启');
      try {
        await restartOpenCodeServer(client);
        logger.info('opencode server 重启成功，恢复调度');
        healthFailures = 0;
        return true;
      } catch (restartErr) {
        logger.error({ err: restartErr }, 'opencode server 重启失败');
        return false;
      }
    }
    return true; // 低于阈值，继续
  }
}
```

**验收标准**：opencode server 异常后能自动尝试恢复，不再需要手动重启引擎。

---

### 改进项六：降低 Dispatch 超时时间

**目标**：减少单次 dispatch 无响应时的等待时间。

**修改文件**：`src/config/index.ts`

**实现细节**：
- 将 `dispatchTimeoutMs` 默认值从 3600000 (1小时) 降为 600000 (10分钟)
- 用户仍可通过配置覆盖

```typescript
// config/index.ts
dispatchTimeoutMs?: number; // 默认 600000 (10分钟)
```

**验收标准**：dispatch 超时后10分钟内自动终止，不再等待1小时。

---

### 改进项七：getTaskSession 原子性保障

**目标**：防止 session 映射在创建新 session 失败时丢失。

**修改文件**：`src/engine/session-manager.ts`

**实现细节**：
- 先创建新 session，成功后再释放旧 session
- 如果创建失败，保留旧映射并抛出异常

```typescript
// session-manager.ts
async function getTaskSession(
  role: Role,
  taskId: string,
  client: OpenCodeClient
): Promise<string> {
  const oldSessionId = roleSessions.get(role);

  // 先创建新 session
  const newSessionId = await createRoleSession(role, client);

  // 创建成功后再释放旧 session
  if (oldSessionId) {
    try {
      await client.session.delete(oldSessionId);
    } catch (err) {
      logger.warn({ role, oldSessionId, err }, '释放旧 session 失败，已创建新 session');
    }
  }

  roleSessions.set(role, newSessionId);
  return newSessionId;
}
```

**验收标准**：session 切换过程中不会出现映射丢失的情况。

---

## 改进项冲突与协调策略

### 冲突一：改进项一（调度超时看门狗）↔ 改进项三（消息重试队列）

**冲突描述**：改进项一在 dispatch 超时后通过 `AbortController` 终止 dispatch，此时 catch 块会处理消息。改进项三要求失败消息进入重试队列而非标记已读。两者需要共享同一套失败处理逻辑。

**协调策略**：统一 catch 块的错误分类。区分 "可重试错误"（超时、网络瞬断）和 "不可重试错误"（业务逻辑错误）。超时 abort 产生的错误应归为可重试错误，走重试队列逻辑。

```typescript
} catch (err) {
  if (err instanceof AbortError) {
    // 改进项一触发的超时 abort — 可重试
    markMessagesForRetry(messages);
  } else if (isTransientError(err)) {
    // 网络瞬断等 — 可重试
    markMessagesForRetry(messages);
  } else {
    // 业务逻辑错误 — 不可重试，直接标记已读
    markMessagesAsRead(messages);
  }
}
```

---

### 冲突二：改进项一（调度超时看门狗）↔ 改进项五（Server 自恢复）

**冲突描述**：健康检查失败触发 server 重启期间，scheduler loop 仍在运行，调度看门狗可能对正在重启的 dispatch 触发超时 abort，形成竞态。

**协调策略**：引入 `isServerRestarting` 状态标志。Server 重启期间暂停调度超时检测和新的 dispatch。

```typescript
let isServerRestarting = false;

// 改进项五：重启时设置标志
async function restartServerWithLock() {
  isServerRestarting = true;
  try {
    await restartOpenCodeServer(client);
  } finally {
    isServerRestarting = false;
  }
}

// 改进项一：检查标志
async function tryDispatchWithWatchdog(...) {
  if (isServerRestarting) return; // 跳过，等待恢复
  // ... 超时看门狗逻辑
}
```

---

### 冲突三：改进项四（引擎看门狗）↔ 改进项一（调度超时看门狗）

**冲突描述**：如果改进项一生效，调度循环不会长时间卡死，改进项四的 "10分钟无活动" 阈值可能永远触发不到。但改进项四仍需作为兜底防线存在。

**协调策略**：改进项四的阈值应高于改进项一的超时时间 + 重试队列的最大累积时间。建议将改进项四的 `ENGINE_STUCK_THRESHOLD_MS` 设为 30 分钟（改进项一的 10 分钟 + 改进项三的 3 次重试叠加），使其只在改进项一和改进项三都失效时才触发。

```
改进项一超时: 10 分钟
改进项三最大重试: 3 次（每次可能 10 分钟超时）
改进项四阈值: 30 分钟（兜底线）
```

---

### 冲突四：改进项六（降低超时）↔ 改进项三（消息重试队列）

**冲突描述**：超时时间从 1 小时缩短到 10 分钟后，timeout 触发更频繁，更多消息进入重试队列。重试时如果仍然 timeout，会产生大量重试循环。

**协调策略**：重试时采用递增超时策略，避免重试请求反复超时：

```typescript
function getDispatchTimeout(retryCount: number): number {
  const baseTimeout = loadConfig().engine?.dispatchTimeoutMs ?? 600_000;
  // 每次重试超时时间递增 50%，上限 30 分钟
  const maxTimeout = 30 * 60 * 1000;
  return Math.min(baseTimeout * Math.pow(1.5, retryCount), maxTimeout);
}
```

同时在改进项三的重试逻辑中，限制总重试等待时间（如 30 分钟内同一消息最多重试 3 次），超过限制则放弃并标记已读。

---

## 实施优先级

| 优先级 | 改进项 | 原因 |
|--------|--------|------|
| P0 | 改进项一 — 调度循环超时看门狗 | 直接解决调度循环卡死导致全系统无响应的核心问题 |
| P0 | 改进项二 — Session 初始化重试 | 防止引擎以不健康状态启动导致后续所有操作失败 |
| P1 | 改进项三 — 消息重试队列 | 避免用户输入因瞬态错误被永久丢失 |
| P1 | 改进项六 — 降低超时时间 | 减少无响应等待时间，配合改进项一使用 |
| P2 | 改进项四 — 引擎看门狗 | 增加最后一道防线，检测改进项一未覆盖的卡死场景 |
| P2 | 改进项五 — Server 自恢复 | 增强系统鲁棒性，减少人工干预 |
| P3 | 改进项七 — Session 原子性 | 低概率场景，但修复成本低 |

## 实施顺序与验收

按优先级实施，每项完成后进行对应验收测试再进入下一项。

### 验收测试

1. **改进项一**：模拟长时间 dispatch，验证超时后调度循环能继续运行
2. **改进项二**：模拟 session 初始化超时，验证能自动重试并最终启动成功
3. **改进项三**：模拟 dispatch 连续失败，验证消息不被丢弃而是进入重试队列
4. **改进项四**：模拟调度循环卡死，验证看门狗能检测并记录日志
5. **改进项五**：模拟 opencode server 崩溃，验证能自动重启恢复
6. **改进项六**：验证 dispatch 在 10 分钟内超时终止
7. **改进项七**：模拟新 session 创建失败，验证旧 session 映射不丢失