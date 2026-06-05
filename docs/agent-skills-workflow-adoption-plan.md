# agent-skills 工作流采纳方案

_日期：2026-06-05_

## 背景

本方案记录对 [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) 的学习结论，以及 win-agent 是否应当使用、吸收或改造其方法论。

结论：win-agent 值得吸收 `agent-skills` 的工程纪律，但不建议直接整包照搬。上游仓库最有价值的部分不是某个具体 skill，而是把 AI 工程行为拆成可触发、可验证、可审计的工作流。

## 上游核心理念

`agent-skills` 把 skill 定义为“工作流”，而不是资料库或提示词片段。一个高质量 skill 通常包含：

- 明确触发条件：什么时候必须使用，什么时候不该使用。
- 分阶段流程：按顺序执行，不能跳过关键门槛。
- 验证证据：任务完成必须有测试、构建、截图、日志或人工确认等证据。
- 常见偷懒理由：列出 agent 容易用来跳过流程的借口，并逐一反驳。
- 红旗信号：让 agent 和 reviewer 能发现流程已经偏离。
- 渐进加载：启动时只暴露 metadata，需要时再加载完整 `SKILL.md` 和参考资料。

它的生命周期映射可以概括为：

```text
DEFINE  -> spec-driven-development
PLAN    -> planning-and-task-breakdown
BUILD   -> incremental-implementation + test-driven-development
VERIFY  -> debugging-and-error-recovery
REVIEW  -> code-review-and-quality
SHIP    -> shipping-and-launch
```

上游 OpenCode 集成主要依赖根目录 `AGENTS.md`、`skills/` 目录和模型自觉执行 skill routing。这适合单 agent 或人类主导的 slash-command 工作流，但对 win-agent 来说只是一部分答案。

## win-agent 现状判断

win-agent 已经有自己的强编排结构：

- PM/DEV 双角色分工。
- SQLite 任务状态机和 `messages` 协议。
- PM 负责需求澄清、spec、任务拆分、验收审核。
- DEV 负责实现、验证、提交、记忆归档。
- scheduler 负责串行调度、依赖阻塞、自动触发。
- `prompt-builder` 会注入 task context、spec、constitution、knowledge 和执行要求。
- `init` 已经能为目标项目生成根级 `AGENTS.md`。

因此，win-agent 不需要再新增一个“Skill Router Agent”。如果在 PM 和 DEV 外面再套一层泛化路由，会增加上下文转述、token 成本和责任边界混乱。

当前 `src/cli/skills.ts` 更像“按技术栈推荐并安装市场 skills”，它解决的是技术栈适配，不是生命周期强约束。后续可以保留，但不应把它当成 agent-skills 方法论的主要落点。

## 采纳原则

1. **吸收工作流，不照搬运行形态**
   - 上游 skill 内容可以作为参考，但 win-agent 的约束应落到 PM/DEV 模板、任务状态、directive、review_result 和验证报告里。

2. **PM/DEV 分别拥有不同的 skill 门**
   - PM 管 Define、Plan、Review。
   - DEV 管 Context、Build、Test、Debug、Ship。
   - scheduler 不扮演第三个会话角色，只负责把正确上下文和门槛注入。

3. **只注入必要技能**
   - 不把 20 多个 skill 全文塞进每次 prompt。
   - 在 `AGENTS.md` 和 role 模板中保留短 trigger matrix。
   - 复杂任务再按需注入具体 skill 摘要或引用。

4. **证据优先于口头声明**
   - “已完成”“已通过”不够。
   - PM 审核必须能看到命令输出、测试结果、截图、curl 响应、文件引用或其他客观证据。

5. **避免 router persona 和深层 persona tree**
   - 需要并行审查时采用 fan-out + main merge。
   - 不允许 persona 调 persona；编排归 PM、scheduler 或主 DEV。

## 推荐改造

### 1. 增强生成的 AGENTS.md

在 `buildAgentsMd()` 生成的根级 `AGENTS.md` 中加入 “Skill-aware 工作流” 章节：

```text
需求/规格不清 -> PM 按 spec-driven-development 思路澄清并写 spec
任务过大 -> PM 按 planning-and-task-breakdown 思路拆成可验证小任务
多文件开发 -> DEV 按 incremental-implementation 分片推进
行为变更/bug fix -> DEV 按 test-driven-development 提供测试证据
构建/测试失败 -> DEV 按 debugging-and-error-recovery 先复现再定位
验收审核 -> PM 按 code-review-and-quality 多轴审查
涉及 API/安全/性能/文档 -> 追加对应专项检查
```

这一步成本低，能让任何进入目标项目的 agent 都看到同一套工作流语言。

### 2. 增强 PM 模板

在 PM 的 Specify / Plan / Dispatch 流程中补充退出条件：

- spec 未写入 `.win-agent/docs/spec/*.md` 不得派发。
- 每个 task 必须有验收证据要求，而不只是验收描述。
- 涉及 2 个以上模块、数据模型、接口契约或安全边界时，必须先走技术方案。
- 任务拆分不合格时，不得把“大 task”直接交给 DEV。

这对应上游的 `spec-driven-development` 和 `planning-and-task-breakdown`。

### 3. 增强 DEV 模板

在 DEV Phase 3/4 中补充更明确的技能门：

- 行为变更必须有测试或说明为什么无法测试。
- bug fix 必须优先复现，能写回归测试的必须写。
- 框架关键实现按 `source-driven-development` 查官方文档，而不是凭记忆。
- 涉及用户输入、认证、数据存储、外部服务时触发 security checklist。
- 多文件任务按小切片推进，每个切片保持可构建、可验证。
- 验收报告逐条绑定 acceptance criteria 和证据。

这对应上游的 `incremental-implementation`、`test-driven-development`、`debugging-and-error-recovery`、`source-driven-development` 和 `security-and-hardening`。

### 4. 给 dispatch prompt 加轻量 skill hints

可以新增一个很小的运行时选择器：

```text
selectWorkflowHints(role, messages, taskContext) -> string[]
```

示例：

- DEV 收到 `feedback` 且内容包含测试失败 -> 注入 `debugging-and-error-recovery` 摘要。
- DEV 当前任务 acceptance criteria 包含 API/鉴权/权限 -> 注入 API/security 检查点。
- PM 处理用户新需求且无 spec -> 注入 spec/plan 检查点。
- PM 审核 `review_result` -> 注入 review checklist。

注意这里先注入短 checklist，不急着注入完整上游 skill。

### 5. 保留 skills 市场推荐，但定位下沉

`win-agent skills` 可以继续做技术栈 skill 推荐，但它应定位为“专项能力增强”，例如 React、Stripe、Supabase、Playwright 等，不应承担 PM/DEV 生命周期约束。

长期可以支持：

```text
win-agent skills import addyosmani/agent-skills
win-agent skills enable spec-driven-development --role PM
win-agent skills enable test-driven-development --role DEV
```

但建议在模板和协议稳定后再做。

## 非目标

- 不直接把上游全部 `skills/` 复制进目标项目。
- 不在每次 dispatch 中注入所有 skill 正文。
- 不新增 `SkillRouter` 角色。
- 不让 PM/DEV 互相递归调用 persona。
- 不把上游 Claude Code hooks 原样移植到 win-agent。
- 不强迫所有小改动都走完整 spec/plan 流程。

## 分阶段计划

### Phase 1：模板级吸收

改动范围：

- `src/cli/init.ts`：增强 `buildAgentsMd()`。
- `src/templates/roles/PM-task-handling.md`：补 PM skill 门和退出条件。
- `src/templates/roles/DEV.md`：补 DEV skill 门和证据要求。
- 相关测试：覆盖 `buildAgentsMd()` 输出。

目标：

- 不改变数据库 schema。
- 不改变调度状态机。
- 不依赖外部 skill 安装。
- 先让新项目和更新后的角色模板具备统一工作流语言。

### Phase 2：dispatch 级轻量注入

改动范围：

- 新增 `src/engine/workflow-hints.ts`。
- 在 `prompt-builder` 中按 role/message/taskContext 注入短 checklist。
- 为 PM/DEV 常见场景增加单元测试。

目标：

- 让技能提示跟当前消息类型有关，而不是固定长 prompt。
- 保持 token 成本可控。

### Phase 3：可选 skill pack 支持

改动范围：

- 扩展 `src/cli/skills.ts` 或新增子命令。
- 支持导入、缓存、启用、禁用外部 skill metadata。
- 如果复制上游内容，保留 license 和来源版本。

目标：

- 让用户可以显式启用外部 skill pack。
- win-agent 仍然以自己的 PM/DEV 协议为主，不依赖模型自行猜测。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| prompt 变长 | 成本上升、模型忽略重点 | 只注入 trigger matrix 和短 checklist |
| 流程过重 | 小任务推进变慢 | 明确 “When NOT to use”，小改动走轻量路径 |
| skill 与 PM/DEV 责任冲突 | 边界模糊 | skill 只约束角色内部流程，不改变 PM/DEV 分工 |
| 外部 skill 过时 | 误导实现 | 框架实现采用 source-driven-development，查官方文档 |
| router 化 | token 成本和上下文漂移 | 禁止新增 router persona，把选择逻辑做成确定性 hint |

## 推荐落地顺序

优先做 Phase 1。它不需要复杂机制，改动集中，收益明确。

Phase 1 完成后观察几轮真实任务：

- PM 是否更少跳过 spec/confirm。
- DEV 验收报告证据是否更完整。
- 被 PM 打回的任务是否减少。
- prompt 是否明显变长或啰嗦。

如果效果稳定，再进入 Phase 2。Phase 3 应当等外部 skill pack 的版本、license、缓存和启用策略明确后再做。
