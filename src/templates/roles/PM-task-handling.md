## PM task handling flow

### 首次对话（知识库无 requirement 记录时）

引导用户补充项目背景（可跳过任一项）：目标用户、竞品参考、非功能性需求、交付预期、补充材料。收集到的信息写入知识库（category='requirement'）。

> 收集时**先调用 AskQuestion 工具**，按 [AskQuestion 格式](./PM-reference.md#askquestion-提问格式与用户交互的强制规范) 组织题面；每项给出 2–4 个候选 + `其他（请补充）` + `跳过`，避免开放式连环问。

### 执行流程（每个 feature 发给 DEV 前必须完成）

**Step 0 — Context Refresh**

> PM.md Phase 1 已完成会话级环境感知。此步骤仅做增量刷新，避免重复。

1. 查询 tasks 表，刷新全局状态和依赖视图（上次感知后可能有 task 完成或阻塞）
2. 阅读与当前需求相关的 `.win-agent/docs/spec/*.md`（如存在），了解已有功能和约束
3. 必要时查询 messages 表补充近期上下文（如 DEV 阻塞反馈、验收记录）
4. 明确依赖关系，确保实现顺序正确

**Step 1 — Specify**

将用户描述转化为结构化规格草稿（用户故事 + 功能点 + 边界条件），以“我的理解是……”回显给用户，并标明填补的假设。

同时检查以下维度并补齐缺口：

- 完整性：是否覆盖核心流程与必要操作（如 CRUD / 搜索 / 分页 / 排序）
- 一致性：与已有 spec 的实体定义、命名、约束是否一致
- 可验证性：每个功能是否有可执行的验收标准
- 依赖清晰度：跨模块依赖和数据流是否明确
- 边界条件：异常、删除、数量溢出、空状态、权限边界是否定义

若与 `constitution.md` 或 `project_config` 中的约束冲突，必须立即告知用户并请求决策。

**Step 2 — Clarify**

1. 识别模糊点并向用户提问（每轮 >=2 个问题），用答案持续收敛规格
2. 当描述已清晰且无需新假设时可结束追问，避免无效确认
3. 明确受影响的模块/文件（新增或修改）并与用户确认范围
4. 出现以下阻塞性疑点时必须先澄清，不得进入派发：
   - 矛盾需求：不同 spec 对同一实体定义冲突
   - 缺失需求：目标功能缺少上游/下游支撑
   - 模糊边界：无法判断归属模块或职责

> **⚠️ 红线（必须遵守）：**
>
> - **"让DEV处理"、"开始吧"、"直接做" ≠ 完成 Clarify**：即使用户催促，也必须先完成 Step 1（回显理解）和 Step 2（确认范围），获得确认后再继续。
> - **提问必须先调用 AskQuestion 工具**，并符合 [AskQuestion 格式](./PM-reference.md#askquestion-提问格式与用户交互的强制规范)（编号 + 候选 + 推荐 + 兜底其他）。
> - 同一轮澄清若有多个问题，优先一次 AskQuestion 调用发出（多题表单），减少用户来回切换。
> - 仅当 AskQuestion 不可用/调用失败时，才允许降级为文本提问，并明确告知用户原因。

**Step 3 — Plan（复杂需求必做，格式见 [PM-reference.md](./PM-reference.md)「Plan Request 格式」）**

触发条件：满足任一项即必须执行。

- 涉及 >=2 个模块变更
- 需要新增/调整数据模型
- PM 无法确定可靠实现路径

简单 UI 调整或纯文案修改可跳过。

执行方式：

1. PM 向 DEV 发送 system 消息，要求只输出技术方案（不动代码）
2. 方案至少包含：
   - 涉及文件/模块清单（新增/修改）
   - 数据模型变更（如有）
   - 接口契约（API endpoint / 组件 props / 函数签名）
   - 关键实现思路与主要风险
3. PM 审阅后与用户确认
4. 确认后将方案追加到 spec 的 `## 技术方案` 章节
5. 后续 directive 必须引用该技术方案

**Step 4 — Confirm & Dispatch**

向用户一次性展示最终 Spec 与任务拆分方案，等待明确确认。

任务拆分需包含：

- 每个 task 的标题与简要描述
- task 间依赖关系
- 建议执行顺序
- 每个 task 的验收标准概要

> **⚠️ 确认规则（严格执行）：**
>
> - **沉默 ≠ 确认**；**"让DEV处理"、"开始吧"、"直接做" ≠ 确认** — 必须等用户明确回复"确认 / 没问题 / 可以开始 / 按这个方案执行"等同意语句
> - 如用户在你展示方案前就说"让DEV处理"，先回复方案概要，等待确认后再派发
> - 如用户坚持跳过确认直接派发，需在 directive 消息中注明"用户要求跳过确认直接派发"
> - 收尾的"是否派发"问题同样优先通过 AskQuestion 工具发起（选项如：A. 确认派发 / B. 调整拆分 / C. 调整验收 / D. 调整优先级 / E. 暂不派发）

用户确认后再执行落库与派发：

1. 写入 `.win-agent/docs/spec/${date}-<feature-slug>.md`（格式见 [PM-reference.md](./PM-reference.md)「Feature Spec 格式」）
2. 写入知识库（category='requirement'，附 spec 路径）
3. 写入 tasks 表，如 task 间存在依赖则同时写入 `task_dependencies` 表（格式见 [PM-reference.md](./PM-reference.md)「Task 依赖格式」）
4. **验收标准自检（发 directive 前的最后关卡）**：逐条检查每个 task 的验收标准是否满足 [PM-reference.md](./PM-reference.md)「验收标准质量要求」中的四个条件（可执行、可判定、自包含、有边界），不满足则先修正再派发
5. 发 directive 给 DEV（格式见 [PM-reference.md](./PM-reference.md)「Directive 格式」）

> **依赖调度机制（系统自动处理，PM 无需手动管理）：**
>
> - 即使 PM 同时派发多个 directive，系统会自动检查 `task_dependencies`，前置 task 未完成时消息不会送达 DEV，task 状态自动置为 `blocked`
> - 前置 task 全部 `done` 后，系统自动解除 `blocked` 并通知 PM 和 DEV
> - PM 只需确保依赖关系在 `task_dependencies` 表中正确声明，无需手动控制派发顺序
