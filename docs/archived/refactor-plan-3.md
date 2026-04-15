# win-agent 重构计划（第三阶段）：SDD 方法论落地 & PM-DEV 协同增强

> 基于 2026-04-15 对整体工作流的审查，聚焦两个核心问题：
>
> 1. PM → DEV 信息传递链路太窄，DEV 上下文不足导致实现偏差
> 2. 缺少 SDD（Spec-Driven Development）方法论中的关键阶段，需求管理不够严谨
>
> 参考文档：`src/templates/SDD.md`

---

## 问题诊断

### 现象

1. **PM 下的需求笼统**：PM 经常在 Clarify 阶段草草了事，直接跳到 Confirm & Dispatch
2. **DEV 上下文不完整**：DEV 每次都是零上下文新 session，拿到的只有一条 directive 消息 + task 表的标题/验收标准
3. **DEV 不完全实现就报完成**：验收标准偏"用户视角"且粒度粗，DEV 做个表面功能就能逐项标 ✅

### 根因分析

| 根因                            | 涉及文件                     | 说明                                                                                   |
| ------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| Spec 模板太薄                   | `PM-reference.md:60-83`      | Feature Spec 只有用户故事 + 功能点 + 边界条件，没有技术方案、数据模型、接口契约等字段  |
| Clarify 可跳过                  | `PM-task-handling.md:12`     | "除非用户描述已足够清晰且无需填补假设"给了 PM 跳过的借口                               |
| 无 Plan 阶段                    | `PM-task-handling.md` 全文   | 从 Clarify 直接到 Confirm，中间没有技术设计产出                                        |
| Directive 信息密度低            | `PM-reference.md:17-24`      | 只要求背景 + 依赖 + Spec 路径 + 验收标准，没有技术要求、涉及模块、数据模型、接口定义等 |
| DEV 零上下文启动                | `session-manager.ts:125-137` | 每次 dispatch 都创建全新 session，仅注入 DEV.md + memory 召回 + dispatch prompt        |
| Prompt 注入的 task context 太简 | `prompt-builder.ts:93-108`   | 只注入标题、描述、验收标准、依赖关系，没有 spec 内容                                   |
| DEV 不强制读 Spec               | `DEV.md` Phase 3             | 只要求读 development.md 和 validation.md，没有强制读 spec 文件                         |
| 验收标准单一视角                | `PM.md:10`                   | "验收标准必须是用户视角的技术描述"，缺少技术维度的检查项                               |
| 无项目宪法                      | 全项目                       | 技术约束散落在 project_config.constraints，无统一的持续生效文档                        |
| SDD.md 孤立                     | `src/templates/SDD.md`       | 存在但未被任何角色引用，init 时不拷贝到工作区                                          |
| 任务拆解无审批关口              | `PM-task-handling.md:19-20`  | PM 拆完 task 直接入库 + 发 directive，用户无法在执行前看到完整任务清单                 |
| 无 per-feature 分支             | 全项目                       | DEV 直接在当前分支提交，无功能隔离                                                     |
| Spec 无版本管理                 | `PM-reference.md:62`         | spec 以 `<slug>.md` 扁平存放，需求迭代无版本追踪                                       |

---

## S1：增加 Constitution（项目宪法）

**优先级**：高
**涉及文件**：`cli/init.ts`、`PM.md`、`PM-reference.md`

### 现状

技术约束在 init 时零散写入 `project_config.constraints`（`init.ts:596-614`），没有统一的、持续生效的"宪法"文档。PM 做决策时无法系统性地查阅项目约束。

### 改动点

#### 1. init 阶段生成 constitution.md

在 `cli/init.ts` 的步骤 6（项目上下文导入）中，将 constraints 的收集结果同时写入 `.win-agent/docs/constitution.md`：

```markdown
# 项目宪法

_此文件是项目的根本约束，所有需求决策和技术选型必须遵循。_

## 技术栈约束

- **部署环境**: [从 constraints.deployEnv 读取]
- **必须使用**: [从 constraints.requiredTech 读取]
- **禁止使用**: [从 constraints.forbiddenTech 读取]

## 代码规范

[从 development.md Phase 3 或 init 时的 AI 分析提取]

## 测试要求

[从 validation.md 提取核心要求]

## 其他约束

[从 constraints.other 读取]
```

对于 greenfield 项目，在启动流程（`PM-reference.md:1-11`）中增加一步：PM 与用户讨论并生成 constitution.md，在技术选型之前完成。

#### 2. PM 流程中引用 constitution

在 `PM.md` Phase 1 环境感知中增加：

```
4. 阅读 `.win-agent/docs/constitution.md`（如存在），所有后续决策必须遵循其中约束
```

在 `PM-task-handling.md` Step 1 Specify 中增加：

```
- 检查需求是否与 constitution.md 中的约束冲突，如冲突则告知用户
```

#### 3. 知识库双写

constitution.md 的内容同步写入 knowledge 表（category='convention'，tags='constitution'），使 DEV 在 dispatch 时也能通过向量搜索命中项目约束。

### 验收标准

- [ ] init 完成后 `.win-agent/docs/constitution.md` 存在（非 greenfield 项目由 AI 生成，greenfield 由 PM 在启动流程中生成）
- [ ] PM Phase 1 环境感知包含读取 constitution.md 的步骤
- [ ] constitution 内容已写入 knowledge 表（category='convention'）

---

## S2：增加 Plan 阶段（技术方案）

**优先级**：高 — 这是当前工作流中最大的缺口
**涉及文件**：`PM-task-handling.md`、`PM-reference.md`、`PM.md`

### 现状

PM 从 Clarify 直接跳到 Confirm & Dispatch（`PM-task-handling.md:16-20`），中间没有技术设计产出。复杂功能没有经过设计评审就直接开工，DEV 拿到的 directive 缺少实现指导，返工风险极高。

### 改动点

#### 1. 在 PM-task-handling.md 中增加 Step 2.5 — Plan

在 Step 2（Clarify）和 Step 3（Confirm & Dispatch）之间插入：

```markdown
**Step 2.5 — Plan（技术方案，复杂需求必做）**：

判断标准：如果需求涉及 ≥2 个模块的变更、需要新的数据模型、或 PM 自身无法确定实现路径，
则必须执行此步骤。简单 UI 调整或文案修改可跳过。

1. PM 发一条 system 消息给 DEV，要求 DEV 阅读 spec 后输出技术方案（不动代码），内容包括：
   - 涉及的文件/模块清单（新增/修改）
   - 数据模型变更（如有）
   - 接口契约（API endpoint / 组件 props / 函数签名）
   - 关键实现思路和风险点
2. DEV 返回技术方案后，PM 审阅并与用户确认
3. 确认后将技术方案追加到 spec 文件的 `## 技术方案` 章节
4. 后续 directive 中必须引用该技术方案
```

#### 2. 扩展 Feature Spec 格式

在 `PM-reference.md:60-83` 的 Feature Spec 模板中增加可选章节：

```markdown
## 技术方案（复杂需求必填）

### 涉及模块

- [模块/文件路径]: [新增/修改] - [变更说明]

### 数据模型（如有变更）

[表/类型定义的变更描述]

### 接口定义（如有新增）

[API endpoint / 组件 props / 函数签名]

### 实现要点

[关键实现思路、依赖关系、风险点]
```

#### 3. 引入"DEV 出方案"的消息类型

当前 messages 表的 type 枚举为 `directive | feedback | cancel_task | system | reflection`。可复用 `system` 类型，或新增 `plan_request` 类型，用于 PM 请求 DEV 出技术方案。

这样做的好处是：DEV 在出方案时可以阅读代码、查看项目结构，但不需要改代码。方案确认后再正式开工，避免了方向性错误。

### 验收标准

- [ ] `PM-task-handling.md` 包含 Step 2.5 — Plan 步骤
- [ ] Feature Spec 模板包含技术方案章节
- [ ] 复杂需求的 spec 文件中有技术方案记录
- [ ] PM 可以请求 DEV 出技术方案而非直接开工

---

## S3：充实 Directive 格式

**优先级**：高
**涉及文件**：`PM-reference.md`

### 现状

Directive 格式（`PM-reference.md:17-31`）只要求：所属子项目、任务背景、前置依赖、Spec 路径、验收标准。DEV 拿到的是一句"请做这个 feature"加上 spec 文件路径，但 directive 是 DEV 的**唯一主要信息来源**（因为每次零上下文新 session），信息密度严重不足。

### 改动点

扩展 Directive 格式，增加以下必填/条件必填字段：

```markdown
## Directive 格式

DEV 收到 directive 时是零上下文，directive 必须**完全自包含**：

- **所属子项目**：明确指出在哪个子项目执行
- **任务背景**：这个 feature 解决什么问题
- **前置依赖**：如果依赖已完成的 feature，说明依赖关系和当前代码状态
- **Spec 路径**：`.win-agent/docs/spec/xxx.md`
- **Spec 摘要**：将 spec 中的功能描述和验收标准直接内联到 directive 中（不要只写"见 Spec"）
- **涉及模块/文件**（条件必填，有技术方案时）：需要修改或新增的文件路径清单
- **技术要求**（条件必填，有技术方案时）：必须使用的技术方案、数据模型、接口定义
- **参考代码**（推荐）：项目中可参考的类似实现，帮助 DEV 理解代码风格和模式
- **验收标准**：从 task 表中完整列出，包括用户验收标准和技术验收标准
- **禁止出现"参考之前的讨论"等隐式引用，DEV 看不到之前的对话**
```

核心改动：将 spec 文件的关键内容**内联**到 directive 中，而不是只给一个路径让 DEV 自己去读。这是因为 DEV 零上下文启动后，能否主动去读 spec 文件取决于 AI 的自觉性，不可靠。

### 验收标准

- [ ] `PM-reference.md` 的 Directive 格式包含上述所有字段
- [ ] Directive 模板中包含 Spec 摘要内联（非仅路径引用）
- [ ] 有技术方案时，directive 中包含涉及模块和技术要求

---

## S4：强化 DEV 流程 — 强制读 Spec + 实现前确认

**优先级**：高
**涉及文件**：`DEV.md`

### 现状

`DEV.md` Phase 3 只要求读 `development.md` 和 `validation.md`（`DEV.md:49-50`），没有强制要求读 spec 文件。DEV 是否真的去读取并逐条对照验收标准，完全靠 AI 自觉。这直接导致"不完全实现就说完成"的问题。

### 改动点

#### 1. Phase 3 开头增加强制步骤

在 `DEV.md` Phase 3 的常规任务流程最前面插入：

```markdown
**常规任务（非脚手架、非文档更新）按以下顺序执行，全部通过后才能进入 Phase 4。**

0. **阅读 Spec**：如果 directive 中包含 spec 路径或 spec 摘要：
   a. 必须先 read 该 spec 文件，完整理解功能描述和每一条验收标准
   b. 如果 spec 中有技术方案章节，必须按照技术方案实现，不得自行另选方案
   c. 如发现 spec/directive 描述不清或互相矛盾，**先发阻塞消息给 PM，不要猜测性实现**
   d. 在开始编码前，对照验收标准列出自己的实现计划（内心检查，无需输出）

1. **开发**: 阅读 development.md 并按照其中步骤进行开发；
2. **验证**: 阅读 validation.md 并按照其中步骤进行验证...
```

#### 2. Phase 4 验收报告增加逐项对照

在 `DEV-reference.md` 的验收报告格式中强化：

```markdown
## 验收标准逐项确认

对照 spec 文件中的每一条验收标准，逐条列出：

- [标准原文]：✅ [具体证据：命令输出/截图/代码引用，不接受纯文字声明]
- [标准原文]：❌ [未实现的原因和计划]

**如有任何标准标记为 ❌，不得提交验收报告，必须先完成或发阻塞消息给 PM。**
```

### 验收标准

- [ ] `DEV.md` Phase 3 包含 Step 0 — 阅读 Spec
- [ ] DEV 在 spec 不清时先发阻塞消息而非猜测实现
- [ ] 验收报告格式要求逐条对照 spec 验收标准，禁止有 ❌ 项时提交

---

## S5：验收标准增加技术维度

**优先级**：中
**涉及文件**：`PM.md`、`PM-task-handling.md`

### 现状

`PM.md:10` 要求"验收标准必须是用户视角的技术描述"。这导致验收标准粒度粗（如"用户可以登录"），DEV 容易做个表面功能就报完成，PM 审核时也缺少具体的技术检查依据。

### 改动点

#### 1. 修改 PM.md 中的验收标准原则

将 `PM.md:10` 改为：

```markdown
- 验收标准分两层：
  1. **用户验收标准**：用户视角的可感知行为（如"用户可以通过邮箱登录"）
  2. **技术验收标准**：具体的技术检查项（如"登录 API 返回 JWT token 且 token 有效期为 7 天"、
     "密码使用 bcrypt 加密存储"、"新增登录相关单元测试且覆盖正常/异常场景"）
- 对于涉及数据模型、API、安全性的功能，技术验收标准为必填
```

#### 2. 修改 Feature Spec 模板

在 `PM-reference.md:60-83` 的验收标准部分改为：

```markdown
## 验收标准

### 用户验收

- [ ] [用户视角的可验证条件]

### 技术验收

- [ ] [技术层面的检查项：API 行为、数据正确性、测试覆盖、性能指标等]
```

#### 3. 同步修改 PM 的验收审核

`PM.md:73`（验收标准覆盖）改为逐条对照双层标准，技术验收标准也需要有对应的验证证据。

### 验收标准

- [ ] `PM.md` 的验收标准原则包含用户验收 + 技术验收双层要求
- [ ] Feature Spec 模板包含双层验收标准
- [ ] PM 验收审核时对技术验收标准也要求证据

---

## S6：Prompt Builder 注入更丰富的上下文

**优先级**：高
**涉及文件**：`engine/prompt-builder.ts`、`engine/dispatcher.ts`

### 现状

`prompt-builder.ts:93-108` 为 DEV 注入的 task context 只有标题、描述、验收标准和依赖关系。Spec 文件内容不会被注入，DEV 是否读取 spec 完全靠 AI 自觉。即使 directive 中包含 spec 路径，DEV 也可能因为"上下文不够"而跳过阅读。

### 改动点

#### 1. 自动注入 Spec 文件内容

在 `prompt-builder.ts` 的 `buildDispatchPrompt` 函数中，为 DEV 的 dispatch 自动读取并注入 spec 文件内容：

```typescript
// 在 getTaskContext 中或 buildDispatchPrompt 中增加 spec 注入逻辑
function getSpecContent(taskContext: TaskContext): string | null {
  // 从 task description 或 knowledge 表中解析 spec 路径
  // 如果路径匹配 .win-agent/docs/spec/*.md，读取文件内容返回
  const specPathMatch = taskContext.description?.match(/\.win-agent\/docs\/spec\/[\w-]+\.md/);
  if (!specPathMatch) return null;

  try {
    const specPath = path.join(workspace, specPathMatch[0]);
    return fs.readFileSync(specPath, 'utf-8');
  } catch {
    return null;
  }
}

// 在 buildDispatchPrompt 的 task context 部分追加
if (taskContext && role === Role.DEV) {
  const specContent = getSpecContent(taskContext);
  if (specContent) {
    parts.push(`## Feature Spec（完整内容）\n${specContent}`);
  }
}
```

#### 2. 注入前置依赖任务的完成摘要

当 task 有已完成的前置依赖时，从 memory 表查询对应的 `task_complete` 记忆并注入：

```typescript
// 在 taskContext.dependencies 中，对 status='done' 的依赖
// 查询 memory 表获取 task_complete 记忆
if (taskContext.dependencies.some((d) => d.status === 'done')) {
  const completedDeps = taskContext.dependencies.filter((d) => d.status === 'done');
  for (const dep of completedDeps) {
    const memories = select('memory', {
      role: 'DEV',
      trigger: 'task_complete',
    }).filter((m) => m.content.includes(`task#${dep.id}`));
    if (memories.length > 0) {
      parts.push(`## 前置任务 task#${dep.id} 完成摘要\n${memories[0].content}`);
    }
  }
}
```

#### 3. 注入 constitution 约束

如果 constitution.md 存在，将其关键约束注入 DEV 的 dispatch prompt：

```typescript
if (role === Role.DEV) {
  const constitutionPath = path.join(workspace, '.win-agent', 'docs', 'constitution.md');
  if (fs.existsSync(constitutionPath)) {
    const constitution = fs.readFileSync(constitutionPath, 'utf-8');
    parts.push(`## 项目约束（constitution）\n${constitution}`);
  }
}
```

### 验收标准

- [ ] DEV dispatch 时自动注入 spec 文件完整内容（如存在）
- [ ] DEV dispatch 时注入前置依赖任务的完成摘要（如有）
- [ ] DEV dispatch 时注入 constitution.md 内容（如存在）
- [ ] prompt-builder 的 spec 注入在 spec 文件不存在时静默跳过，不报错

---

## S7：任务拆解增加用户审批关口

**优先级**：中
**涉及文件**：`PM-task-handling.md`

### 现状

PM 在 Step 3 Confirm & Dispatch 中，一步完成了"展示 Spec → 用户确认 → 拆 task 入库 → 发 directive"（`PM-task-handling.md:16-20`）。用户确认的是 Spec，但看不到完整的任务拆解清单。PM 可能把一个大需求拆成不合理的 task 粒度，用户完全不知情。

### 改动点

将 Step 3 拆为两个子步骤：

```markdown
**Step 3a — Confirm Spec**：展示最终 Spec 给用户，等待用户明确确认。确认后：

1. 写入 `.win-agent/docs/spec/<feature-slug>.md`
2. 写入知识库（category='requirement'）

**Step 3b — Review Tasks & Dispatch**：

1. 列出详细的任务拆分计划，包括：
   - 每个 task 的标题和简要描述
   - task 之间的依赖关系
   - 建议的执行顺序
   - 每个 task 的验收标准概要
2. **等待用户确认**任务拆分方案（用户可调整优先级、合并/拆分 task、增删 task）
3. 用户确认后再写入 tasks 表 + 发 directive 给 DEV
```

### 验收标准

- [ ] `PM-task-handling.md` Step 3 拆为 3a（Spec 确认）和 3b（任务拆分确认）
- [ ] PM 在用户确认任务拆分前不写入 tasks 表
- [ ] PM 在用户确认任务拆分前不发 directive

---

## S8：集成 SDD.md 到工作流

**优先级**：中
**涉及文件**：`src/workspace/init.ts`、`PM.md`

### 现状

`src/templates/SDD.md` 已经写好了 SDD 方法论摘要，但：

- init 时不会拷贝到工作区（`init.ts:52` 只拷贝 `roles/` 下的 `.md` 文件）
- `PM.md` 和 `DEV.md` 均未引用
- 等于一份"死文档"

### 改动点

#### 1. init 时拷贝 SDD.md 到工作区

在 `workspace/init.ts` 的 `initWorkspace` 函数中，增加拷贝 `SDD.md` 到 `.win-agent/docs/` 的逻辑：

```typescript
// 在 copyTemplates(roles) 之后
const sddSrc = path.join(templatesDir, 'SDD.md');
const sddDest = path.join(winAgentDir, 'docs', 'SDD.md');
if (fs.existsSync(sddSrc) && !fs.existsSync(sddDest)) {
  const docsDir = path.join(winAgentDir, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  fs.copyFileSync(sddSrc, sddDest);
}
```

#### 2. PM.md 中引用 SDD 方法论

在 `PM.md` 的核心原则部分增加：

```markdown
- 需求管理遵循 SDD（规格驱动开发）方法论，详见 `.win-agent/docs/SDD.md`
- 核心流程：Specify → Clarify → Plan（复杂需求） → Confirm → Tasks → Implement
```

### 验收标准

- [ ] init 后 `.win-agent/docs/SDD.md` 存在
- [ ] `PM.md` 引用了 SDD 方法论

---

## S9：Git 分支管理（per-feature）

**优先级**：低
**涉及文件**：`PM-task-handling.md`、`DEV.md`

### 现状

DEV 直接在当前分支上提交代码（`DEV.md:65`），没有 per-feature 的分支隔离。多个 feature 并行开发时代码混在一起，难以独立审查和回滚。

### 改动点

#### 1. PM 在 Dispatch 时创建分支

在 `PM-task-handling.md` Step 3b 中增加：

```markdown
- 发 directive 前，在 directive 内容中指定分支名：`feat/<feature-slug>`
- DEV 收到 directive 后，先创建并切换到该分支
```

#### 2. DEV 流程中增加分支操作

在 `DEV.md` Phase 2 收到 directive 时：

```markdown
- 如果 directive 中指定了分支名，执行：
  git checkout -b <branch-name> 或 git checkout <branch-name>（如已存在）
```

在 `DEV.md` Phase 4 收尾时：

```markdown
- 提交代码后，切回主分支：git checkout main
```

### 验收标准

- [ ] PM 的 directive 中包含分支名字段
- [ ] DEV 在指定分支上开发和提交
- [ ] DEV 收尾后切回主分支

---

## S10：Spec 版本化管理

**优先级**：低
**涉及文件**：`PM-reference.md`、`PM-task-handling.md`

### 现状

spec 文件以 `<slug>.md` 扁平存放在 `.win-agent/docs/spec/` 下（`PM-reference.md:62`），需求变更时直接覆盖，没有版本追踪。

### 改动点

采用带序号的目录结构：

```
.win-agent/docs/spec/
├── 001-user-login/
│   ├── spec.md
│   └── plan.md（如有技术方案）
├── 002-photo-upload/
│   ├── spec.md
│   └── plan.md
```

版本迭代时创建新版本：

```
.win-agent/docs/spec/
├── 001-user-login-v1/
│   └── spec.md
├── 001-user-login-v2/    # 需求变更后的新版本
│   ├── spec.md
│   └── changelog.md      # 与 v1 的差异说明
```

### 验收标准

- [ ] spec 文件按编号目录组织
- [ ] 需求变更时创建新版本而非覆盖
- [ ] 历史版本保留

---

## S11：系统级验收门禁（远期）

**优先级**：低
**涉及文件**：`engine/dispatcher.ts` 或新增 `engine/acceptance-gate.ts`

### 现状

验收完全靠 PM AI 阅读 DEV 的文字描述来判断（`PM.md:69-83`）。DEV 的验收报告是"自述式"的，PM 拿到的是 DEV 声称的结果而非系统实际跑出的结果。虽然 PM 要求"必须有实际命令输出"，但 PM 无法验证这些输出是否真实。

### 改动点（远期方案）

在 DEV 提交验收报告后、PM 审核前，由系统自动执行一次验收：

```
DEV 提交验收报告
  → 系统自动执行 validation.md 中定义的代码检查命令
  → 将实际输出结果注入到 PM 的审核上下文中
  → PM 拿到的是 DEV 的报告 + 系统的实际结果，两相对照审核
```

这需要 engine 层新增一个"验收门禁"模块，在 DEV 发出 `验收报告` 类型的 feedback 后自动触发。

### 验收标准

- [ ] DEV 提交验收报告后，系统自动执行 lint/build/test
- [ ] 自动执行结果注入到 PM 收到的 feedback 消息中
- [ ] 自动执行失败时不阻塞 PM 审核，但附带警告

---

## S12：修复 PM 0-to-1 项目误判

**优先级**：高 — 误判会导致 PM 对已有代码的项目执行技术选型和脚手架流程，破坏性极大
**涉及文件**：`PM.md`、`PM-reference.md`、`cli/init.ts`（可选）

### 现状

PM 判定是否为 0-to-1 项目有**两条路径**，都有缺陷：

| 判定路径               | 位置                | 逻辑                                                      | 问题         |
| ---------------------- | ------------------- | --------------------------------------------------------- | ------------ |
| 路径 A（正式条件）     | `PM-reference.md:5` | `project_mode='greenfield'` **且** tasks 表无 `done` 记录 | 见下方分析   |
| 路径 B（环境感知推断） | `PM.md:25`          | `overview.md` 不存在 → "可认为是 0-to-1 项目启动场景"     | **严重问题** |

#### 路径 A 的问题：`project_mode` 写入逻辑与条件不严谨

`project_mode` 只有在 init 检测到**空目录**时才会写入（`init.ts:356-377`）：

```
detectExistingCode() == false → 用户选 greenfield/pending → 写入 project_config
detectExistingCode() == true  → projectMode='existing' 但不写入 project_config
```

即：**对于已有代码的项目，`project_mode` 这个 key 根本不存在于 project_config 表中**。这意味着 PM 查询 `project_mode` 时查不到记录，需要有明确的兜底策略。

更关键的是，路径 A 的第二个条件"tasks 表无 `done` 记录"是不严谨的。在已有项目中 init 后首次启动，tasks 表必然为空——但项目已有大量代码，根本不需要走启动流程。**tasks 表无 done 记录只能说明"还没有通过 win-agent 完成过任务"，不代表"项目从零开始"。**

#### 路径 B 的问题：文件存在性推断不可靠

`PM.md:25` 写的是"如果没有 overview.md，可认为是 0-to-1 项目启动场景"。但 overview.md 不存在可能是因为：

1. **init 时 AI 分析失败**（`init.ts:509-514` 的 catch 块会跳过）
2. **overview.md 被误删或损坏**
3. **existing 项目重新 init 但跳过了 AI 分析**

这三种场景下项目都有代码，PM 却会误判为 greenfield，开始搞技术选型和脚手架。

#### 两条路径叠加的最坏情况

PM 在 Phase 1 走了路径 B（overview.md 不存在 → 判定为 greenfield），直接跳转到启动流程，根本不会去查 `project_config.project_mode`。即使路径 A 的条件本身是准确的，PM 也会绕过它。

### 改动点

#### 1. 修改 PM.md Phase 1 环境感知 — 去除文件存在性推断，用 project_config 作为唯一判据

将 `PM.md:25`：

```markdown
1. 阅读 `.win-agent/docs/overview.md` 了解项目基本概况，如果没有该文件，可认为是 0-to-1 项目启动场景
```

改为：

```markdown
1. 查询 project_config 表（key='project_mode'），确认项目模式：
   - `greenfield`：可能是 0-to-1 项目（仍需通过下方特殊情况的完整条件判定）
   - `existing`、`pending`、或 **无记录**：非 greenfield，**禁止执行项目启动流程**
2. 阅读 `.win-agent/docs/overview.md` 了解项目基本概况（如不存在，跳过，**不影响项目模式判断**）
3. 查询 tasks 表，了解各 feature 当前状态，建立项目全局视图
4. 如需更多历史上下文，主动查询 messages 表补充
```

核心变化：

- **只有 `project_mode='greenfield'` 才可能触发启动流程**
- **无记录视为 existing（保守策略）**——因为 `init.ts` 对 existing 项目不写 project_mode
- **overview.md 不存在不再作为判定依据**

#### 2. 修改 PM.md 特殊情况触发条件 — 收紧并增加代码检查

将 `PM.md:19`：

```markdown
**特殊情况：** 如果 Phase 1 环境感知后判定为 0-to-1 项目启动场景（见触发条件），则先阅读 PM-reference.md 中「项目启动流程」章节
```

改为：

```markdown
**特殊情况：** 仅当同时满足以下**全部条件**时，才进入项目启动流程：

1. project_config.project_mode = 'greenfield'
2. tasks 表中无 title 包含 `[scaffold]` 且 status='done' 的记录（即脚手架尚未完成）
3. 执行 `ls` 或 `git log --oneline -3` 确认项目根目录**确实没有**业务代码文件

三个条件全部满足 → 阅读 PM-reference.md 中「项目启动流程」章节执行。
**任一条件不满足 → 按常规 Phase 2 继续，禁止执行启动流程。**
特别注意：overview.md 不存在、tasks 表为空，都**不是**判定 greenfield 的依据。
```

核心变化：

- 将"tasks 表无 done 记录"收紧为"无 `[scaffold]` done 记录"——这才是真正要判断的条件（脚手架是否已搭建）
- 增加第三道防线：直接检查文件系统，确认真的没有代码

#### 3. 同步修改 PM-reference.md 的触发条件

将 `PM-reference.md:5`：

```markdown
**触发条件**: project_config 中 `project_mode='greenfield'` 且 tasks 表无 `status='done'` 的记录。
```

改为：

```markdown
**触发条件**（必须全部满足）:

1. project_config 中 `project_mode='greenfield'`
2. tasks 表中无 title 包含 `[scaffold]` 且 `status='done'` 的记录
3. PM 已通过 `ls` / `git log` 确认项目根目录无业务代码

**任一不满足则禁止执行本流程。**
```

#### 4.（可选）init.ts 补写 existing 项目的 project_mode

当前 `init.ts:357` 对 existing 项目不写 `project_mode`，导致 PM 查询时查不到记录。可以在 `if (!hasCode)` 块之后补一个 else：

```typescript
} else {
  // existing 项目：显式写入 project_mode，让 PM 能查到
  const existingMode = dbSelect<{ key: string; value: string }>('project_config', {
    key: 'project_mode',
  });
  if (existingMode.length > 0) {
    dbUpdate('project_config', { key: 'project_mode' }, { value: 'existing' });
  } else {
    dbInsert('project_config', { key: 'project_mode', value: 'existing' });
  }
}
```

这样 PM 查询 `project_mode` 时一定能查到值，不需要依赖"无记录 → 视为 existing"的兜底逻辑。

### 验收标准

- [ ] `PM.md` Phase 1 不再用 overview.md 文件存在性判定项目模式
- [ ] `PM.md` 用 `project_config.project_mode='greenfield'` 作为启动流程的**必要条件**
- [ ] `PM.md` 无 project_mode 记录时视为 existing，不触发启动流程
- [ ] 启动流程触发条件从"tasks 表无 done 记录"收紧为"无 scaffold done 记录 + 文件系统确认无代码"
- [ ] `PM-reference.md` 触发条件与 `PM.md` 一致
- [ ] （可选）`init.ts` 对 existing 项目显式写入 `project_mode='existing'`
- [ ] existing 项目即使 overview.md 不存在、tasks 表完全为空，PM 也不会进入启动流程

---

## 执行顺序

```
S3  充实 Directive 格式  ──┐
S4  强化 DEV 流程         ──┤── 第一批（直接改模板文件，零代码改动，立竿见影）
S5  双层验收标准          ──┤
S12 修复 PM 0-to-1 误判  ──┘

S6 Prompt Builder 增强   ──── 第二批（需要改 prompt-builder.ts，代码改动量中等）

S2 增加 Plan 阶段        ──┐
S7 任务拆解审批关口      ──┤── 第三批（改 PM 工作流模板，需要测试 PM 行为变化）
S1 增加 Constitution     ──┘

S8 集成 SDD.md           ──── 第四批（改 init.ts + PM.md，改动量小）

S9  Git 分支管理         ──┐
S10 Spec 版本化          ──┤── 第五批（低优先级，可根据实际使用效果决定是否实施）
S11 系统级验收门禁       ──┘
```

**第一批优先级最高**，因为只需要修改 markdown 模板文件，不涉及代码改动，改完重启 engine 即可生效。S12 归入第一批是因为误判问题破坏性大且修复方式同样是改模板。

---

## 验收总览

| 阶段 | 核心改动        | 关键指标                                                       |
| ---- | --------------- | -------------------------------------------------------------- |
| S1   | constitution.md | init 后存在 constitution 文件；PM 决策前查阅约束               |
| S2   | Plan 阶段       | 复杂需求有技术方案产出；directive 中引用技术方案               |
| S3   | Directive 格式  | directive 包含 spec 摘要内联 + 涉及模块 + 技术要求             |
| S4   | DEV 流程        | DEV 强制读 spec；spec 不清时先发阻塞而非猜测实现               |
| S5   | 双层验收标准    | spec 和 task 包含用户验收 + 技术验收双层标准                   |
| S6   | Prompt 注入     | DEV dispatch 自动注入 spec 内容 + 前置任务摘要 + constitution  |
| S7   | 任务审批        | PM 在用户确认任务拆分前不发 directive                          |
| S8   | SDD 集成        | init 后 SDD.md 在工作区；PM.md 引用 SDD 方法论                 |
| S9   | Git 分支        | DEV 在 per-feature 分支上开发                                  |
| S10  | Spec 版本       | spec 按编号目录组织，变更时保留历史版本                        |
| S11  | 验收门禁        | DEV 提交报告后系统自动跑验证，结果注入 PM 审核上下文           |
| S12  | 0-to-1 误判修复 | PM 用 project_config.project_mode 判定，不再依赖文件存在性推断 |
