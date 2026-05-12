# Agent Runtime Hardening Plan

日期：2026-05-12

## 背景

当前 `win-agent` 的核心设计方向是合理的：PM/DEV 角色分工清楚，任务、消息、依赖、会话和记忆都有持久化模型。下一步最值得补强的不是继续增加 Agent 能力，而是提高长运行调度系统的可解释性、可追踪性和协议稳定性。

本计划聚焦三件事：

1. 为自动触发、dispatch、状态变更加 trace id。
2. 为 PM/DEV 通信建立轻量结构化协议。
3. 增强 `win-agent status`，提供 scheduler 可解释视图。

## 目标一：Trace ID 与审计链路

### 目标

让每一次自动触发、消息派发、任务状态变更都能被串起来复盘，回答这些问题：

- 是哪个触发器生成了这条系统消息？
- 这次 dispatch 处理了哪些 message？
- dispatch 对应哪个 role、task、session？
- 任务状态变化是由哪次 dispatch 或 auto-trigger 间接导致的？

### 建议实现

- 新增 trace 工具模块，例如 `src/engine/trace.ts`。
- 生成统一格式的 trace id，例如 `dispatch_xxx`、`trigger_xxx`。
- 在 dispatch 生命周期中保存当前 trace：
  - logger child context 带 `traceId`
  - `logs.trace_id`
  - `role_outputs.trace_id`
  - 必要时将当前 dispatch trace 临时写入 `project_config`
- 自动触发器写入系统消息时，在 `messages.attachments` 中带 trace 元信息。
- 任务状态变更写入 `task_events.trace_id`，或在兼容方案中把 trace 写入 reason 前缀。

### 涉及文件

- `src/engine/scheduler-dispatch.ts`
- `src/engine/dispatcher.ts`
- `src/engine/auto-trigger.ts`
- `src/db/schema.ts`
- `src/db/state-machine.ts`
- `src/db/__tests__/test-helpers.ts`

### 验收标准

- 新建库和旧库 migration 都支持 trace 字段。
- dispatch 成功和失败日志都能查到 trace id。
- auto-trigger 生成的消息和日志能通过 trace id 对齐。
- task event 能记录触发它的 trace id。

## 目标二：PM/DEV 结构化通信协议

### 目标

减少依赖自然语言解析推进任务状态的脆弱性。保留 `content` 给人读，同时在 `messages.attachments` 中写入机器可读 payload。

### 建议协议

统一使用：

```json
{
  "protocol": "win-agent.message.v1",
  "type": "directive",
  "task_id": 123,
  "iteration_id": 1
}
```

建议覆盖的类型：

- `directive`：PM 派发任务给 DEV。
- `feedback`：补充说明、阻塞反馈、技术方案回复。
- `review_result`：DEV 提交验收结果，或 PM 给出验收结论。
- `cancel_task`：取消任务。
- `system`：系统触发类消息，如 plan request、auto-trigger notice。

### 建议实现

- 新增 `src/engine/message-protocol.ts`。
- 提供 parse/validate/format helper。
- `prompt-builder` 在展示消息时解析 `attachments`，把结构化字段展示给 Agent。
- 更新 PM/DEV role prompt 示例，要求关键消息必须带 `attachments: JSON.stringify(...)`。
- 保持兼容：旧消息没有 attachments 时仍按原自然语言流程处理。

### 涉及文件

- `src/engine/message-protocol.ts`
- `src/engine/prompt-builder.ts`
- `src/templates/roles/PM.md`
- `src/templates/roles/PM-reference.md`
- `src/templates/roles/PM-task-handling.md`
- `src/templates/roles/DEV.md`
- `src/templates/roles/DEV-reference.md`
- 可选：`src/workspace/database-tool.template.ts`

### 验收标准

- prompt 中能清晰展示结构化 payload。
- PM/DEV 模板中的关键 `database_insert(messages)` 示例都带 attachments。
- 没有 attachments 的旧消息不报错、不丢失。
- message protocol helper 有单测覆盖合法和非法 payload。

## 目标三：Scheduler 可解释状态页

### 目标

增强 `win-agent status`，让用户不只看到“运行中”，还知道系统为什么这么运行：

- 当前谁在忙？
- 有没有正在 dispatching 的消息？
- 哪些角色有 unread/deferred 消息？
- PM 是否处于 cooldown？
- 哪些任务因依赖阻塞？
- 下一个自动触发可能是什么？
- 最近发生过哪些 dispatch 或 auto-trigger？

### 建议实现

- 新增只读快照模块，例如 `src/cli/status-explain.ts`。
- `src/cli/status.ts` 调用该模块，输出简短的调度解释区块。
- 从现有表读取信息，不改变调度逻辑：
  - `messages`
  - `tasks`
  - `task_dependencies`
  - `iterations`
  - `project_config`
  - `logs`

### 建议输出内容

- 调度概览：
  - last dispatched role
  - current dispatch trace
  - PM cooldown 剩余时间
- 角色队列：
  - PM/DEV unread、deferred、dispatching 数量
- 当前处理中：
  - dispatching messages
  - related task/iteration
- 阻塞任务：
  - blocked task
  - 未完成依赖列表
- 自动触发候选：
  - 活跃迭代是否接近 all done
  - rejection rate 是否接近阈值
- 最近事件：
  - dispatch
  - dispatch_failed
  - auto_trigger

### 涉及文件

- `src/cli/status.ts`
- `src/cli/status-explain.ts`
- `src/cli/__tests__/status-explain.test.ts`

### 验收标准

- `win-agent status` 输出仍然简洁可读。
- 无任务、无消息、无活跃迭代时能正常输出。
- 有 blocked task、dispatching message、deferred PM message 时能解释原因。
- status 相关逻辑有单测，不依赖真实 daemon。

## 建议拆分

这三件事可以并行做，但需要明确写入边界：

- Worker A：Trace ID 与审计链路。
- Worker B：结构化通信协议。
- Worker C：Scheduler 可解释状态页。

合并顺序建议：

1. 先合并 Trace ID，因为 status 页面后续可以读取 trace。
2. 再合并结构化协议，因为它主要影响 prompt 和 attachments。
3. 最后合并 status 页面，把前两项新增的信息展示出来。

## 风险

- trace 字段如果直接加 schema，需要同时补 migration 和 test helper。
- `messages.attachments` 里可能已经有非协议 JSON，需要 parse 时保持宽容。
- status 页面不要变成日志瀑布，默认输出应控制长度。
- role prompt 不能只写“请结构化”，必须给出具体 `database_insert` 示例。

## 推荐验证

```bash
pnpm lint
pnpm test
pnpm build
```

如果时间有限，至少先跑：

```bash
pnpm test src/db/__tests__/state-machine.test.ts src/engine/__tests__/dispatcher.test.ts
pnpm test src/engine/__tests__/prompt-builder.test.ts
pnpm test src/cli/__tests__/status-explain.test.ts
```
