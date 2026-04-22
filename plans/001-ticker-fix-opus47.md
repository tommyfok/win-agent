# schedulerTick 缺陷修复计划

> 模型：claude-opus-4-7
> 范围：`src/engine/scheduler.ts`、`src/engine/scheduler-dispatch.ts`、`src/engine/pm-idle-monitor.ts`、`src/engine/dispatcher.ts`
> 关联调查：同目录下 `improve-sessions-opus47.md`（session 卡死类问题）。本计划聚焦 `schedulerTick` 及其派发链上的**逻辑错误**，不涉及"主动状态盘点"这种架构级重构。

---

## 0. 背景

在对 `schedulerTick`、`tryDispatchNormalRole`、`PmIdleMonitor.check`、`checkHealth` 的代码审查中发现 4 个功能性 bug（B1–B4）和 5 个代码风格/健壮性问题（S1–S5）。
Q4（多 task 消息错投 session）确认采用 **Option B：一个 tick 只派发一个 task group** 的方案。

本计划覆盖 B1 / B2 / B3 / B4 四个 bug 的修复，以及 S1 / S3 / S4 / S5 的顺手清理。S2（模块级单例过多）涉及较大重构，不在本期范围。

---

## 1. 改动清单

### B1：健康检查阈值触发后只跳过 1 个 tick

#### 问题

```106:123:src/engine/scheduler.ts
  if (Date.now() - lastHealthCheckAt > HEALTH_CHECK_INTERVAL_MS) {
    lastHealthCheckAt = Date.now();
    const healthy = await checkHealth(client);
    if (!healthy) {
      healthFailCount++;
      ...
      if (healthFailCount >= MAX_HEALTH_FAILURES) {
        logger.error('opencode server unreachable, suspending dispatch');
        return;
      }
    } else {
      ...
      healthFailCount = 0;
    }
  }

  checkAndUnblockDependencies();
  ...
  await tryDispatchNormalRole(...);
```

`return` 位于 "每 30s 才进一次的" 外层 if 内部。连续失败 3 次后 suspend 仅对那一 tick 生效；后续 30s 内每 1s 一次的 tick 不会再进健康检查块，会直接走到 `tryDispatchNormalRole`，"suspend dispatch" 名不副实。

期望行为（已与用户确认）：**server 不可达期间，每个 tick 都跳过 dispatch，直到一次成功的 health check 恢复**。

#### 修复

在 `schedulerTick` 顶部增加一个**无条件的早退判断**，放在健康检查块之后、其它动作之前：

```ts
async function schedulerTick(...) {
  if (Date.now() - lastHealthCheckAt > HEALTH_CHECK_INTERVAL_MS) {
    lastHealthCheckAt = Date.now();
    const healthy = await checkHealth(client);
    if (!healthy) {
      healthFailCount++;
      logger.error({ healthFailCount }, 'opencode server health check failed');
    } else {
      if (healthFailCount >= MAX_HEALTH_FAILURES) {
        logger.info('opencode server recovered, resuming dispatch');
      }
      healthFailCount = 0;
    }
  }

  if (healthFailCount >= MAX_HEALTH_FAILURES) {
    // 持续 suspend，直到下一次 health check 成功才清零
    return;
  }

  checkAndUnblockDependencies();
  promoteDeferredPmMessages(roleManager);
  pmIdleMonitor.check(roleManager, getPmLastDispatchEnd());

  await tryDispatchNormalRole(client, sessionManager, roleManager);
}
```

要点：
- 原来的 "达到阈值时 `return`" 逻辑去掉；判断统一由外部早退完成。
- 恢复日志移到"已处于 suspended 的情况下本次 probe 成功"的分支里，避免每次 probe 成功都打印。

#### 验收标准

- [ ] 模拟 opencode server 不可达（关停端口）持续 >90s，引擎日志中**每次 tick 都应跳过 dispatch**，而不是只在 30s 边界的那一 tick 跳过。
- [ ] server 恢复后，下一次 health check 成功时打印一条 "recovered, resuming dispatch" 并立刻恢复派发。
- [ ] 单元 / 集成测试：构造 `checkHealth` 返回 false 的 stub，连续调用 `schedulerTick` 3+ 次，验证第 3 次之后所有 tick 均未调用 `tryDispatchNormalRole`。

---

### B2：dispatch 失败粗暴把该角色全部未读消息标为 Read

#### 问题

```209:223:src/engine/scheduler-dispatch.ts
    } catch (err) {
      if (err instanceof AbortError) throw err;
      logger.error(
        { role, messageCount: messages.length, err },
        'dispatch failed — messages marked read to prevent replay'
      );
      for (const msg of messages) {
        update('messages', { id: msg.id }, { status: MessageStatus.Read });
      }
      insert('logs', { ... });
    }
```

一次 LLM/网络瞬时失败就会吞掉该角色所有未读消息（可能 10+ 条，跨多个 task），且之后无法再被重试。期望（已与用户确认）：**保留消息为 Unread，做重试次数记录 + 退避**，多次失败之后才降级。

Option B 选定后，一次派发只包含 "同一个 task group"，事故半径天然变小。

#### 修复

##### Schema 变更（`src/db/migrations/`）

在 `messages` 表上新增两列：

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `retry_count` | INTEGER | 0 | 累计投递失败次数 |
| `last_retry_at` | INTEGER | NULL | 最近一次失败的 epoch ms，用于退避 |

##### `MessageRow` / `MessageStatus` 更新

- `src/engine/dispatcher.ts` 中 `MessageRow` 类型扩展 `retry_count`、`last_retry_at` 字段。
- 新增常量 `MAX_DISPATCH_RETRIES = 3`（放入 `src/engine/scheduler-dispatch.ts` 或 config）。
- 新增常量 `DISPATCH_BACKOFF_MS = 30_000`。

##### `tryDispatchNormalRole` 的 `catch` 分支

```ts
} catch (err) {
  if (err instanceof AbortError) throw err;

  const now = Date.now();
  for (const msg of messages) {
    const next = (msg.retry_count ?? 0) + 1;
    if (next >= MAX_DISPATCH_RETRIES) {
      update('messages', { id: msg.id }, {
        status: MessageStatus.Read,   // 到达上限,降级为 Read 防止死循环
        retry_count: next,
        last_retry_at: now,
      });
    } else {
      update('messages', { id: msg.id }, {
        // 状态仍保持 Unread,由 select 时的 backoff 过滤决定是否再取
        retry_count: next,
        last_retry_at: now,
      });
    }
  }

  insert('logs', {
    role: Role.SYS,
    action: 'dispatch_failed',
    content: `${role} dispatch failed (group=${dispatchTaskId ?? 'none'}), batch=${messages.length}: ${String(err).slice(0, 200)}`,
    related_task_id: dispatchTaskId,
  });
}
```

##### 取未读时过滤退避

在 `tryDispatchNormalRole` 取消息的 select 中加 `last_retry_at IS NULL OR last_retry_at < ?` 条件：

```ts
const cutoff = Date.now() - DISPATCH_BACKOFF_MS;
const messages = rawQuery<MessageRow>(
  `SELECT * FROM messages
   WHERE to_role = ? AND status = ?
     AND (last_retry_at IS NULL OR last_retry_at < ?)
   ORDER BY created_at ASC`,
  [role, MessageStatus.Unread, cutoff]
);
```

（使用 rawQuery 是因为现有 `select` 帮助函数不支持这种 OR 条件；保持简洁即可。）

##### 成功时清零

`dispatchToRole` 成功后，`dispatcher.ts` 在把消息标为 Read 之前已经成功处理，不必再重置 `retry_count`（反正 Read 之后不会被再取）。**无需额外改动**。

#### 验收标准

- [ ] Migration 成功落库，旧数据 `retry_count` 默认 0、`last_retry_at` 默认 NULL。
- [ ] 给定 1 条未读消息，模拟 `dispatchToRole` 连续 3 次抛错：第 1、2 次消息仍为 Unread 且 `retry_count` 递增、`last_retry_at` 更新；第 3 次被降级为 Read。
- [ ] 第 1 次失败后，紧接着在 30s 内触发下一个 tick，该消息**不会被再次取出**派发（被 backoff 过滤）；30s 过后才重试。
- [ ] `logs` 表中 `dispatch_failed` 记录包含 `group=<taskId>` 字段，便于多 task 情况下追溯。

---

### B3：DEV 跨 task 消息被送进同一 session（Option B）

#### 问题

`tryDispatchNormalRole` 取出该角色**所有**未读消息后直接调 `dispatchToRole`（单数），而后者依赖"一批消息 = 一个 task"的前提（`getSessionForRole` 对 DEV 只使用第一条消息的 `related_task_id` 去选 session）。后果：

1. DEV 对 task A 和 task B 的消息被塞进 task A 的 session。
2. `currentDispatch.taskId` 只记了第一条，abort/resume 丢失其它 task 上下文。
3. `dispatchToRoleGrouped` 在代码里被定义但没人调用（死代码）。

#### 修复（Option B：一个 tick 只派发一个 group）

##### `tryDispatchNormalRole` 的消息筛选

取完未读消息后，按第一条消息的 `related_task_id` 过滤出同一 group，剩余留给下一个 tick：

```ts
const messages = rawQuery<MessageRow>(...); // 见 B2,已带 backoff
if (messages.length === 0) continue;

const groupTaskId = messages[0].related_task_id; // number | null
const batch = messages.filter((m) => m.related_task_id === groupTaskId);

logger.info(
  { role, groupTaskId, batchSize: batch.length, totalUnread: messages.length },
  'dispatch start'
);

// 后续一律使用 batch
roleManager.setBusy(role, true);
...
const dispatchTaskId = groupTaskId; // 不再用 find()
currentDispatch = { role, taskId: dispatchTaskId, sessionId: null, startedAt: ... };

try {
  const { sessionId, inputTokens, outputTokens } = await dispatchToRole(
    client, sessionManager, role, batch, { ... }
  );
  ...
} catch (err) {
  ...
  for (const msg of batch) { /* B2 的 retry 更新 */ }
}
```

##### 死代码处理

`dispatchToRoleGrouped` 明确不在本轮计划中启用，把它标 `@deprecated` + `@internal` 注释并从 `index.ts` 移除 re-export（若存在），或者直接删除。**本次计划采取"删除"**，避免误导后来人：

- `src/engine/dispatcher.ts` 删除 `dispatchToRoleGrouped` 定义。
- 若有 `export` 引用，一并清理。

##### `dispatchToRole` 内部清理（可选但推荐）

`getSessionForRole` 里对 DEV 的 `messages.find((m) => m.related_task_id)?.related_task_id` 改为断言 "全部消息的 `related_task_id` 必须一致"：

```ts
.with(Role.DEV, (devRole) => {
  const taskIds = new Set(messages.map((m) => m.related_task_id));
  if (taskIds.size > 1) {
    throw new Error(
      `dispatchToRole received messages from multiple tasks: ${[...taskIds].join(',')}`
    );
  }
  const taskId = messages[0].related_task_id;
  ...
})
```

这是一条"防御性护栏"，防止将来又有人把跨 task 的 batch 灌进来。

#### 验收标准

- [ ] 构造 DEV 有 3 条未读消息，分别关联 task 1、task 1、task 2。调用 `schedulerTick` 一次：
  - task 1 的 2 条被派发（送入 task 1 的 DEV session）。
  - task 2 的 1 条**仍为 Unread**，下一个 tick 才派发到 task 2 的 session。
- [ ] `currentDispatch.taskId` 等于本 group 的 task id，若中途 abort 并写入 `interrupted.json`，恢复时 `session-store.ts` 的 `taskSessions.set(\`${taskId}-DEV\`, ...)` 键值正确。
- [ ] `getSessionForRole` 对 DEV 收到跨 task batch 时抛错（单测覆盖）。
- [ ] `dispatchToRoleGrouped` 已从代码库中移除，`rg dispatchToRoleGrouped src/` 无结果。

---

### B4：PmIdleMonitor 对 DEV 的前置条件写反

#### 问题

```67:72:src/engine/pm-idle-monitor.ts
  const devBusy = roleManager.isBusy(Role.DEV);
  const devLastActive = getDevLastDispatchEnd();
  const devIdleMs = now - devLastActive;
  if (devBusy && devIdleMs < this.getPmIdleThresholdMs()) return;
```

注释意图："DEV 忙 或 DEV 最近活跃过 → 不打扰 PM"。实际真值表：

| devBusy | devIdleMs < threshold | 期望 | 当前 |
|---|---|---|---|
| true | true | 不提醒 | ✅ return |
| true | false（DEV 长时间在跑）| 不提醒 | ❌ 错发 |
| false | true（DEV 刚干完）| 不提醒 | ❌ 错发 |
| false | false | 提醒 | ✅ 通过 |

#### 修复

```ts
if (devBusy || devIdleMs < this.getPmIdleThresholdMs()) return;
```

即 **`&&` 改为 `||`**。附带把注释与代码对齐：

```ts
// DEV 正在忙 或 DEV 最近 < 阈值 内有过派发 → 不打扰 PM
```

#### 验收标准

- [ ] 单测覆盖上表 4 种组合，行为与"期望"列一致。
- [ ] 在集成环境下：让 PM 空闲 > 10 分钟、DEV 正在处理一个长任务（busy=true 但 devLastDispatchEnd 早于 10 分钟），验证**不会**收到 PM idle 提醒。

---

### S1：`PmIdleMonitor.resetReminder` 无人调用

定义存在但无调用方，导致 PM 刚处理完提醒又空闲时提醒节流窗口继续生效。

#### 修复

两选一：

- **推荐**：在 `tryDispatchNormalRole` 中，当 `role === Role.PM` 且 dispatch 成功的 finally 分支里调用 `pmIdleMonitor.resetReminder()`。但这要求 `pmIdleMonitor` 实例穿透到 dispatch 层——代价是要给 `tryDispatchNormalRole` 增加 `pmIdleMonitor` 参数（目前只传到 `schedulerTick`）。
- **兜底**：直接删除 `resetReminder`，由"每 10 分钟一个节流窗口"这一默认行为兜着。语义上 PM 处理后再空闲是从 10 分钟计起，符合直觉。

本计划采用**推荐方案**：把 `pmIdleMonitor` 注入到 `tryDispatchNormalRole`。

#### 验收标准

- [ ] PM 被 dispatch 并成功完成后，再次空闲超过阈值时**立刻**（而非需等 10 分钟窗口）可以发出新提醒。

---

### S3：`promoteDeferredTriggers` 命名 + 拼接 SQL

#### 修复

- 更名为 `promoteDeferredPmMessages`（包括 `scheduler.ts` 调用处）。
- SQL 改用 repository 的 `update` + 条件查询：

```ts
rawRun(
  `UPDATE messages SET status = ? WHERE status = ? AND to_role = ?`,
  [MessageStatus.Unread, MessageStatus.Deferred, Role.PM]
);
```

（若 `rawRun` 不支持参数化，改用 `update` 辅以 `rawQuery` 获取 id 列表后批量更新；但推荐把 `rawRun` 扩展成支持参数，这是更广泛的好事——超出本计划则退回最小改动：保留拼接，仅改名。）

#### 验收标准

- [ ] 全仓 `rg promoteDeferredTriggers` 无结果。
- [ ] 行为与修改前完全一致（现有集成测试保持绿）。

---

### S4：AbortError 路径下 `finally` 更新完成时间戳

```224:235:src/engine/scheduler-dispatch.ts
    } finally {
      currentDispatch = null;
      currentAbortController = null;
      roleManager.setBusy(role, false);
      lastDispatchedRole = role;
      if (role === Role.PM) {
        pmLastDispatchEnd = Date.now();
      } else if (role === Role.DEV) {
        devLastDispatchEnd = Date.now();
      }
      saveDispatchState();
    }
```

AbortError 是主动中断，不应被视为"一次成功的完成"。否则 PM cooldown / idle monitor 的基线会被污染（例如用户 abort 之后的 3s 内 PM 又有新消息，会被 cooldown 挡掉）。

#### 修复

引入一个 `completedNormally` 标志：

```ts
let completedNormally = false;
try {
  ...
  completedNormally = true;
} catch (err) {
  if (err instanceof AbortError) throw err;
  ...
} finally {
  currentDispatch = null;
  currentAbortController = null;
  roleManager.setBusy(role, false);
  if (completedNormally) {
    lastDispatchedRole = role;
    if (role === Role.PM) pmLastDispatchEnd = Date.now();
    else if (role === Role.DEV) devLastDispatchEnd = Date.now();
    saveDispatchState();
  }
}
```

失败路径下（B2 场景）仍然更新时间戳？讨论：失败也算"尝试过"，cooldown 应该生效，防止立即重试打死 LLM。折中方案：

```ts
finally {
  ...
  if (completedNormally || caughtNonAbortError) {
    // 更新 cooldown 基准
    ...
  }
}
```

**本计划采用简化版**：AbortError 路径不更新（当前目标）；非 Abort 的其它错误保持现有行为（更新 cooldown）。实现上只需在 catch 前设 `completedNormally = true`，AbortError 的 throw 发生在 catch 里——会绕过 `completedNormally = true`，但也会绕过 "非 Abort 的处理"。需要：

```ts
let completedNormally = false;
try {
  ...
  completedNormally = true;
} catch (err) {
  if (err instanceof AbortError) {
    // 不更新 cooldown,直接抛出让上层处理
    throw err;
  }
  // 其他错误仍然算 "已尝试",更新 cooldown
  completedNormally = true;
  ... // B2 的 retry 逻辑
}
```

#### 验收标准

- [ ] 单测：调用 `tryDispatchNormalRole` 过程中外部触发 abort，`pmLastDispatchEnd` / `devLastDispatchEnd` 保持 abort 前的值；`lastDispatchedRole` 同理。
- [ ] 单测：dispatch 非 Abort 错误，cooldown 基准被更新（防止立即重试）。

---

### S5：`// V1: only one role per tick` 注释修正

纯注释修改：

```ts
break; // V1: at most one dispatch per tick
```

#### 验收标准

- [ ] 代码审核通过。

---

## 2. 落地顺序

按相互依赖关系与收益/风险比：

1. **第一轮（纯代码、零 schema 改动）**
   - B1（health check suspend）
   - B4（PmIdleMonitor 条件写反）
   - S5（注释修正）
   - S3（命名 + SQL 清理）

   这一轮 PR 可独立验证、独立合并。

2. **第二轮（Option B 落地）**
   - B3（按 task group 切片派发 + 删死代码 + DEV 防御性断言）
   - S4（AbortError 不更新 cooldown）
   - S1（`resetReminder` 接入 dispatch 成功路径）

3. **第三轮（schema 变更）**
   - B2（`retry_count` + `last_retry_at` + backoff 过滤）

把 schema 变更放最后，是为了前两轮如需回滚不会牵涉 migration 回退。

---

## 3. 总体验收（E2E）

在所有改动合并后：

- [ ] 全套现有单测 / 集成测试保持绿。
- [ ] 冷启动 → 注入若干跨 task 的 DEV 未读消息 + 一条 PM 未读消息，连续 tick 直至全部消费：
  - 每个 tick 最多派发一个 task group；
  - DEV 各 task session 隔离正确（通过 `sessionManager` 的 `taskSessions` map 检查）；
  - PM 消息处理后 `resetReminder` 生效。
- [ ] 关停 opencode server 90s：日志显示 suspended 状态持续每 tick 打印一次（或只打一次 + 心跳）；恢复后自动继续派发。
- [ ] 制造一次 LLM 瞬时错误：消息保持 Unread、`retry_count=1`，30s 内不再投递；30s 后重试；连续 3 次失败后降级 Read。
- [ ] 在 dispatch 进行中发送 abort：`pmLastDispatchEnd` 不因本次 abort 更新，下一次真正 dispatch 成功后才更新。
- [ ] 覆盖 PmIdleMonitor 的 4 种 (DEV busy × 最近活跃度) 组合，行为与期望真值表一致。

---

## 4. 不在本期范围

- S2：`scheduler.ts` / `scheduler-dispatch.ts` 的模块级可变单例。需要把状态打包成 `SchedulerState` 并改造 `startSchedulerLoop` 生命周期，独立一期。
- 产品视角的**主动状态盘点**（查询 opencode session 真实状态 → 结合 DB 未完成事务 → 主动 dispatch）：这条路径本质上会让 `PmIdleMonitor` 变成一个更通用的 stall detector，是架构级重构，放到后续 RFC。
- 并发派发 / 多 worker：当前仍是 V1 串行，不在修复范围。
