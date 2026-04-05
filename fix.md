# Win-Agent 问题修复清单

基于全链路代码审阅，按优先级排列。

---

## 严重问题

### F1. Workflow JSON 模板系统是死代码 `[已修复]`

**现状**：
- `new-feature.json`/`bug-fix.json`/`iteration-review.json` 定义了 phases、role_guide、completion 条件
- 但引擎的完成检查(`workflow-checker.ts`)全部硬编码，不读 JSON 的 completion 字段
- `checkPhaseAdvancement()` 只处理 iteration-review，new-feature/bug-fix 的阶段推进完全不存在
- `getWorkflowContext()` 注入的 role_guide 与角色 .md 文件高度重复
- 只有 3 个硬编码模板，没有用户自定义场景

**修复方案**：
- 删除 `.win-agent/workflows/` 目录和所有 JSON 模板
- 删除 `dispatcher.ts` 中的 `getWorkflowContext()` 函数和相关 prompt 注入
- 删除 `workspace/init.ts` 中 workflows 模板复制逻辑
- `workflow-checker.ts` 中移除 JSON 读取，保留硬编码逻辑（已是实际行为）
- `workflow_instances` 表保留（用于跟踪状态），但 `template` 字段语义变为纯标识符

**涉及文件**：
- `src/engine/dispatcher.ts` — 删除 getWorkflowContext
- `src/engine/workflow-checker.ts` — 移除 JSON 读取
- `src/workspace/init.ts` — 移除 workflows 模板复制
- `src/workspace/sync-agents.ts` — 检查是否有 workflows 引用
- `src/templates/workflows/*.json` — 删除
- 角色 .md 中的 workflow 引用 — 检查是否需要更新

---

### F2. new-feature/bug-fix 工作流从未被创建 `[已修复]`

**现状**：
- `auto-trigger.ts` 只创建 `iteration-review` 工作流
- 没有任何代码创建 `new-feature` 或 `bug-fix` 工作流实例
- PM 的角色 .md 也没有指导创建工作流
- `messages.related_workflow_id` 对这两类场景永远为空
- `getWorkflowContext()` 对它们永远返回 null

**修复方案**：
取决于 F1 的决策：
- 如果删除 workflow JSON（推荐）：这个问题自然消失。PM 直接按 .md 定义的流程行事，不需要 workflow_instances 来驱动 new-feature/bug-fix
- 如果保留 workflow 系统：需要让 PM 在方案设计时创建 workflow_instances，或由引擎在 PM 创建 tasks 时自动创建

**涉及文件**：同 F1

---

### F3. Sprint Contract 无引擎侧保障 `[已修复]`

**现状**：
- DEV.md 要求 `planning` 状态时输出计划并等待 QA 的 `plan_confirmed`
- QA.md 要求处理 `plan_review` 并回复 `plan_confirmed`
- 但引擎不检查 `plan_confirmed` 是否到达
- DEV 可以直接跳过协商将 status 改为 `in_dev`
- 完全依赖 LLM "自觉性"，无兜底

**修复方案**：
在 `database.ts` 工具的 update 函数中添加 guard：
```
if table === "tasks" && data.status === "in_dev" && current.status === "planning":
  检查 messages 表是否有 from_role=QA, to_role=DEV, type=plan_confirmed, related_task_id=taskId
  如果没有 → 拒绝更新，返回错误提示
```

**涉及文件**：
- `src/workspace/sync-agents.ts` — database tool 模板中添加 guard 逻辑

---

### F4. Reflection 消息缺少区分标识 `[已修复]`

**现状**：
- `workflow-checker.ts` 的 `sendReflectionTriggers()` 发送 `type: "system"` 消息
- PM 无法区分"反思触发"和普通系统消息
- 反思消息没有 `related_workflow_id`

**修复方案**：
- 反思消息使用 `type: "reflection"` 而非 `"system"`
- 携带 `related_workflow_id` 字段

**涉及文件**：
- `src/engine/workflow-checker.ts` — sendReflectionTriggers

---

## 中等问题

### F5. Session rotate 后 pendingContext 不持久 `[已修复]`

**现状**：
- `createRoleSession()` 将 role prompt + memories 存在内存 Map 中
- 如果 rotate 后引擎崩溃，新 session 没有身份上下文
- 角色会在"失忆"状态下工作

**修复方案**：
- 方案 A（简单）：rotate 时直接将 pendingContext 作为 session.prompt 的一部分发送，不存 Map
- 方案 B：将 pendingContext 持久化到 DB 或文件

**涉及文件**：
- `src/engine/session-manager.ts` — createRoleSession, rotateSession

---

### F6. 依赖循环无检测 `[已修复]`

**现状**：
- `dependency-checker.ts` 没有环检测
- task A depends_on B, B depends_on A → 两个任务永远 blocked
- PM 或用户通过 database_insert 添加依赖时无校验

**修复方案**：
- 在 `checkAndBlockUnmetDependencies()` 或 database tool 的 insert 中添加 DFS 环检测
- 发现环时拒绝添加依赖 / 发消息通知 PM

**涉及文件**：
- `src/engine/dependency-checker.ts`
- 或 `src/workspace/sync-agents.ts`（database tool 模板）

---

### F7. task_events 状态恢复逻辑脆弱 `[已修复]`

**现状**：
- `taskResume()` 和 `checkAndUnblockDependencies()` 都读取最近一条 event 的 `from_status` 来恢复
- 如果任务经历 `in_dev → blocked → unblocked(in_dev) → paused → resume`，恢复可能不正确
- 多次状态变更叠加时，"恢复到哪个状态"语义模糊

**修复方案**：
- 在 tasks 表添加 `pre_suspend_status` 字段，pause/block 时记录，resume/unblock 时读取并清空
- 比依赖 event 链回溯更可靠

**涉及文件**：
- `src/db/schema.ts` — tasks 表加字段
- `src/cli/task.ts` — taskPause/taskResume
- `src/engine/dependency-checker.ts` — block/unblock

---

### F8. dispatch 时 agent 参数的语义不确定 `[已修复]`

**现状**：
- 每次 `dispatchToRole()` 都传 `agent: role` 参数
- 不确定 opencode SDK 对同一 session 多次传 agent 参数的行为
- 可能导致 session 上下文混乱（如果每次都重新绑定 agent config）

**修复方案**：
- 确认 opencode SDK 行为：首次绑定后忽略 vs 每次重新绑定
- 如果每次重新绑定 → 只在首次 prompt 传 agent，后续省略
- 如果忽略 → 无需修改

**涉及文件**：
- `src/engine/dispatcher.ts`
- `src/engine/session-manager.ts`

---

### F9. PM 饿死 DEV/QA 风险 `[已修复]`

**现状**：
- Scheduler 每 tick 只 dispatch 一个角色
- User→PM 消息 bypass PM cooldown（3s）
- 用户持续发消息时，PM 不断被优先调度，DEV/QA 长时间得不到处理

**修复方案**：
- 添加 starvation 保护：连续 N 次 PM dispatch 后，强制轮到其他角色
- 或：每 tick 可以 dispatch 多个角色（PM + 一个 DEV/QA）

**涉及文件**：
- `src/engine/scheduler.ts`

---

### F10. role_outputs 缺少 workflow 索引 `[已修复]`

**现状**：
- `generateIterationStats()` 按 `related_workflow_id` 查询 token 消耗
- `idx_role_outputs_role` 只索引了 `role` 字段
- 大量数据时查询慢

**修复方案**：
- 添加 `idx_role_outputs_workflow` 索引 (related_workflow_id)

**涉及文件**：
- `src/db/schema.ts`

---

## 小问题

### F11. permissions 条件从未被 enforce `[已修复]`

**现状**：
- `permissions.ts` 定义了精细权限（DEV 只能 update assigned_to=DEV 的 tasks）
- `database.ts` 工具完全没有校验这些条件
- 权限定义是死代码

**修复方案**：
- 方案 A（推荐）：在 database tool 的 query/insert/update 中加载并校验权限条件
- 方案 B：删除 permissions 表和 seedPermissions，承认当前是"信任 LLM"模式
- 方案 C：保留定义但标记为 "future enforcement"

**涉及文件**：
- `src/workspace/sync-agents.ts`（database tool 模板）
- `src/db/permissions.ts`

---

### F12. formatTokens 重复定义 `[已修复]`

**现状**：
- `auto-trigger.ts` 和 `status.ts` 各自定义了 `formatTokens()`，逻辑相同

**修复方案**：
- 提取到公共 utils 模块

**涉及文件**：
- `src/engine/auto-trigger.ts`
- `src/cli/status.ts`
- 新建 `src/utils/format.ts`（或放入现有 utils）

---

### F13. Onboarding re-sync 中间状态问题 `[已修复]`

**现状**：
- PM onboarding 中通过 write tool 分多次修改 roles/*.md
- Scheduler 每 tick 检查 onboarding 完成 → 触发 re-sync
- 如果 PM 先改 PM.md 再改 DEV.md，中间状态（PM.md 新 + DEV.md 旧）会被同步

**修复方案**：
- Onboarding 完成后只 re-sync 一次（当前已是检测到 `onboarding_completed` 时才 sync）
- 确认：是否只在 onboarding_completed 写入后才触发？如果是则无问题
- 如果 PM 分多个 dispatch 完成修改，中间 tick 不应触发 sync

**涉及文件**：
- `src/engine/scheduler.ts` — onboarding sync 时机

---

### F14. 向量搜索距离阈值硬编码 `[已修复]`

**现状**：
- `memory.ts` 中 `distance < 0.3` 是 L2 距离的硬编码阈值
- 换 embedding 模型（不同维度/距离分布）可能完全失效
- 例如 OpenAI text-embedding-3-small 的 L2 距离分布与本地 bge-small-zh 不同

**修复方案**：
- 将阈值与 embedding provider 关联，或改用 cosine similarity（归一化后更稳定）
- 可在 config 中添加 `similarityThreshold` 配置

**涉及文件**：
- `src/embedding/memory.ts`
- `src/config/index.ts`（可选）

---

## 修复优先级建议

| 批次 | 项目 | 说明 |
|------|------|------|
| **第一批** | F1 + F2 | 删除 workflow JSON，消除最大的死代码块 |
| **第一批** | F3 | Sprint Contract guard，核心流程保障 |
| **第一批** | F4 | Reflection 消息类型，一行改动 |
| **第二批** | F5 | pendingContext 持久化 |
| **第二批** | F7 | pre_suspend_status 字段 |
| **第二批** | F9 | PM starvation 保护 |
| **第三批** | F6, F10, F11, F12, F13, F14 | 健壮性和代码质量 |
| **待确认** | F8 | 需确认 opencode SDK 行为 |
