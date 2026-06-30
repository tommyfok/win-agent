# agent-skills 工作流采纳实施方案

_更新日期：2026-06-29_

## 结论

win-agent 应当采纳 [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) 作为 PM / DEV 的工程方法论库，但不应把它改造成新的调度中枢，也不应依赖模型“看见 skills 后自行想起使用”。

本方案的落地目标是：

- 将 `agent-skills` 作为可引用、可更新、可审计的方法论资料包同步到目标项目。
- 在 PM / DEV 角色模板中显式绑定“何时读取哪个 skill、必须产出什么门槛产物”。
- `win-agent init` 不再引导用户搜索、勾选、安装大量市场 skills；初始化只注入一套固定、精简、版本可控的 `agent-skills` 方法论包。
- 保持现有 win-agent 工作流不变：PM / DEV 双角色、SQLite 状态机、messages 协议、scheduler 调度、task 生命周期都不改。
- 避免把完整 `SKILL.md` 全文注入每次 dispatch；只注入短 trigger matrix、路径引用和必要 checklist。
- 用产物门槛约束 agent 行为，而不是只写“请澄清”“请自测”这类口号。

一句话：**统一注入 agent-skills 方法论包是必要的，但必须由 win-agent 的 PM / DEV 模板显式路由和约束，不能靠 init 阶段让用户安装一堆 skills，也不能只靠底层 agent 的自动 skill discovery。**

## 背景

`agent-skills` 的核心价值不是某个具体技能文件，而是把高级工程师的工作纪律编码成可触发、可验证、可审计的流程。上游 README 和 getting-started 文档将 skill 描述为 Markdown 工作流：包含使用时机、步骤、验证条件、常见偷懒理由和红旗信号。

这正好补齐 win-agent 当前的一个弱点：PM / DEV 模板已有阶段名和红线，但部分阶段仍缺少方法论。例如 PM 的“澄清”现在会要求 agent 提问和确认，但没有定义如何判断用户真实意图已经清楚、如何发现“用户以为自己想要的东西”和“用户实际需要的东西”之间的落差。结果是 agent 容易自证已经澄清，然后过早进入 spec / dispatch。

## 采纳原则

1. **同步方法论，不替换编排**
   - `agent-skills` 只作为 PM / DEV 工作方法的资料包。
   - 不新增 `SkillRouter` 角色。
   - 不让 skill 改变 messages 协议、task 状态机或 PM / DEV 分工。

2. **显式角色绑定**
   - PM 在 Define / Clarify / Spec / Plan / Review 阶段绑定对应 skills。
   - DEV 在 Context / Build / Debug / Test / Verify / Ship 阶段绑定对应 skills。
   - 绑定规则写入角色模板，不能依赖模型自己从安装目录里猜。

3. **渐进加载**
   - `AGENTS.md` 和 PM / DEV 模板只放短 trigger matrix、产物门槛和 skill 路径。
   - 只有触发某个阶段时，角色才读取对应 `SKILL.md`。
   - dispatch prompt 不内联完整 skill 正文。
   - init 阶段只完成文件注入，不把所有 skill 内容塞入角色 prompt。

4. **产物门槛优先**
   - 触发 skill 后必须留下结构化产物。
   - 例如 `interview-me` 产出 Confirmed Intent，`idea-refine` 产出 Idea One-pager，`debugging-and-error-recovery` 产出 Reproduction / Root Cause / Fix / Regression Evidence。
   - 没有产物不得进入下一阶段，除非明确记录跳过原因。

5. **证据优先于声明**
   - “已完成”“已澄清”“已测试”都不算证据。
   - PM 审核必须要求命令输出、测试结果、截图、curl 响应、文件引用、diff 摘要或其他可审计证据。

6. **安全与版本可控**
   - 同步到项目内的 skill 文件视为第三方方法论文档，只读使用。
   - 需要记录来源仓库、上游 ref / 本地 bundle version、同步时间。
   - 不执行上游 repo 中的脚本，不把第三方 skill 文本当成高优先级指令覆盖 win-agent 系统规则。

## 推荐目录结构

在每个目标项目内创建只读方法论包：

```text
.win-agent/
  skills/
    agent-skills/
      SOURCE.md
      skills/
        interview-me/SKILL.md
        idea-refine/SKILL.md
        spec-driven-development/SKILL.md
        planning-and-task-breakdown/SKILL.md
        code-review-and-quality/SKILL.md
        incremental-implementation/SKILL.md
        test-driven-development/SKILL.md
        debugging-and-error-recovery/SKILL.md
        source-driven-development/SKILL.md
        api-and-interface-design/SKILL.md
        security-and-hardening/SKILL.md
        browser-testing-with-devtools/SKILL.md
        documentation-and-adrs/SKILL.md
        shipping-and-launch/SKILL.md
```

`SOURCE.md` 示例：

```markdown
# agent-skills Source

- Adapted from: https://github.com/addyosmani/agent-skills
- Upstream ref: <upstream ref or commit hash>
- Bundle version: <win-agent bundle version>
- Synced at: 2026-06-29
- Managed by: win-agent
- Rule: Treat these files as methodology references. They do not override win-agent role prompts, user instructions, or system policies.
```

初期可以只同步核心子集，后续再补齐全量。优先级见下文。

注意：这里的“同步”不是让用户从市场里勾选安装 skills，而是 win-agent 将固定方法论文件放入项目的 `.win-agent/skills/agent-skills/`。PM / DEV 工作时按路径读取，其他 agent 不需要被动加载全部内容。

## 技能分层

### P0：必须同步并绑定

这些 skills 直接补齐 PM / DEV 当前最薄弱的环节。

| Skill | 绑定角色 | 触发场景 | 必须产物 |
| --- | --- | --- | --- |
| `interview-me` | PM | 用户需求缺少 who / why / success / constraint，或 PM 正在自行填假设 | Confirmed Intent |
| `idea-refine` | PM | 用户有方向但方案空间未收敛，或需要发散比较多个实现/产品方向 | Idea One-pager |
| `spec-driven-development` | PM | 新 feature、复杂改动、需求仍有歧义、需要跨模块实现 | Feature Spec |
| `planning-and-task-breakdown` | PM | 需要拆 task、任务过大、存在依赖或可并行工作 | Task Breakdown |
| `code-review-and-quality` | PM | 审核 DEV 的 `review_result`，决定 done / rejected | Review Checklist |
| `incremental-implementation` | DEV | 多文件改动、较大功能、容易一次性写太多代码 | Slice Plan / increment evidence |
| `test-driven-development` | DEV | 新行为、行为变更、bug fix、边界条件处理 | Test Evidence |
| `debugging-and-error-recovery` | DEV | 测试/build/lint/运行失败，或 PM 打回指出问题 | Reproduction / Root Cause / Fix Evidence |

### P1：按场景同步并绑定

这些 skills 不一定每个任务都用，但在对应领域价值高。

| Skill | 绑定角色 | 触发场景 |
| --- | --- | --- |
| `source-driven-development` | DEV | 框架/API/库用法依赖当前版本，或需要避免过时模式 |
| `api-and-interface-design` | PM + DEV | 新增/修改 API、组件 props、模块接口、数据契约 |
| `security-and-hardening` | PM + DEV | 用户输入、认证、权限、数据存储、第三方服务、文件上传 |
| `browser-testing-with-devtools` | DEV | Web UI、浏览器运行时、console/network/DOM/截图验证 |
| `documentation-and-adrs` | PM + DEV | 公共接口、架构决策、运维流程或规则文档变化 |
| `shipping-and-launch` | PM | 用户要求发布、上线、回滚、监控、验收移交 |

### P2：暂缓

全量 skill pack、persona bundle、外部 hooks、自动 slash commands 暂缓。原因：

- win-agent 已有 PM / DEV / scheduler 编排，不需要 persona tree。
- 全量自动注入会增加上下文成本和冲突面。
- 外部 hooks 可能改变运行时行为，不适合第一阶段接入。

## PM 工作流增强

当前 PM 的流程仍保持：

```text
Context Refresh -> Specify -> Clarify -> Plan -> Confirm & Dispatch -> Review
```

增强后，每个阶段新增方法论引用和产物门槛。

### PM Skill Router Matrix

这段应写入 `.win-agent/roles/PM.md` 或 `PM-task-handling.md`：

```text
PM 在处理用户需求时，先按以下顺序判断是否需要读取 skill：

1. 需求意图不清：读取 `.win-agent/skills/agent-skills/skills/interview-me/SKILL.md`
   - 触发：缺少用户是谁、为什么现在做、成功标准、关键约束、非目标。
   - 门槛：产出 Confirmed Intent，并获得用户明确确认。

2. 方向未收敛：读取 `.win-agent/skills/agent-skills/skills/idea-refine/SKILL.md`
   - 触发：用户只有模糊想法、多个方案都可能成立、需要先比较 MVP 方向。
   - 门槛：产出 Idea One-pager，并获得用户选择或确认。

3. 需要形成可实现需求：读取 `.win-agent/skills/agent-skills/skills/spec-driven-development/SKILL.md`
   - 触发：新 feature、跨模块变更、需求有边界/验收/约束。
   - 门槛：写入 `.win-agent/docs/spec/*.md`。

4. 需要拆任务：读取 `.win-agent/skills/agent-skills/skills/planning-and-task-breakdown/SKILL.md`
   - 触发：任务超过单个小改动、存在依赖、可并行或需要分阶段验证。
   - 门槛：每个 task 有范围边界、依赖、验收标准、验证方式。

5. 审核 DEV 输出：读取 `.win-agent/skills/agent-skills/skills/code-review-and-quality/SKILL.md`
   - 触发：收到 DEV 的 review_result。
   - 门槛：逐条验收标准绑定证据，决定 done / rejected。
```

### Confirmed Intent 门槛

`interview-me` 触发后，PM 不得直接写 spec。必须先形成：

```markdown
## Confirmed Intent

- Outcome:
- User:
- Why now:
- Success:
- Constraint:
- Out of scope:
- Confidence:
- Explicit confirmation:
```

规则：

- `Confidence < 70%` 时不得进入 spec。
- 用户的“随便你”“你看着办”“直接做”不算 explicit confirmation。
- 如果用户拒绝继续澄清，PM 可以继续，但必须在 spec 中写明“用户要求跳过澄清”及剩余风险。

### Idea One-pager 门槛

`idea-refine` 触发后，PM 必须形成：

```markdown
## Idea One-pager

- Problem Statement:
- Recommended Direction:
- Alternatives Considered:
- Key Assumptions:
- MVP Scope:
- Not Doing:
- Open Questions:
```

规则：

- 至少比较 2 个方向，除非用户明确已经指定唯一方向。
- `Not Doing` 必填，避免后续 task 膨胀。
- 未确认方向时，不得进入 task dispatch。

### Feature Spec 门槛

`spec-driven-development` 触发后，PM 必须写入 `.win-agent/docs/spec/*.md`。Spec 至少包含：

- Objective：做什么、为谁做、为什么现在做。
- User Acceptance：用户视角可验证标准。
- Technical Acceptance：API、数据、测试、安全、性能等技术标准。
- Constraints：项目约束、非目标、边界条件。
- Evidence Plan：每条验收标准期望的证据类型。
- Implementation Notes：若已有技术方案，引用方案章节。

### Task Breakdown 门槛

`planning-and-task-breakdown` 触发后，每个 task 必须包含：

- Scope：只做什么 / 不做什么。
- Dependencies：依赖哪些 task 或外部条件。
- Acceptance Criteria：3-6 条优先；超过 6 条优先拆分。
- Verification：DEV 需要提供什么证据。
- Likely Files / Modules：如已知则列出。
- Size：XS / S / M / L；L 必须解释为何不能继续拆分。

### PM Review 门槛

收到 DEV 的 `review_result` 后，PM 不得只根据“测试通过”四个字接受。必须审查：

- 是否逐条覆盖 spec / directive 中的验收标准。
- 每条标准是否有具体证据。
- 是否运行了 `.win-agent/docs/validation.md` 中相关命令。
- 是否有截图、curl、浏览器、日志或测试输出证明用户可见行为。
- 是否存在范围外改动、未解释风险或未归档经验。

任一缺失，发 `feedback` 打回；打回内容必须指出缺失证据或不满足的标准。

## DEV 工作流增强

当前 DEV 的流程仍保持：

```text
Phase 1 环境感知 -> Phase 2 消息分派 -> Phase 3 开发和自测 -> Phase 4 收尾
```

增强目标是让 DEV 在 Phase 3 内按任务性质读取对应 skill，并在 Phase 4 的验收报告中留下证据。

### DEV Skill Router Matrix

这段应写入 `.win-agent/roles/DEV.md`：

```text
DEV 在进入 Phase 3 前，先按任务性质判断是否需要读取 skill：

1. 多文件或较大改动：读取 `.win-agent/skills/agent-skills/skills/incremental-implementation/SKILL.md`
   - 门槛：先列出 slice plan；每个 slice 保持可构建、可验证。

2. 新行为、行为变更、bug fix：读取 `.win-agent/skills/agent-skills/skills/test-driven-development/SKILL.md`
   - 门槛：有对应测试；bug fix 先写/找到复现测试或说明无法自动化复现的原因。

3. 测试、构建、lint、运行失败：读取 `.win-agent/skills/agent-skills/skills/debugging-and-error-recovery/SKILL.md`
   - 门槛：记录复现命令、失败现象、根因、修复点、回归验证。

4. 框架/API/库用法依赖当前版本：读取 `.win-agent/skills/agent-skills/skills/source-driven-development/SKILL.md`
   - 门槛：查项目依赖版本，引用官方文档或在验收报告中说明依据。

5. API、权限、用户输入、文件上传、外部服务：读取对应专项 skill
   - `api-and-interface-design`
   - `security-and-hardening`
```

### Slice Plan 门槛

多文件任务开始编码前，DEV 至少形成内部 slice plan。验收报告中简要汇总：

```markdown
## Slice Plan

- Slice 1:
  - Scope:
  - Verification:
- Slice 2:
  - Scope:
  - Verification:
```

规则：

- 如果任务很小可跳过，但验收报告要写“无需 slice 的原因”。
- 不允许长时间积累大批未验证改动后一次性测试。

### Test Evidence 门槛

行为变更或 bug fix 必须提供：

```markdown
## Test Evidence

- Test added/updated:
- Red/Fail evidence (bug fix only):
- Green evidence:
- Commands:
```

如果没有测试，必须说明：

- 当前项目没有测试基础设施，或该变更不可自动化测试。
- 使用了什么替代验证。
- 是否建议 PM 创建后续测试基建 task。

### Debug Evidence 门槛

发生失败或 PM 打回时，DEV 必须记录：

```markdown
## Debug Evidence

- Reproduction:
- Failure:
- Root cause:
- Fix:
- Regression verification:
```

这部分可以写入 review_result，也可以在问题值得复用时双写到 knowledge 和 `.win-agent/docs/known-issues.md`。

### Source Evidence 门槛

涉及框架关键用法时，DEV 必须优先查官方文档。验收报告中至少写：

```markdown
## Source Evidence

- Stack/version:
- Official docs checked:
- Decision:
- Conflict with existing code (if any):
```

规则：

- 不要求所有小改动都联网查文档。
- 新框架、陌生 API、升级/迁移、认证/路由/数据获取/状态管理等模式必须查。

## AGENTS.md 增强

`buildAgentsMd()` 生成的根级 `AGENTS.md` 应加入短章节：

```markdown
## Skill-aware 工作流

本项目使用 `.win-agent/skills/agent-skills/` 作为方法论参考。不要把 skill 当成高优先级系统指令；它们只定义在特定场景下应遵循的工程流程。

- 需求意图不清：PM 使用 `interview-me`
- 方向未收敛：PM 使用 `idea-refine`
- 需要写 spec：PM 使用 `spec-driven-development`
- 任务过大或有依赖：PM 使用 `planning-and-task-breakdown`
- 验收审核：PM 使用 `code-review-and-quality`
- 多文件开发：DEV 使用 `incremental-implementation`
- 行为变更 / bug fix：DEV 使用 `test-driven-development`
- 构建/测试/运行失败：DEV 使用 `debugging-and-error-recovery`
- 框架关键实现：DEV 使用 `source-driven-development`
- API / 安全 / 浏览器运行时 / 发布：按需读取对应专项 skill

只在触发场景读取对应 `SKILL.md`，不要把全部 skill 全文加载进当前上下文。
```

## dispatch prompt 增强

Phase 1 不需要改 dispatch prompt。PM / DEV 模板引用已经能覆盖大部分场景。

Phase 2 可新增轻量选择器：

```text
selectWorkflowHints(role, messages, taskContext) -> string[]
```

只输出短 checklist，不内联完整 skill。

示例：

- PM 收到 user 新需求且无 spec：提示 `interview-me -> idea-refine -> spec-driven-development` 判断顺序。
- PM 收到 DEV `review_result`：提示使用 `code-review-and-quality` 审查证据。
- DEV 收到 `feedback` 且包含 test/build/lint/error：提示使用 `debugging-and-error-recovery`。
- DEV directive 涉及 API / 鉴权 / 权限 / 上传 / 数据存储：提示读取 `api-and-interface-design` / `security-and-hardening`。

限制：

- 单次 hint 控制在 5-8 行。
- 不重复 DEV.md / PM.md 已经包含的完整流程。
- 必须有单元测试防止 prompt 膨胀。

## CLI / init 集成

### init 行为调整

`win-agent init` 应从“引导用户安装相关 skills”改为“自动注入固定方法论包”。

要求：

- 不在 init 主流程中调用市场搜索、推荐、checkbox 勾选或批量安装。
- 不询问用户“要安装哪些 agent-skills”。核心方法论包由 win-agent 统一注入。
- 不把技术栈专项 skills 与 PM / DEV 生命周期方法论混在一起。
- 不因 agent-skills 同步失败而阻塞 init；失败时仅提示可稍后运行同步命令。

原因：

- skill 太多会稀释 agent 注意力，不利于稳定执行。
- PM / DEV 需要的是少数高质量方法论入口，而不是大量候选 skills。
- 统一注入可以保证路径稳定、版本可控、角色模板可直接引用。

### 新增同步步骤

在 `win-agent init` 中，角色模板部署后增加：

```text
同步 agent-skills 方法论包
```

行为：

1. 默认同步 P0 + P1 核心子集到 `.win-agent/skills/agent-skills/`。
2. 写入 `SOURCE.md`，记录来源、上游 ref / bundle version、时间。
3. 首选使用 win-agent 包内置的 pinned 副本；如果改为联网拉取，必须锁定 commit。
4. 如果网络不可用或同步失败，提示跳过，不阻塞 init。
5. 如果目标目录已存在，默认不覆盖；提供 update 命令或确认覆盖。

### 新增 CLI 命令

建议扩展现有 `win-agent skills`，不要新开多个入口。

```bash
win-agent skills sync-agent-skills
win-agent skills update-agent-skills
win-agent skills status
```

含义：

- `sync-agent-skills`：首次同步方法论包。
- `update-agent-skills`：刷新到 win-agent 内置 bundle version，并重写 `SOURCE.md`。
- `status`：显示本项目已同步的 agent-skills 来源、版本和 skill 列表。

### 与现有市场 skills 推荐的关系

现有 `win-agent skills` 推荐安装 OpenCode Skills 的能力不再放入 init 主流程。它最多保留为用户显式触发的高级命令，且定位不同：

- `agent-skills`：PM / DEV 生命周期方法论，绑定到角色模板。
- 市场 skills 推荐：面向项目技术栈的专项能力增强，如 React、Stripe、Supabase、Playwright 等。

两者不要混为一个机制。默认路径应是：init 注入 `agent-skills` 方法论包；PM / DEV 按需读取；技术栈专项 skills 只有在用户明确要求时才推荐或安装。

## 角色模板改造清单

### `src/templates/roles/PM.md`

- 在核心原则后加入“Skill-aware 工作流”短规则。
- 明确 PM 处理需求时先执行 PM Skill Router Matrix。
- 明确 skill 文件是方法论引用，不覆盖用户当前指令和 win-agent 协议。

### `src/templates/roles/PM-task-handling.md`

- 在 Step 1 前新增 `Step 0.5 — Intent Gate`，绑定 `interview-me`。
- 在 Step 1 / Step 2 之间新增 `Idea Gate`，绑定 `idea-refine`。
- 在 Step 1 Specify 中绑定 `spec-driven-development`。
- 在 Step 4 Confirm & Dispatch 中绑定 `planning-and-task-breakdown`。
- 在验收审核引用处绑定 `code-review-and-quality`。
- 增加 Confirmed Intent、Idea One-pager、Evidence Plan 产物模板。

### `src/templates/roles/DEV.md`

- 在 Phase 3 开头加入 DEV Skill Router Matrix。
- 在常规任务步骤中加入 Slice Plan / Test Evidence / Debug Evidence / Source Evidence 门槛。
- 保持原有 `development.md` / `validation.md` 必读规则不变。

### `src/templates/roles/DEV-reference.md`

- 扩展验收报告格式，增加可选章节：
  - Slice Plan
  - Test Evidence
  - Debug Evidence
  - Source Evidence
  - Security / API Notes

### `src/cli/init.ts`

- `buildAgentsMd()` 增加 Skill-aware 工作流章节。
- init 流程同步 agent-skills 方法论包。
- 移除 init 主流程中的市场 skills 搜索、推荐和交互式安装。
- 增加 `buildAgentsMd()` 单测，确保 trigger matrix 输出稳定。

### `src/engine/prompt-builder.ts`

- Phase 1 不改。
- Phase 2 才新增 `workflow-hints.ts` 并注入短 checklist。

## 分阶段实施计划

### Phase 1：文档和角色模板绑定

目标：不改调度、不改 DB、不改消息协议，只增强 PM / DEV 行为约束。

改动：

- 更新 `PM.md`、`PM-task-handling.md`、`DEV.md`、`DEV-reference.md`。
- 更新 `buildAgentsMd()` 生成的 `AGENTS.md`。
- 加 `buildAgentsMd()` 输出测试。

验收：

- 新 init 项目生成的 `AGENTS.md` 包含 Skill-aware 工作流。
- PM 模板明确要求在意图不清时使用 `interview-me`。
- PM 模板明确要求方向未收敛时使用 `idea-refine`。
- DEV 模板明确要求按任务类型读取对应 skill。
- 无 schema / state-machine / scheduler 行为变化。

### Phase 2：同步 agent-skills 方法论包

目标：让 PM / DEV 引用的路径真实存在。

改动：

- 从 `win-agent init` 主流程移除市场 skills 推荐安装入口。
- 增加 agent-skills 同步逻辑。
- 同步 P0 + P1 核心子集。
- 写入 `.win-agent/skills/agent-skills/SOURCE.md`。
- 增加 CLI status / update 能力。

验收：

- `win-agent init` 后目标项目存在 `.win-agent/skills/agent-skills/skills/interview-me/SKILL.md` 等核心文件。
- `win-agent init` 不再出现“选择要安装的 Skills”之类的交互。
- 网络失败不阻塞 init。
- 重复 init 不覆盖用户已同步版本，除非用户确认。

### Phase 3：dispatch 轻量提示

目标：在关键消息场景提醒角色使用正确 skill，但不增加大段 prompt。

改动：

- 新增 `src/engine/workflow-hints.ts`。
- 在 `prompt-builder` 中加入 `## 工作流提示` 短章节。
- 为 PM / DEV 常见场景加单元测试。

验收：

- PM 新需求消息无 spec 时提示 intent/spec 流程。
- PM review_result 时提示 review checklist。
- DEV feedback 含失败关键词时提示 debug workflow。
- DEV directive 含 API / auth / permission / upload 等关键词时提示专项 skill。
- prompt 不出现完整 `SKILL.md` 正文。

### Phase 4：观察和调优

目标：确认增强是否真的提升质量，而不是只增加文本。

观察指标：

- PM 跳过明确确认直接派发的次数是否下降。
- PM 创建的大 task / 模糊验收标准是否下降。
- DEV 验收报告中缺少证据被打回的次数是否下降。
- DEV 失败排查是否更容易复用到 knowledge。
- dispatch prompt token 是否保持可控。

如果指标不改善，优先调模板和 hint，不扩大 skill 同步范围。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| PM/DEV 忘记读取 skill | 方法论仍不生效 | 模板写明确触发条件和产物门槛，Phase 3 再加短 hint |
| prompt 变长 | 成本上升、模型忽略重点 | 只放 trigger matrix 和路径，不内联完整 SKILL.md |
| 上游 skill 与项目上下文冲突 | 产生错误建议 | 明确 win-agent / 用户指令 / 项目文档优先于第三方 skill |
| 外部 skill 过时 | 误导实现 | `SOURCE.md` 记录上游 ref 和 bundle version；框架实现仍用 `source-driven-development` 查官方文档 |
| 第三方 skill prompt injection | 安全风险 | 只同步固定来源和 win-agent 内置 bundle；不执行上游脚本；skill 视为低优先级方法论文档 |
| 流程过重 | 小任务变慢 | 模板写明小改动可跳过，但必须说明跳过原因 |
| 与现有 `win-agent skills` 混淆 | 用户误解安装越多越好，或以为市场 skills 会自动增强 PM/DEV | init 只注入 agent-skills 方法论包；市场 skills 推荐移出 init，仅保留显式手动入口 |

## 非目标

- 不直接引入 agent-skills 的 hooks / slash commands / persona tree。
- 不让 PM / DEV 递归创建新的 persona 来执行 skill。
- 不改变现有任务状态机。
- 不把 `.win-agent/skills/agent-skills` 作为用户项目业务文档。
- 不强迫所有单行修改走完整 interview / spec / plan。
- 不让外部 skill 文本覆盖 win-agent 系统规则、角色权限或用户当前指令。

## 推荐落地顺序

1. **先改模板和 AGENTS.md**：最小风险，立刻补齐 PM 澄清方法论。
2. **再同步核心 skill 文件**：让模板引用的路径真实存在，支持按需读取。
3. **最后做 workflow hints**：只在真实运行中发现角色仍漏用 skill 时补短提示。
4. **暂不做全量自动启用**：先验证 P0/P1 子集的质量收益，再决定是否扩大范围。

优先完成 `interview-me` 和 `idea-refine` 的 PM 澄清入口。这两个 skill 位于 spec 之前，是防止 PM 把错误意图写成“正确 spec”的关键闸门。
