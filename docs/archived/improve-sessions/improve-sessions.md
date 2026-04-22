# Session 工作中突然停止 / 无响应 — 根因分析与改进方案

> 整合自 opus-4-7 与 glm-5.1 两版方案，经逐条代码验证后形成。
> 调查范围：`src/engine/**`、`src/embedding/**`、`src/db/**`、`src/cli/engine.ts`

---

## 0. 问题定义

用户观察到的症状：

- 引擎进程（`win-agent _engine`）仍在运行（PID 有效），但调度循环长时间没有新动作
- PM / DEV 的 session 看起来还活着，但不再产出 assistant 消息
- 数据库中 `messages.status = unread` 的消息堆积不消费
- `logs` 里不再出现 `dispatch` / `dispatch_failed` / `scheduler_error` 等痕迹（完全静默）

结合代码分析，这不是单一 bug，而是**多条独立路径都能让引擎陷入"看起来活着、但已经不工作"的状态**。

---

## 1. 根因清单（按严重程度排序）

| # | 根因 | 位置 | 级别 | 验证状态 |
|---|------|------|------|----------|
| R1 | `abortController.signal` 没有传给 `client.session.prompt`，abort 对正在进行的 HTTP / LLM 调用无效 | `src/engine/dispatcher.ts:127-140` | **致命** | ✅ 已验证 |
| R2 | `withRetry` 的 `signal` 只在**尝试之间**检查；在 `await fn()` 期间 signal 触发不会中断当前 attempt | `src/engine/retry.ts:42-55` | **致命** | ✅ 已验证 |
| R3 | 单次 `session.prompt` 默认超时 **1 小时**（`dispatchTimeoutMs ?? 60*60*1000`）；真正卡住时整个调度循环被阻塞 1 小时 | `src/engine/dispatcher.ts:136`、`src/config/index.ts:37` | 高 | ✅ 已验证 |
| R4 | dispatch 失败后所有 `messages` 直接置 `Read`，此后永远不会再被派发——瞬时错误变成消息永久丢失 | `src/engine/scheduler-dispatch.ts:215-217` | 高 | ✅ 已验证 |
| R5 | `AbortError` 在 `tryDispatchNormalRole` 的 catch 里直接 throw → 上抛到 `schedulerTick` → 外层 `while` 收到 `AbortError` 则 **`break` 整个 loop** | `src/engine/scheduler-dispatch.ts:210` + `src/engine/scheduler.ts:60-62` | **致命** | ✅ 已验证 |
| R6 | 健康检查连续 3 次失败后 `return`（仅跳过当前 tick），调度 loop 本身不会退出，但没有重启 server 的能力，也无告警 | `src/engine/scheduler.ts:113-116` | 高 | ✅ 已验证（注：非"永久挂起"，loop 仍在跑、下次 tick 还会检查，但若 server 不自愈则无限空转） |
| R7 | `checkHealth` 自己没有超时；`client.session.list()` 若网络层挂住会卡死整个 tick | `src/engine/opencode-server.ts:62-69` | 高 | ✅ 已验证 |
| R8 | `createRoleSession` 中的 `session.promptAsync`（bind / recall）**没有超时**，在 session 初始化阶段卡死会让整个引擎启动挂住 | `src/engine/session-factory.ts:66-80` | 高 | ✅ 已验证 |
| R9 | `waitForSessionsReady` 超时后只 `console.log` 一句，**静默继续**，从此 PM session 可能处于未就绪状态 | `src/engine/session-store.ts:178` | 高 | ✅ 已验证 |
| R10 | `checkAndResumeInterrupted` 中 `session.promptAsync` 包在 `withRetry` 里但**没有超时**，可能拖住引擎启动 | `src/engine/session-store.ts:124-133` | 中 | ✅ 已验证 |
| R11 | `queryRelevantKnowledge` / `buildRecallPrompt` 调用 `generateEmbedding`，其中 OpenAI `fetch` **没有 timeout/AbortSignal**；local embedding 模型首次加载也没有超时；dispatch 在第 3 步可能无限期等待 embedding | `src/embedding/openai.ts:16-26`、`src/embedding/local.ts:34-44`、`src/engine/dispatcher.ts:113-117` | 高 | ✅ 已验证 |
| R12 | `checkAndRotate` 在 dispatch 成功后同步调用 `rotateSession`，而 `rotateSession` 里又调用 `writeMemory`（含 `session.prompt`，3 分钟 timeout）——这次调用**不受 scheduler 的 abortController 保护**，若卡住仍会阻塞调度 | `src/engine/session-manager.ts:157-182`、`src/engine/memory-writer.ts:39-48` | 中 | ✅ 已验证 |
| R13 | `getTaskSession` 先 `delete` 旧映射再 `createRoleSession`，若创建抛错则映射丢失；下一次 dispatch 进入时必然再走一遍创建链路（伴随 R8 可能再次卡住） | `src/engine/session-manager.ts:129-142` | 中 | ✅ 已验证 |
| R14 | DB 事务中 `withTransaction` + 其它进程（`talk`/CLI）并发写同一个 sqlite 文件，只有 `busy_timeout=5000ms`；busy 超时会抛异常 | `src/db/connection.ts:17` | 低 | ✅ 已验证 |
| R15 | 没有任何"引擎还在调度"的心跳/活跃时间戳，无法从外部判断是"真卡死"还是"真没事做" | 全局缺失 | 中 | ✅ 已验证 |
| ~~R16~~ | ~~`finally` 之外 busy 泄漏~~ | — | ~~低~~ | ❌ **推翻**：JavaScript 的 `finally` 保证执行，`scheduler-dispatch.ts:224-227` 中 `setBusy(role, false)` 位于 finally 最前面，即使 catch 中再抛异常也不影响。只有进程崩溃才可能泄漏，这种场景下进程已死、busy 状态无意义 |

> **R1、R2、R5 组合起来就是最常见的"session 突然停住"场景**：
> 某次 `session.prompt` 内部卡住 → abort 对它无效（R1/R2）→ 要么等 1 小时超时（R3）→ 要么被 `abortCurrentDispatch` 触发 AbortError → 这个 AbortError 把整个调度 loop 终结（R5）。此后进程仍活着但 scheduler loop 已退出，彻底无响应。

---

## 2. 改进方案

按"先保命、再保活、再保恢复"分成三层。

---

### P0 — 保命层（让 scheduler 永不因单次 dispatch 而死）

#### 改进 A：不把 `AbortError` 当作"终止主循环"的信号（对应 R5）

**现状**

```ts
// scheduler.ts:56-74
while (running) {
  try { await schedulerTick(...); }
  catch (err) {
    if (err instanceof AbortError) {
      logger.info(..., 'dispatch aborted');
      break;   // ← 致命：单次 dispatch 被 abort 会退出整个 loop
    }
    ...
  }
}
```

`abortCurrentDispatch()` 的语义是"中断当前一次 dispatch"，并非停机。停机路径走的是 `stopSchedulerLoop` 把 `running` 设为 false。

**方案**

`AbortError` 在主循环中视为"本轮 tick 结束"，而非"退出 loop"：

```ts
catch (err) {
  if (err instanceof AbortError) {
    logger.info({ message: err.message }, 'dispatch aborted, continuing');
    // 不 break —— 让主循环继续
  } else {
    logger.error({ err }, 'scheduler error');
    try { insert('logs', { role: Role.SYS, action: 'scheduler_error', ... }); } catch {}
  }
}
```

只在 `running === false`（由 `stopSchedulerLoop` 设置）或收到进程信号（SIGTERM/SIGINT）时退出。

**影响文件**：`src/engine/scheduler.ts`
**验收**：手动调用 `abortCurrentDispatch()` 后，下一个 tick 立刻继续 dispatch 其他角色的消息。

---

#### 改进 B：把 AbortSignal 真正传到 HTTP 层（对应 R1、R2）

**现状**

```ts
// dispatcher.ts:127-140
const result = await withRetry(
  () => withTimeout(
    client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: prompt }] },
    }),   // ← 没 signal
    loadConfig().engine?.dispatchTimeoutMs ?? 60 * 60 * 1000,
    `${role} session.prompt`
  ),
  { maxAttempts: 3, label: `${role} dispatch`, signal: options?.signal }
);
```

- `withRetry(signal)` 只在每次重试前检查 `signal.aborted`，一旦进入 `await fn()` 就无法再中断
- `withTimeout` 的 `Promise.race` 让上层 `await` 返回，但底层 HTTP 请求仍在继续

**方案**

1. `dispatcher.ts`：把 `options.signal` 透传给 `client.session.prompt`：

```ts
await withRetry(
  () => withTimeout(
    client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: prompt }] },
      signal: options?.signal,   // ← 新增
    }),
    dispatchTimeoutMs,
    `${role} session.prompt`
  ),
  { maxAttempts: 3, label: `${role} dispatch`, signal: options?.signal }
);
```

2. `retry.ts`：改造 `withTimeout` 使其同时接受外部 signal + 超时，并传 `innerSignal` 给业务函数：

```ts
export async function withTimeout<T>(
  promiseFactory: Promise<T> | ((innerSignal: AbortSignal) => Promise<T>),
  ms: number,
  label = 'operation',
  externalSignal?: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    if (typeof promiseFactory === 'function') {
      return await (promiseFactory as (s: AbortSignal) => Promise<T>)(ctrl.signal);
    }
    return await promiseFactory;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
```

> 注：此改造保持向后兼容——若 `promiseFactory` 是 `Promise`（旧用法），行为不变；若是函数，则接收 `ctrl.signal` 让底层 HTTP 可被中断。

3. 调用侧改为传入函数式 factory（让 `withTimeout` 传入 signal）：

```ts
await withRetry(
  () => withTimeout(
    (innerSignal) => client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: prompt }] },
      signal: innerSignal,
    }),
    dispatchTimeoutMs,
    `${role} session.prompt`,
    options?.signal,
  ),
  { maxAttempts: 3, label: `${role} dispatch`, signal: options?.signal }
);
```

**影响文件**：`src/engine/retry.ts`、`src/engine/dispatcher.ts`（凡是调用 `session.prompt*` 的位置都要补齐 signal，见改进 G/H）

**验收**：
- 构造一个永不返回的 `session.prompt`，调用 `abortCurrentDispatch()` 后 500ms 内 Promise 以 AbortError reject，scheduler 继续 tick
- 10 分钟 `dispatchTimeoutMs` 生效，真正关掉底层 HTTP 连接

---

#### 改进 C：降低默认 `dispatchTimeoutMs` 且给所有 prompt 调用套超时（对应 R3、R8、R10、R12）

**方案**

- `src/config/index.ts`：`dispatchTimeoutMs` 默认值从 `60 * 60 * 1000` 改为 **`10 * 60 * 1000`**（10 分钟），保留配置覆盖能力（config 注释同步更新）
- `src/engine/session-factory.ts` 中的 `session.promptAsync`（bind prompt）默认超时 **90s**
- `src/engine/session-store.ts` 的 resume `promptAsync` 同样 **90s**
- `src/engine/memory-writer.ts` 的 `writeMemory` 已有 3 分钟 timeout，保留；但在 `rotateSession` 里包一层外层 timeout 防止极端卡住：

```ts
// session-manager.ts
async rotateSession(role, sessionId, taskId?) {
  try {
    await withTimeout(
      () => writeMemory(this.client, role, sessionId, 'context_limit'),
      90_000,
      `${role} writeMemory on rotate`,
    );
  } catch { /* 继续轮转 */ }
  ...
}
```

**影响文件**：`src/config/index.ts`、`src/engine/session-factory.ts`、`src/engine/session-store.ts`、`src/engine/session-manager.ts`

**验收**：无论哪一路 prompt 卡住，都会在 ≤ 10 分钟内以错误返回，scheduler 立刻可以 tick 下一轮。

---

#### 改进 D：`AbortError` 不再让消息丢失；增加消息重试次数字段（对应 R4）

**现状**：dispatch 失败后所有涉及的 `messages` 直接置 `Read`，此后永远不会再被派发。

**方案**

1. schema 增加 `messages.dispatch_attempts INTEGER DEFAULT 0`（通过 `schema.ts` 的迁移机制），同时增加 `messages.last_dispatch_failed_at TEXT`（用于退避计算）

2. 拆分错误类型——区分可重试与不可重试：

```ts
function isRetryableDispatchError(err: unknown): boolean {
  if (err instanceof AbortError) return true;
  const msg = String(err instanceof Error ? err.message : err);
  if (/超时|timeout|ECONN|ETIMEDOUT|fetch failed|network/i.test(msg)) return true;
  return false;
}
```

3. catch 分支：

```ts
} catch (err) {
  const retryable = isRetryableDispatchError(err);
  for (const msg of messages) {
    const attempts = (msg.dispatch_attempts ?? 0) + 1;
    if (retryable && attempts < MAX_DISPATCH_RETRIES) {
      update('messages', { id: msg.id }, {
        dispatch_attempts: attempts,
        last_dispatch_failed_at: new Date().toISOString(),
      });
    } else {
      update('messages', { id: msg.id }, {
        status: MessageStatus.Read,
        dispatch_attempts: attempts,
      });
      insert('logs', {
        role: Role.SYS,
        action: 'dispatch_abandoned',
        content: `msg#${msg.id} 连续失败 ${attempts} 次，放弃`,
      });
    }
  }
  if (err instanceof AbortError) throw err;  // 按 A，不再杀主循环
  insert('logs', { ... });
}
```

4. `select` pending messages 时过滤 `dispatch_attempts < MAX`（避免死循环）；`MAX_DISPATCH_RETRIES = 3`，可通过 config override。

5. **per-message 退避**：上次失败到下次重试至少 `baseBackoffMs * 2^(attempts-1)`（`baseBackoffMs` 默认 30s）。在查询 pending 消息时过滤掉 `last_dispatch_failed_at + backoff > now` 的条目。

**影响文件**：`src/db/schema.ts`、`src/db/types.ts`、`src/engine/scheduler-dispatch.ts`

**验收**：手动让 session.prompt 抛网络错误 2 次，第 3 次成功；消息最终被正常消费且未丢失。

---

### P1 — 保活层（session / server 真挂了要能自己起来）

#### 改进 E：健康检查带超时 + 连续失败时重启 server（对应 R6、R7）

**现状**：`checkHealth` 调用 `client.session.list()`，没有超时；失败 3 次后仅 `return` 跳过当前 tick，loop 继续空转但不重启 server。

**方案**

1. 给健康检查本身加 **5 秒超时**：

```ts
export async function checkHealth(client: OpencodeClient): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    await client.session.list({ signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
```

2. 连续失败 N 次（默认 3）后**主动重启 opencode server**：

```ts
if (healthFailCount >= MAX_HEALTH_FAILURES) {
  if (!isServerRestarting) {
    logger.error('opencode server unreachable, restarting');
    isServerRestarting = true;
    try {
      const newHandle = await restartOpencodeServer(workspace);
      updateClientRefs(newHandle.client);
      healthFailCount = 0;
    } catch (restartErr) {
      logger.error({ err: restartErr }, 'server restart failed');
    } finally {
      isServerRestarting = false;
    }
  }
  return;  // 当前 tick 跳过
}
```

3. `restartOpencodeServer` 实现：kill 旧进程 → 调用 `startOpencodeServer` → 把新 `client` 刷到 scheduler + session-manager 的引用中。需要 `scheduler.ts` 和 `session-manager.ts` 支持 swap client（引入可变 ref 或 callback）。

**影响文件**：`src/engine/opencode-server.ts`（新增 `restartOpencodeServer`）、`src/engine/scheduler.ts`、`src/engine/session-manager.ts`、`src/cli/engine.ts`

**验收**：kill 掉 opencode 子进程，60 秒内 scheduler 自动启动新 server 并继续运作。

---

#### 改进 F：Session 初始化失败要"明确失败 / 明确成功"，不允许静默继续（对应 R8、R9、R10）

**现状**
- `waitForSessionsReady` 超时后仅 `console.log` 警告后返回 —— 整个引擎继续启动，但 PM session 可能根本没准备好
- `createRoleSession` 里的 `promptAsync` 没有外层 timeout

**方案**

1. `createRoleSession` 给 `promptAsync` 套 `withTimeout(…, 90_000, 'bind')`；失败要**删掉刚创建的 session**，抛到上层让调用者重试
2. `initPersistentSessions` / `getTaskSession` 加入"重试 + 放弃"策略：

```ts
for (let attempt = 1; attempt <= MAX_SESSION_INIT_RETRIES; attempt++) {
  try {
    const sid = await createRoleSession(...);
    if (await waitSingleSessionReady(sid, timeoutMs)) return sid;
    await safeDeleteSession(sid);  // 超时了就删除，不留垃圾
  } catch (err) {
    logger.warn({ attempt, err }, 'session init attempt failed');
  }
}
throw new Error(`${role} session 初始化失败（${MAX_SESSION_INIT_RETRIES} 次重试）`);
```

3. `waitForSessionsReady` 改为 per-session 并行等待 + 超时；超时一定要返回 false，由调用方决定重试还是 throw，而不是静默返回
4. `checkAndResumeInterrupted` 的 `promptAsync` 包 `withTimeout(…, 90_000)`；若超时，放弃 resume 并按"新建"流程走

**影响文件**：`src/engine/session-factory.ts`、`src/engine/session-store.ts`、`src/engine/session-manager.ts`

**验收**：手动让 opencode server 只响应 `create` 不响应 `prompt`，引擎应在 90s 内报出明确错误而非静默挂起。

---

#### 改进 G：embedding 调用带超时与 abort（对应 R11）

**现状**
- OpenAI `fetch` 没有 `signal`、没有超时
- 本地 `@huggingface/transformers` 的 pipeline 首次加载没有超时保护
- dispatch 第 3 步 `queryRelevantKnowledge → generateEmbedding`，如果卡住 → 整个 dispatch 卡住

**方案**

1. `openai.ts`：给 fetch 加 `AbortSignal` + 30s 超时：

```ts
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 30_000);
try {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST', headers, body, signal: ctrl.signal,
  });
  ...
} finally { clearTimeout(timer); }
```

2. `local.ts`：对首次 pipeline 加载做超时保护（比如 60s），超时后 fallback 或抛错
3. `index.ts` 的 `generateEmbedding` 对外包一层 `withTimeout`（默认 30s）
4. `dispatcher.ts` 的 knowledge 查询要**把 dispatch 的 abortSignal 串到 embedding**；embedding 失败/超时后**必须**继续走后续流程（当前已有 try/catch，保留）

**影响文件**：`src/embedding/openai.ts`、`src/embedding/local.ts`、`src/embedding/index.ts`、`src/engine/dispatcher.ts`

**验收**：embedding 服务宕机时，dispatch 日志里出现 `knowledge injection failed`，但 prompt 仍发给 LLM 并拿到响应。

---

### P2 — 观测 & 自愈层

#### 改进 H：给 scheduler 加心跳 & 看门狗（对应 R15）

**方案**

1. 每次 `schedulerTick` 开始/结束都更新两个时间戳：`lastTickStartedAt`、`lastTickEndedAt`；定期 upsert 到 `project_config`，方便 `status` 命令查看
2. 新增 `src/engine/watchdog.ts`：

```ts
let stuckCount = 0;

export function startWatchdog(onStuck: () => Promise<void>) {
  return setInterval(async () => {
    if (lastTickEndedAt === 0) return;
    const sinceTick = Date.now() - lastTickEndedAt;
    if (sinceTick > WATCHDOG_STUCK_MS) {
      logger.error({ sinceTick }, 'watchdog: scheduler stuck');
      insert('logs', { role: Role.SYS, action: 'watchdog_stuck', ... });
      stuckCount++;
      if (stuckCount === 1) {
        await abortCurrentDispatch();         // 第一次：软中断
      } else if (stuckCount === 2) {
        await restartOpencodeServer(...);     // 第二次：重启 server
      } else {
        process.exit(1);                     // 第三次：退出，交给 supervisor
      }
    } else {
      stuckCount = 0;
    }
  }, 60_000);
}
```

3. 阈值设计：`WATCHDOG_STUCK_MS = dispatchTimeoutMs + 120s`（默认 12 分钟），保证正常 dispatch 不会触发
4. 重启 server 期间设置 `isServerRestarting = true`，看门狗检测到标志时推迟判断

**影响文件**：`src/engine/scheduler.ts`、新增 `src/engine/watchdog.ts`、`src/cli/engine.ts`

**验收**：在 dispatch 过程中手动 `kill -STOP` opencode server 进程，看门狗在 12 分钟内报警并执行恢复动作。

---

#### 改进 I：`status` 命令暴露引擎活跃度（对应 R15）

**方案**：`src/cli/status.ts` 追加输出

```
上次 tick 开始 / 结束：2026-04-21 10:11:22 / 10:11:22  （空闲 3s）
当前 dispatch：DEV (session: ses_xxx, taskId: 12, 已运行 45s)
最近 5 次 dispatch：PM (1.2s) ✓ / DEV (32.1s) ✓ / DEV (60.0s) ✗ timeout / ...
重试中消息：msg#41 attempts=2, msg#44 attempts=1
```

**影响文件**：`src/cli/status.ts`、`src/engine/scheduler.ts`（暴露只读 getter）

---

#### 改进 J：getTaskSession 原子化（对应 R13）

**方案**：先创建再替换——创建失败时旧映射不受影响：

```ts
async getTaskSession(taskId: number, role: Role.DEV): Promise<string> {
  const key = `${taskId}-${role}`;
  const prev = this.taskSessions.get(key);
  const newSessionId = await createRoleSession(this.client, this.sessionPrefix, this.workspace, role);
  this.taskSessions.set(key, newSessionId);
  this.persist();
  if (prev) {
    this.client.session.delete({ path: { id: prev } }).catch(() => {/* ignore */});
  }
  return newSessionId;
}
```

**影响文件**：`src/engine/session-manager.ts`

**验收**：模拟 create 抛错时 `taskSessions` 保留旧值。

---

### P3 — 细节优化

#### 改进 K：sqlite busy 的显式处理（对应 R14）

- `repository.ts` 的 rawRun/withTransaction 若抛 `SQLITE_BUSY`，**重试 3 次**（间隔 200/400/800ms）后再 throw
- 缓解 `talk` / CLI 与 engine 竞争写锁时偶发超时

**影响文件**：`src/db/repository.ts`

---

#### 改进 L：把 `console.log` 散落的"⚠️"提示迁移到 logger

- 现状 `session-store.ts`、`session-manager.ts`、`retry.ts` 还在用 `console.log`，与 `logger` 并存，导致问题难排查
- 统一改为 `logger.warn` / `logger.error`

**影响文件**：`src/engine/session-store.ts`、`src/engine/session-manager.ts`、`src/engine/retry.ts`

---

## 3. 对两版原始方案中错误判断的修正

| 原始判断 | 修正说明 |
|----------|----------|
| Opus R16 "finally 之前异常抛出可能导致 busy 泄漏" | **推翻**：JavaScript `finally` 保证执行。`scheduler-dispatch.ts:224-227` 中 `setBusy(role, false)` 位于 finally 最前面，不会被跳过。此改进项取消。 |
| Opus R6 "健康检查失败后永久挂起" | **修正**：实际代码 `return` 仅跳过当前 tick，`while(running)` loop 继续跑，下次 tick 还会重新检查健康。但若 server 不自愈，loop 会无限空转——更准确的描述是"无限空转但不重启"，而非"永久挂起"。 |
| GLM #1 "调度循环阻塞"行号引用 `scheduler.ts:76` | **修正**：真正的 1 小时超时在 `dispatcher.ts:136`（`dispatchTimeoutMs ?? 60*60*1000`），`scheduler.ts:76` 只是 sleep 间隔。 |
| GLM #7 "降低超时"应修改 `config/index.ts` | **修正**：`config/index.ts` 只定义了接口和注释，默认值 fallback 在 `dispatcher.ts:136`。两处都需要改：config 注释更新 + dispatcher fallback 值更新。 |
| GLM 改进项一用 `AbortSignal.any` 包装 dispatch 超时 | **不采用**：这是在已有 `withTimeout` 之上再加一层超时，冗余且不治本。正确做法是（1）降低 `dispatchTimeoutMs` 默认值、（2）把 signal 传到 HTTP 层让 timeout 真正中断连接、（3）修复 AbortError 处理逻辑。根因解决后不需要外层包装。 |
| GLM 改进项三不区分可重试 / 不可重试错误 | **不采用**：所有失败统一计入 `retry_count` 会导致业务逻辑错误也被重试 3 次（浪费 LLM 调用且无意义）。应采用 Opus 方案的 `isRetryableDispatchError` 分类。 |
| GLM 改进项四看门狗只记日志不采取行动 | **不采用**：纯日志型看门狗无法自愈，运维仍需人工介入。应采用分级行动（软中断 → 重启 server → 退出进程）。 |
| GLM 改进项三冲突四建议"重试时递增超时" | **不采用**：递增超时会让重试等待更久，延长故障恢复时间。正确做法是 per-message 退避（延迟重试而非延长单次超时），保持每次 dispatch 超时不变。 |

---

## 4. 改进项之间的冲突协调

| 关联 | 冲突描述 | 协调方案 |
|------|----------|----------|
| A × B | A 让 AbortError 不再 break loop；B 让 abort 真能中断 HTTP | 统一设计：`abortCurrentDispatch` = 取消当前 dispatch；scheduler 感知到 AbortError 就跳过本轮继续 tick |
| B × D | B 让 timeout/abort 更频繁触发；D 如果全部把 AbortError 视作"可重试"，会让瞬时重启 server 后立刻重放消息 | D 的重试加 **per-message 退避**（30s/60s/120s），避免密集重放；同时由 `stopSchedulerLoop` 触发的 AbortError（shutdown）不再走重试逻辑 |
| C × H | C 把默认超时降到 10 分钟；H 的看门狗阈值需要 > C 的值 | `WATCHDOG_STUCK_MS = dispatchTimeoutMs + 120s`；两者都从 config 读取，保证联动 |
| E × H | server 重启会让 scheduler 暂停一小段时间；这段时间可能被看门狗误判 | 重启流程中设置 `isServerRestarting = true`，看门狗检测到标志时推迟判断 |
| F × E | session 初始化失败会直接让引擎退出；但 E 可以让 server 重启 | 初始化阶段发生 server 不可达 → 尝试 E 的重启；重启后仍失败 → 按 F 报错退出（让 supervisor 或用户介入） |
| G × D | embedding 超时被归类为可重试错误，可能让同一消息反复在 embedding 环节卡住 | 现有 try/catch 已经让 embedding 失败不向外抛；dispatch 内层 embedding 失败不算作整个 dispatch 的失败，不影响重试计数 |
| J × F | J 让旧 session 保留到新 session 成功；F 在 create 失败时会抛错 | J 的兜底：抛错后旧映射未被替换，下次 dispatch 直接复用旧 session；F 的重试交由上层（scheduler catch → 下次 tick 再尝试） |

---

## 5. 实施优先级与验收

| 优先级 | 改进 | 主要解决的根因 | 预期收益 |
|--------|------|----------------|----------|
| **P0** | A | R5 | 调度循环永不因 abort 而整体退出（**最核心**） |
| **P0** | B | R1, R2 | abort/timeout 真正切断 HTTP 连接 |
| **P0** | C | R3, R8, R10, R12 | 所有 prompt 类调用都有合理超时 |
| **P0** | D | R4 | 瞬时失败不再让消息永久丢失 |
| **P1** | E | R6, R7 | server 崩溃后自动恢复 |
| **P1** | F | R8, R9, R10 | session 初始化明确成败 |
| **P1** | G | R11 | embedding 不会拖垮 dispatch |
| **P2** | H | R15 | 看门狗 / 自愈 |
| **P2** | I | R15 | 可观测 |
| **P2** | J | R13 | session 映射原子化 |
| **P3** | K | R14 | 并发写冲突缓解 |
| **P3** | L | — | 日志归一 |

### 端到端验收场景

1. **LLM 卡住**：mock `session.prompt` 永不 resolve → 10 分钟后 dispatch 自动超时 → 消息进入重试 → 下一轮 tick 派发其他角色不受影响
2. **Opencode server 崩溃**：kill server 进程 → 健康检查 3 次失败 → 引擎自动启动新 server → 调度恢复
3. **手动 abort**：`ctrl+c talk` 期间用户主动 abort → 当前 dispatch 在 500ms 内停止 → scheduler 继续 tick
4. **session 初始化网络抖动**：第一次 bind prompt 超时 → 自动重试 → 第二次成功 → 引擎正常启动
5. **Embedding 服务 outage**：关掉 OpenAI / 把模型目录改名 → embedding 调用 30s 超时 → dispatch 继续完成（无 knowledge 注入）
6. **持续卡死**：mock `session.list()` 永不响应 → 看门狗在 12 分钟内发出 `watchdog_stuck` 日志并执行 server 重启

### 回归测试增量

- `src/engine/__tests__/retry.test.ts`：补充"外部 signal 触发时 fn 正在运行"的用例
- `src/engine/__tests__/scheduler.test.ts`（新增）：AbortError 不杀主循环
- `src/engine/__tests__/scheduler-dispatch.test.ts`：瞬时失败后消息保持 unread 且 `dispatch_attempts` 递增
- `src/embedding/__tests__/openai.test.ts`：超时路径

---

## 6. 小结

"Session 突然停止"本质上是 **多根因叠加**：

1. HTTP 层中断失败（R1、R2）
2. 让手动 abort 或超时只能等 1 小时（R3）
3. 而手动 abort 一旦成功，又把主循环整个杀掉（R5）
4. 同时没有看门狗/健康自愈（R6、R15）
5. 更糟的是一旦 dispatch 因为瞬时错误失败，消息被标记为 read（R4）永远不再重试

**最优先必须落地的是 P0 的 A/B/C/D 四项**：只要这四项做完，"引擎突然静默"的主链路就被切断——单次 dispatch 出问题不会再拖垮整个系统，消息也不会被静默吞掉。P1/P2 是在此基础上提高自愈能力和可观测性，P3 是长期维护性改进。
