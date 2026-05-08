# DEV Session Prompt Hardening

日期：2026-05-08

## 背景

win-agent 会在少数情况下直接调用 opencode，将 prompt 发进 DEV session，例如正常消息派发、session 初始化、停滞保活、引擎重启恢复和记忆写入。这些入口本身是合理的，但原实现存在几个风险：

- DEV 停滞保活可能在 session 仍 busy 时插入 `继续` prompt。
- 引擎重启恢复 prompt 过于宽泛，可能导致重复提交、重复改状态或重复发送验收报告。
- 任务型 DEV 消息缺少 `related_task_id` 时会落入 fallback session，破坏 task-scoped session 隔离。
- DEV 的 context rotation 能力已有实现，但正常 dispatch 后没有接线。

## 目标

本次改动目标是收紧“真正打进 DEV session 的 prompt”边界：

- 避免对仍在工作的 DEV session 插话。
- 保持 DEV session 按 task 隔离，防止普通任务指令污染 fallback session。
- 让重启恢复流程具备幂等意识。
- 让长任务 DEV session 也能触发 context rotation。

## 改动概览

### 1. 收紧 DEV 停滞保活

文件：`src/engine/dev-session-nudger.ts`

改动：

- 将保活 prompt 从单字 `继续` 改为更安全的恢复提示：

  ```text
  如果你仍在处理当前任务，请不要重复执行已完成动作。请先检查当前状态、最近命令结果和任务状态，然后从未完成处继续。
  ```

- 发保活前先检查 `session.status()`；如果目标 session 是 `busy` 或 `retry`，不发送保活 prompt。
- 检查最近消息中是否存在未完成 assistant 消息或未结束 part；如果有，不发送保活 prompt。
- 单次 DEV dispatch monitor 最多发送一次 nudge，避免长 dispatch 中多次插入提示。

预期效果：

- 保留“DEV 卡住后轻推一下”的自愈能力。
- 降低 busy session 被重复插入 prompt 的风险。

### 2. 限制 DEV fallback session

文件：`src/engine/dispatcher.ts`

改动：

- 对以下任务型 DEV 消息强制要求 `related_task_id`：
  - `directive`
  - `feedback`
  - `cancel_task`
  - `notification`
- 如果这类消息缺少 `related_task_id`：
  - 将原消息标记为 `read`。
  - 写入 `dev_message_missing_task` 日志。
  - 发送一条 `SYS -> PM` system 消息，提醒 PM 重新创建带 task 关联的消息。
- 仍允许真正全局的 DEV 消息使用 fallback session，例如 `reflection`。

预期效果：

- 普通任务指令不再混入 `-1-DEV` fallback session。
- 错误数据会显式暴露给 PM，而不是静默污染 DEV 上下文。

### 3. 接上 DEV context rotation

文件：`src/engine/scheduler-dispatch.ts`

改动：

- dispatch 成功后，`checkAndRotate()` 不再只对 PM 调用，也会对 DEV 调用。
- DEV rotation 会传入当前 `dispatchTaskId`，让 `rotateSession()` 更新正确的 `taskId-DEV` session 映射。
- PM rotation 不再传 task id，避免 PM session 被误写入 task session map。

预期效果：

- 长任务 DEV session 在上下文压力过高时可以轮转。
- DEV 轮转后仍保留 task-scoped session 映射语义。

### 4. 恢复中断 prompt 幂等化

文件：`src/engine/session-store.ts`

改动：

- 引擎重启恢复 interrupted session 时，不再只要求“继续完成未完成工作”。
- 新 prompt 明确要求先检查：
  - `git status`
  - 最近提交
  - 当前任务状态
  - 最近 `messages / role_outputs / logs`
- 明确要求只继续未完成部分，避免重复提交、重复改状态、重复发送验收报告。

预期效果：

- 降低 engine restart 后 DEV 重复执行收尾动作的概率。
- 恢复行为更适合长期自动化运行。

## 测试覆盖

新增或更新的测试：

- `src/engine/__tests__/dispatcher.test.ts`
  - 缺少 `related_task_id` 的 task-bound DEV 消息不会进入 fallback session。
  - 全局 `reflection` 消息仍可使用 fallback session。
- `src/engine/__tests__/dev-session-nudger.test.ts`
  - busy session 不会收到 nudge。
  - 未完成 assistant work 不会收到 nudge。
  - 单次 DEV dispatch monitor 最多 nudge 一次。
  - 安全版 continue prompt 被发送。
- `src/engine/__tests__/scheduler-dispatch.test.ts`
  - DEV dispatch 成功后会调用 `checkAndRotate()`，并传入 task id。
- `src/engine/__tests__/session-store.test.ts`
  - DEV interrupted session 恢复时发送幂等恢复 prompt。

验证命令：

```bash
pnpm exec tsc --noEmit
pnpm test
```

验证结果：

- TypeScript 类型检查通过。
- 全量测试通过：159 tests passed。

## 后续观察点

- 继续观察 opencode 对 busy session 的 `promptAsync` 行为。如果未来 API 明确提供更细粒度的 session 状态，可以进一步替换当前的保守判断。
- 如果出现合法的 `notification` 不带 task id 且确实需要发给 DEV，应将其改为 `system` 或补充明确的全局消息类型，而不是放宽 task-bound 类型。
