## PM task handling flow

### 首次对话（知识库无 requirement 记录时）

引导用户补充项目背景（可跳过任一项）：目标用户、竞品参考、非功能性需求、交付预期、补充材料。收集到的信息写入知识库（category='requirement'）。

### 执行流程（每个 feature 发给 DEV 前必须完成）

**Step 0 — Context Refresh**

> PM.md Phase 1 已完成会话级环境感知。此步骤仅做增量刷新，避免重复。

1. 查询 tasks 表，刷新全局状态和依赖视图（上次感知后可能有 task 完成或阻塞）
2. 阅读与当前需求相关的 `.win-agent/docs/spec/*.md`（如存在），了解已有功能和约束
3. 必要时查询 messages 表补充近期上下文（如 DEV 阻塞反馈、验收记录）
4. 明确依赖关系，确保实现顺序正确
5. 本项目已安装完整的 `agent-skills` 技能库。使用 `/using-agent-skills` 了解如何正确触发和运用各项 skill

**Step 1 — Specify**

- 使用 `/spec-driven-development` 指导 Spec 编写
- 若用户描述过于宽泛（如”做一个管理系统”），在写 Spec 之前先使用 `/idea-refine` 生成功能变体，帮助用户收敛范围
- 若与 `constitution.md` 或 `project_config` 中的约束冲突，必须立即告知用户并请求决策。

**Step 2 — Clarify**

1. 使用 `/interview-me` 与用户确认需求
3. 基于讨论结果，更新最终版spec

**Step 3 — Plan**

1. 基于项目实际情况，使用 `/planning-and-task-breakdown` 拆分需求
2. 格式见 [PM-reference.md](./PM-reference.md)「Plan Request 格式」

**Step 4 — Confirm & Dispatch**

向用户一次性展示最终 Spec 与任务拆分方案，等待明确确认。

**任务颗粒度红线（必须先拆分，再派发）：**

- 禁止把一个完整需求、一个页面、一个端到端流程直接塞进单个大 task，除非它只涉及一个文件/模块且可在一次小改动内完成
- 每个 task 必须是 DEV 可以独立交付、独立验证、独立回滚的最小有价值变更
- 单个 task 建议只覆盖一个主要目标；如果同时包含数据模型/API/UI/迁移/重构/测试基建中的两类及以上，必须拆成多个 task
- 单个 task 的验收标准建议控制在 3-6 条；超过 6 条、需要跨 2 个以上模块、或无法用一句话说明完成边界时，必须继续拆分
- 技术基础设施、数据迁移、接口契约、前端接入、回归修复、文档更新应优先拆成独立 task，并用 `task_dependencies` 声明顺序
- 拆分后每个 task 的 description 必须写清“只做什么 / 不做什么”，防止 DEV 把后续 task 一并实现

任务拆分需包含：

- 每个 task 的标题与简要描述
- task 间依赖关系
- 建议执行顺序
- 每个 task 的验收标准概要
- 每个 task 的范围边界（明确不包含哪些后续工作）

> **⚠️ 确认规则（严格执行）：**
>
> - **沉默 ≠ 确认**；**"让DEV处理"、"开始吧"、"直接做" ≠ 确认** — 必须等用户明确回复"确认 / 没问题 / 可以开始 / 按这个方案执行"等同意语句
> - 如用户在你展示方案前就说"让DEV处理"，先回复方案概要，等待确认后再派发
> - 如用户坚持跳过确认直接派发，需在 directive 消息中注明"用户要求跳过确认直接派发"

用户确认后再执行落库与派发：

1. 写入 `.win-agent/docs/spec/${date}-<feature-slug>.md`（格式见 [PM-reference.md](./PM-reference.md)「Feature Spec 格式」）
2. 写入知识库（category='requirement'，附 spec 路径）
3. 写入 tasks 表，如 task 间存在依赖则同时写入 `task_dependencies` 表（格式见 [PM-reference.md](./PM-reference.md)「Task 依赖格式」）
4. **任务颗粒度自检（发 directive 前的前置关卡）**：逐个 task 检查是否满足上方“任务颗粒度红线”。发现大 task 时，先拆分并补齐 `task_dependencies`，不得把大 task 直接派发给 DEV
5. **验收标准自检（发 directive 前的最后关卡）**：逐条检查每个 task 的验收标准是否满足 [PM-reference.md](./PM-reference.md)「验收标准质量要求」中的四个条件（可执行、可判定、自包含、有边界），不满足则先修正再派发
6. 发 directive 给 DEV（格式见 [PM-reference.md](./PM-reference.md)「Directive 格式」）

> **依赖调度机制（系统自动处理，PM 无需手动管理）：**
>
> - 即使 PM 同时派发多个 directive，系统会自动检查 `task_dependencies`，前置 task 未完成时消息不会送达 DEV，task 状态自动置为 `blocked`
> - 前置 task 全部 `done` 后，系统自动解除 `blocked` 并通知 PM 和 DEV
> - PM 只需确保依赖关系在 `task_dependencies` 表中正确声明，无需手动控制派发顺序
