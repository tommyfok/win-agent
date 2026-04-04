# win-agent 开发计划

> 基于 [win-agent-design](../win-agent-design/) 设计文档，从零实现 win-engine 调度引擎。
> V1 目标：全串行调度，跑通完整的消息驱动工作流。

## 技术栈

| 层级 | 选型 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js |
| 包管理 | pnpm |
| 数据库 | SQLite (better-sqlite3) + sqlite-vec |
| LLM 调度 | @opencode-ai/sdk |
| CLI 框架 | Commander.js |
| 交互式提示 | @inquirer/prompts |
| Embedding | 可配置（OpenAI / 其他） |
| 构建 | tsup (打包为 npx 可执行) |

## 目录结构

```
win-agent/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts                    # CLI 入口 (npx win-engine)
│   ├── cli/                        # CLI 命令层
│   │   ├── check.ts                # 环境检查 (npx win-engine)
│   │   ├── start.ts                # 启动引擎
│   │   ├── talk.ts                 # 打开 PM 对话
│   │   ├── status.ts               # 查看状态
│   │   ├── cancel.ts               # 取消工作流
│   │   └── stop.ts                 # 停止引擎
│   ├── engine/                     # 引擎核心
│   │   ├── scheduler.ts            # 调度器 (主循环 + 消息轮询)
│   │   ├── session-manager.ts      # Session 管理器
│   │   ├── role-manager.ts         # 角色状态管理
│   │   ├── dispatcher.ts           # 消息调度 (dispatchToRole + prompt 组装)
│   │   ├── auto-trigger.ts         # 自动触发检测
│   │   ├── workflow-checker.ts     # 工作流完成检测
│   │   └── memory-rotator.ts       # Session 轮转 + 记忆写入/回忆
│   ├── db/                         # 数据库层
│   │   ├── connection.ts           # SQLite 连接 + sqlite-vec 加载
│   │   ├── schema.ts               # 建表 DDL + 默认数据
│   │   ├── repository.ts           # 通用 CRUD 封装
│   │   └── permissions.ts          # 角色权限默认数据
│   ├── embedding/                  # Embedding 层
│   │   ├── index.ts                # 统一接口
│   │   └── openai.ts               # OpenAI embedding 实现
│   ├── workspace/                  # 工作空间管理
│   │   ├── init.ts                 # .win-agent/ 目录初始化
│   │   ├── sync-agents.ts          # roles → .opencode/agents 同步
│   │   └── import.ts               # 项目上下文导入 (代码扫描/资料/约束)
│   ├── config/                     # 配置管理
│   │   └── index.ts                # ~/.win-engine/config.json 读写
│   ├── tools/                      # opencode 自定义工具 (复制到 .opencode/tools/)
│   │   └── database.ts             # database_query / database_insert / database_update
│   └── templates/                  # 静态资源
│       ├── roles/                  # 角色 prompt 模板
│       │   ├── PM.md
│       │   ├── SA.md
│       │   ├── DEV.md
│       │   ├── QA.md
│       │   └── OPS.md
│       └── workflows/              # 流程模板
│           ├── new-feature.json
│           ├── bug-fix.json
│           └── iteration-review.json
```

---

## 开发阶段

### 阶段 1：项目脚手架 + 基础设施

**目标**：项目可构建、可运行，数据库可读写。

#### 1.1 项目初始化
- [x] `package.json`（name: win-engine, bin: win-engine）
- [x] `tsconfig.json`
- [x] `tsup.config.ts`（入口 src/index.ts，输出 dist/）
- [x] 安装依赖：`better-sqlite3`, `commander`, `@inquirer/prompts`, `tsup`, `typescript`
- [x] `src/index.ts`：Commander 注册所有子命令的骨架

#### 1.2 配置管理 (`src/config/index.ts`)
- [x] `loadConfig()` / `saveConfig()`：读写 `~/.win-engine/config.json`
- [x] 配置结构：`workspace`, `provider`（type/apiKey/model）, `embedding`（type/apiKey/model）
- [x] PID 锁文件管理：`~/.win-engine/engine.pid` 的读写和冲突检测

#### 1.3 数据库层 (`src/db/`)
- [x] `connection.ts`：打开 `.win-agent/win-agent.db`，加载 sqlite-vec 扩展
- [x] `schema.ts`：建表 SQL（参考 [architecture.md 数据库 Schema](../win-agent-design/docs/architecture.md#数据库-schema)），含 9 张表
- [x] `permissions.ts`：默认角色权限数据（参考 [architecture.md 默认角色权限](../win-agent-design/docs/architecture.md#默认角色权限)）
- [x] `repository.ts`：通用 `select()` / `insert()` / `update()` / `delete()` 封装，支持 where 条件、orderBy、limit

#### 1.4 工作空间初始化 (`src/workspace/init.ts`)
- [x] 创建 `.win-agent/` 目录结构（db, roles/, workflows/, attachments/, backups/）
- [x] 从 `src/templates/` 复制角色 prompt 和流程模板到 `.win-agent/`
- [x] 执行建表 + 写入默认权限 + 写入初始 project_config
- [x] 补建检测：已存在时只补缺失的表，不丢数据

#### 1.5 静态资源准备
- [x] 将 [win-agent-design/roles/*.md](../win-agent-design/roles/) 的 5 个角色 prompt 复制到 `src/templates/roles/`
- [x] 将 [win-agent-design/workflows/*.json](../win-agent-design/workflows/) 的 3 个流程模板复制到 `src/templates/workflows/`

---

### 阶段 2：CLI 命令实现

**目标**：所有 CLI 命令可用，但引擎核心逻辑先用 stub。

参考：[cli.md](../win-agent-design/docs/cli.md)

#### 2.1 `npx win-engine`（环境检查）
- [x] 检查 `~/.win-engine/config.json` 中 workspace 配置
- [x] 检查 provider/model 配置
- [x] 检查 embedding 配置
- [x] 未配置项进入交互式引导（@inquirer/prompts）

#### 2.2 `npx win-engine start`
六个阶段串行执行：
- [x] 冲突检测：检查 PID 锁文件
- [x] 环境检查：复用 2.1 的检查逻辑
- [x] 工作空间初始化：调用 1.4 的 init
- [x] 首次启动引导：交互式输入项目名称和描述，写入 project_config
- [x] 项目上下文导入（可跳过）：
  - [x] 已有代码扫描（stub — 调用 SA session 生成技术概览，待阶段 3）
  - [x] 参考资料导入（遍历目录，分类写入 knowledge 表）
  - [x] 技术约束声明（写入 project_config.constraints + knowledge）
- [x] Session 初始化：stub — 为 PM/SA/OPS 创建 session 并注入身份，回忆记忆（待阶段 3）

#### 2.3 `npx win-engine talk`
- [x] 检查引擎是否运行
- [x] 获取 PM session ID（stub — 待阶段 3 SessionManager）
- [x] 拼接 URL `http://localhost:{port}/session/{pm-session-id}`
- [x] 调用系统默认浏览器打开

#### 2.4 `npx win-engine status`
- [x] 查询 workflow_instances（active）
- [x] 查询 tasks 按 status 分组统计
- [x] 查询 messages 最近 5 条
- [x] 格式化输出（参考 [cli.md status 示例](../win-agent-design/docs/cli.md#npx-win-engine-status)）

#### 2.5 `npx win-engine cancel <workflow_id>`
- [x] 查询目标 workflow_instance
- [x] 展示关联任务概览 + 二次确认
- [x] 更新 workflow 状态为 cancelled
- [x] 进行中任务 → cancelled，已完成任务保留
- [x] 写 system 消息通知 PM

#### 2.6 `npx win-engine stop`
- [x] 触发所有角色写记忆（stub — trigger='engine_stop'，待阶段 3）
- [x] 清理 PID 锁文件
- [x] 退出进程

---

### 阶段 3：opencode 集成层

**目标**：能通过 opencode SDK 创建 session、发送 prompt、获取响应。

参考：[implementation.md 进程模型](../win-agent-design/docs/implementation.md#1-进程模型)

#### 3.1 opencode Server 启动
- [x] 通过 `@opencode-ai/sdk` 的 `createOpencode()` 启动 server
- [x] 传入 provider 配置（从 config 读取）
- [x] 健康检查等待 server 就绪

#### 3.2 Agent 配置同步 (`src/workspace/sync-agents.ts`)
- [x] 读取 `.win-agent/roles/*.md`（纯 prompt 内容）
- [x] 为每个角色加上 opencode frontmatter（tools, permission 配置）
  - PM/SA：无文件操作工具，有 database 工具
  - DEV：全部工具，edit/bash allow
  - QA：bash（git diff, npm test），database 工具
  - OPS：read/write 仅限 .win-agent/ 目录，database 工具
- [x] 输出到 `.opencode/agents/*.md`
- [x] 参考 [implementation.md 工具权限配置](../win-agent-design/docs/implementation.md#工具权限按角色配置)

#### 3.3 自定义工具部署 (`src/tools/database.ts`)
- [x] 实现 `database_query`：查询数据库，内部权限校验
- [x] 实现 `database_insert`：插入记录，内部权限校验
- [x] 实现 `database_update`：更新记录，内部权限校验
- [x] 部署到 `.opencode/tools/database.ts`
- [x] 权限校验逻辑：查询 role_permissions 表，匹配 role + table + operation + conditions
- [x] 参考 [implementation.md 自定义工具](../win-agent-design/docs/implementation.md#6-自定义工具数据库操作)

#### 3.4 Session 管理器 (`src/engine/session-manager.ts`)
- [x] `activeSessions: Map<string, string>`（role → sessionId）
- [x] `taskSessions: Map<number, string>`（taskId → sessionId）
- [x] `getSession(role)`：获取 PM/SA/OPS 的当前 session
- [x] `getTaskSession(taskId, role)`：为 DEV/QA 按需创建任务 session
- [x] `rotateSession(role, sessionId, taskId?)`：写记忆 → 新建 session → 回忆
- [x] `releaseTaskSession(taskId)`：任务完成后清理
- [x] 参考 [implementation.md Session 管理器](../win-agent-design/docs/implementation.md#session-管理器)

---

### 阶段 4：Embedding + 向量检索

**目标**：知识库和记忆支持语义搜索。

参考：[implementation.md 向量检索](../win-agent-design/docs/implementation.md#8-向量检索)

#### 4.1 Embedding 接口 (`src/embedding/`)
- [x] 定义统一接口 `generateEmbedding(text: string): Promise<number[]>`
- [x] 实现 OpenAI embedding adapter（text-embedding-3-small）
- [x] 实现本地 embedding adapter（@huggingface/transformers, bge-small-zh-v1.5, 512 维）
- [x] 从 config 读取 embedding provider 配置（支持 local / openai）

#### 4.2 知识库向量检索
- [x] 写入 knowledge 时自动生成 embedding（insertKnowledge）
- [x] `queryRelevantKnowledge(text, category?, limit?)`：category 精确过滤 + 向量排序
- [x] 使用 sqlite-vec 的 KNN MATCH 查询

#### 4.3 记忆向量检索
- [x] 写入 memory 时基于 summary 生成 embedding（insertMemory）
- [x] `buildRecallPrompt(role, currentContext)`：7 天内记忆 + 向量相似度排序 + 摘要注入
- [x] 7-30 天记忆仅高相似度时召回（distance < 0.3），30 天以上清理（cleanExpiredMemories）

---

### 阶段 5：引擎核心——调度器 + 消息分发

**目标**：主循环跑通，能轮询消息并触发角色工作。

参考：[implementation.md 引擎主循环](../win-agent-design/docs/implementation.md#4-引擎主循环)、[消息调度](../win-agent-design/docs/implementation.md#5-消息调度引擎如何触发角色)

#### 5.1 角色状态管理 (`src/engine/role-manager.ts`)
- [x] `busyRoles: Set<string>`
- [x] `isBusy(role)` / `setBusy(role, busy)`

#### 5.2 消息调度 (`src/engine/dispatcher.ts`)
- [x] `dispatchToRole(client, sessionManager, role, messages)`：
  1. 获取或创建 session
  2. 查询相关知识库条目（向量检索）
  3. 查询当前工作流阶段信息
  4. 组装 prompt（`buildDispatchPrompt`）
  5. 调用 `session.prompt()`
  6. 标记消息为 read
  7. 检查上下文占用率，必要时轮转 session
- [x] `buildDispatchPrompt(role, messages, knowledge, workflowContext)`：
  - 待处理消息区
  - 当前工作流上下文区（模板 + 阶段 + roles_guide）
  - 相关知识库区
  - 操作提示区

#### 5.3 自动触发检测 (`src/engine/auto-trigger.ts`)
- [x] 检查迭代回顾触发条件：
  - 当前迭代所有任务 done → 触发 OPS
  - 打回率 > 30% → 触发 OPS
- [x] 防止重复触发（记录已触发的 workflow_id + 条件）

#### 5.4 工作流完成检测 (`src/engine/workflow-checker.ts`)
- [x] 遍历 active workflow_instances
- [x] 加载对应流程模板的 completion.condition
- [x] new-feature / bug-fix：关联任务全部 done → 推进到 done 阶段 + 通知 PM
- [x] iteration-review：PM 完成归档 → 更新 workflow + iteration 状态

#### 5.5 调度器主循环 (`src/engine/scheduler.ts`)
- [x] `mainLoop(client, sessionManager)`：
  1. 遍历 ALL_ROLES，检查未读消息
  2. 空闲角色有消息 → setBusy → dispatchToRole → setIdle
  3. checkAutoTriggers()
  4. checkWorkflowCompletion()
  5. sleep(1000) 避免空转
- [x] PM 的特殊处理：当 PM busy 时，角色消息排队等待
- [x] V1 串行：每轮只处理一个角色

#### 5.6 Session 轮转 (`src/engine/memory-rotator.ts`)
- [x] 检测上下文占用率 > 60%
- [x] 向当前 session 发送"写记忆"指令 → 角色总结当前工作
- [x] 记忆写入 memory 表（含 embedding）
- [x] 创建新 session → 注入身份 → 回忆相关记忆
- [x] 更新 session 映射

---

### 阶段 6：端到端流程打通

**目标**：跑通一个完整的 new-feature 工作流。

#### 6.1 启动流程串联
- [x] `win-engine start` 完整流程：环境检查 → 初始化 → opencode 启动 → agent 同步 → session 创建 → 主循环启动
- [x] `win-engine talk` 打开浏览器 → 用户与 PM 对话

#### 6.2 new-feature 工作流验证
按 [README.md 核心工作流程](../win-agent-design/README.md#核心工作流程) 逐步验证：
- [x] 用户与 PM 对话描述需求 → PM 写入 knowledge + 发消息给 SA
- [x] 调度器检测到 SA 有消息 → 触发 SA session → SA 设计方案 + 拆分任务
- [x] SA 发消息给 PM 审核 → PM 审核通过 → PM 发消息给 DEV
- [x] DEV 领取任务 → 编码 → 自测 → 发消息给 QA
- [x] QA 验收 → 通过/打回 → 消息流转
- [x] 所有任务完成 → 引擎检测 → 通知 PM → PM 向用户汇报

#### 6.3 bug-fix 工作流验证
- [x] 用户报告 Bug → PM 确认 → SA 分析 → DEV 修复 → QA 验证 → PM 反馈

#### 6.4 中断恢复验证
- [x] `win-engine stop` 后重新 `start`，验证记忆回忆和工作流恢复
- [x] 检查 active workflow 被正确恢复

---

### 阶段 7：Onboarding + Proposal + 角色自我反思

**目标**：首次启动时通过 PM 引导用户定制团队角色；角色具备自我反思能力；提供异步提案通道供角色上报非紧急但重要的事项。

#### 7.1 Proposals 表 (`src/db/schema.ts`)

新增 `proposals` 表——角色到用户的异步提案通道，用于"不阻塞当前工作、但用户迟早该知道"的事项：

```sql
CREATE TABLE IF NOT EXISTS proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'suggestion',  -- suggestion / question / risk / improvement
  submitted_by TEXT NOT NULL,                       -- 提交角色
  status      TEXT NOT NULL DEFAULT 'pending',      -- pending / accepted / rejected / archived
  resolution  TEXT,                                 -- PM 处理后的说明
  related_task_id     INTEGER REFERENCES tasks(id),
  related_workflow_id INTEGER REFERENCES workflow_instances(id),
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)
```

**定位**：区别于 messages（紧急/阻塞 → 走消息找 PM 立即处理），proposals 是非紧急的异步通道。角色在任何时候发现值得上报的事项都可以写入，不需要特定触发时机。

**典型场景**：
- SA 设计方案时发现两种路线各有利弊，选了一种但想让用户知道 trade-off
- DEV 实现中发现某个需求可能有更好的做法，但不在当前任务范围内
- QA 验收时发现验收标准之外的体验问题
- OPS 迭代回顾时识别出系统性问题
- 任何角色反思时偶尔产出（有就写，没有不强求）

**权限设计**：
- 所有角色：select + insert（任何角色都可以提交和查阅）
- PM：额外拥有 update 权限（修改 status、填写 resolution）

**生命周期**：
```
角色随时提交 (pending) → 用户与 PM 对话时查阅 → PM 处理：
  ├── accepted  → PM 据此创建任务/发消息/修改配置
  ├── rejected  → PM 填写拒绝理由
  └── archived  → 已处理完毕归档
```

#### 7.2 角色权限更新 (`src/db/permissions.ts`)

- [x] 所有角色新增 `proposals` 表的 `select` 和 `insert` 权限
- [x] PM 新增 `proposals` 表的 `update` 权限
- [x] PM 新增 `.win-agent/roles/` 目录的文件写权限（用于 onboarding）

#### 7.3 Onboarding 流程

**触发条件**：`project_config` 中无 `onboarding_completed` 键

**引擎侧** (`src/cli/start.ts`)：
- [x] Session 初始化后，检测 `onboarding_completed`
- [x] 未完成时，向 PM session 注入 onboarding 系统消息，告知 PM 进入 onboarding 模式
- [x] Onboarding 完成后，PM 写入 `project_config.onboarding_completed = true`
- [x] 引擎检测到 onboarding 完成 → 重新执行 `syncAgents()` 使更新后的角色 prompt 生效

**PM 侧** (`src/templates/roles/PM.md`)：
- [x] 新增「团队 Onboarding」工作流章节
- [x] PM 向用户介绍 5 个角色的定位和协作方式
- [x] 逐个角色与用户讨论期望：
  - SA：技术决策风格（保守/激进）、方案详细程度、任务拆分粒度
  - DEV：编码风格偏好、commit 规范、自测要求
  - QA：验收严格程度、是否关注标准外问题、回归测试范围
  - OPS：回顾频率、优化激进程度
  - PM 自身：汇报频率、沟通风格、决策自主度
- [x] PM 讨论工作流偏好（MVP 优先 vs 一步到位、迭代节奏等）
- [x] PM 综合所有输入，改写每个角色的 `.win-agent/roles/*.md`
- [x] PM 写入 `project_config.onboarding_completed = true`

**Agent 配置** (`src/workspace/sync-agents.ts`)：
- [x] PM 的 opencode agent 配置加入 `.win-agent/roles/` 目录的 write 权限

#### 7.4 角色自我反思

在每个角色的 prompt（`src/templates/roles/*.md`）中新增「自我反思」章节。

**触发时机**：
- 工作流结束时：引擎通过 `workflow-checker.ts` 向参与角色发送反思触发消息
- DEV 被 QA 打回时：DEV 立即反思本次问题的根因
- 迭代回顾时：OPS 汇总所有角色反思 + 指标数据

**反思产出**：
- **记忆**（写入 memory 表）：记住具体经验教训，供下次 session 回忆
- **Proposal**（可选，写入 proposals 表）：如果反思中发现了需要用户决策的系统性问题，才写入；没有则不写

**各角色反思重点**：
- PM：需求理解准确度、沟通效率、信息流转是否及时
- SA：方案可行性、任务拆分合理性、验收标准清晰度
- DEV：代码质量、自测充分性、被打回原因分析
- QA：验收标准适用性、缺陷描述质量、是否有遗漏
- OPS：上轮优化是否生效、指标变化趋势

**引擎侧改动**：
- [x] `workflow-checker.ts`：工作流完成时，向所有参与角色发反思触发消息
- [x] `src/templates/roles/*.md`：所有角色新增「自我反思」章节

#### 7.5 PM 的 Proposal 管理

PM prompt 中新增 Proposal 处理流程：
- [x] 用户对话时，PM 主动提及有未处理的 proposals（如有）
- [x] 用户可查询 proposals 列表、查看详情
- [x] PM 根据用户指令处理：accept → 转化为行动（创建任务/发消息/调整配置），reject → 填写理由，archive → 归档
- [x] PM 处理完毕后更新 proposal 状态和 resolution 字段

#### 7.6 角色 Prompt 更新汇总

所有角色 prompt 需新增的内容：
- [x] 所有角色：新增「Proposal 提交」说明——在工作中发现不紧急但用户应知道的事项时，写入 proposals 表
- [x] 所有角色：新增「自我反思」章节——描述反思时机、反思重点、产出格式
- [x] PM：新增「团队 Onboarding」工作流章节
- [x] PM：新增「Proposal 管理」工作流章节

---

### 阶段 8：迭代回顾 + OPS

**目标**：iteration-review 工作流跑通，OPS 能分析指标和执行优化。

参考：[workflows/iteration-review.json](../win-agent-design/workflows/iteration-review.json)、[roles/OPS.md](../win-agent-design/roles/OPS.md)

#### 8.1 迭代管理
- [x] 迭代自动创建：PM 审核通过任务时，无 active 迭代则自动创建
- [x] 迭代完成检测：关联任务全部 done → 标记 completed
- [x] 迭代回顾自动触发：completed → 创建 iteration-review workflow + 通知 OPS

#### 8.2 OPS 工作流
- [x] OPS 统计指标（打回率、阻塞率等）→ 发回顾报告给 PM
- [x] OPS 汇总各角色的自我反思和 proposals，综合分析
- [x] PM 审核优化方案 → 发消息给 OPS 批准/驳回
- [x] OPS 执行优化：修改 .win-agent/roles/*.md、维护 knowledge、调整 workflows
- [x] OPS 文件写操作前自动备份到 .win-agent/backups/

#### 8.3 打回率阈值触发
- [x] 实时检测打回率 > 30% → 自动触发 iteration-review
- [x] 防重复触发机制

---

### 阶段 9：任务灵活管理增强

**目标**：让系统更接近真实小团队，支持任务的取消、暂停、优先级调整、内容修改、用户实时干预。

#### 背景

真实小团队中，任务调整随时发生：紧急 bug 插队、需求变更导致任务暂停、阻塞等待外部依赖等。当前系统只能整体取消工作流，无法对单个任务做精细操作。

#### 9.1 扩展任务状态

新增 2 个正式状态：`paused`（用户主动暂停）和 `blocked`（依赖阻塞）。

**状态全景：**
```
                    paused ←──────┐ (用户主动)
                      ↓ (resume)  │
pending_dev → in_dev → pending_qa → in_qa → done
     ↑          ↑                    ↓
     │        rejected ←──────── in_qa
     │
   blocked → (依赖完成后自动恢复)
```

**转换规则：**
| 操作 | 来源状态 | 目标状态 | 触发者 |
|------|---------|---------|--------|
| pause | pending_dev, in_dev, pending_qa, in_qa, rejected | paused | user（CLI） |
| resume | paused | 暂停前状态（从 task_events 恢复） | user（CLI） |
| block | pending_dev, in_dev | blocked | system（依赖检查）或 DEV |
| unblock | blocked | 阻塞前状态 | system（依赖满足）|

**Schema**：无需改表结构，status 是 TEXT 类型。需要改动：
- [ ] `src/engine/scheduler.ts`：调度时跳过 paused/blocked 任务的消息
- [ ] `src/engine/dispatcher.ts`：dispatch 前检查关联任务状态
- [ ] `src/cli/status.ts`：展示新状态的中文标签
- [ ] 角色 prompt：说明 paused/blocked 状态的含义和行为

#### 9.2 CLI 任务管理命令

新增 `win-agent task` 子命令组：

```bash
win-agent task list                              # 列出活跃任务
win-agent task show <task_id>                    # 查看任务详情（含事件历史）
win-agent task pause <task_id>                   # 暂停任务
win-agent task resume <task_id>                  # 恢复暂停的任务
win-agent task cancel <task_id>                  # 取消单个任务
win-agent task reprioritize <task_id> <priority> # 调整优先级 (high/medium/low)
win-agent task edit <task_id>                    # 交互式修改描述/验收标准
```

**实现模式**（沿用 cancel.ts 的 CLI→DB 模式）：
1. 检查引擎运行状态（`checkEngineRunning()`）
2. 打开数据库连接
3. 验证任务存在且状态合法
4. 执行数据库更新
5. 插入 task_event 记录（changed_by: "user"）
6. 发送通知消息给相关角色（PM + assigned_to）

**文件变更：**
- [ ] 新建 `src/cli/task.ts` — 子命令组实现
- [ ] 修改 `src/index.ts` — 注册 task 子命令

#### 9.3 用户指令优先机制

**问题**：用户通过 `talk` 给 PM 发的消息和角色间消息同等优先级，可能被延迟。

**方案**：scheduler tick 开头优先检测用户消息：

```typescript
// scheduler.ts tick loop 开头
const userMessages = select("messages", { from_role: "user", status: "unread" });
if (userMessages.length > 0) {
  // 立即调度 PM，跳过 cooldown
  await dispatchToRole(client, sessionManager, "PM", userMessages, workspace);
  continue;
}
```

CLI task 命令产生的通知也标记为高优先级：
- `from_role: "user"` → PM 优先处理
- `type: "notification"` → 角色知晓即可，无需回复

**文件变更：**
- [ ] 修改 `src/engine/scheduler.ts` — 用户消息优先检测

#### 9.4 调度感知任务状态

scheduler/dispatcher 需要感知 paused/blocked 状态，避免无效调度：

**方案 A：dispatch 前检查（推荐）**
```typescript
// dispatcher.ts — dispatchToRole 开头
// 对 DEV/QA，检查关联任务状态
for (const msg of messages) {
  if (msg.related_task_id) {
    const task = select("tasks", { id: msg.related_task_id })[0];
    if (task && ["paused", "cancelled", "blocked"].includes(task.status)) {
      // 标记为 read，跳过
      update("messages", { id: msg.id }, { status: "read" });
    }
  }
}
// 过滤掉已标记 read 的消息
messages = messages.filter(m => m.status === "unread");
if (messages.length === 0) return;
```

**方案 B：task 操作时清理未读消息**
```typescript
// task.ts — pause/cancel 时
update("messages",
  { related_task_id: taskId, status: "unread" },
  { status: "read" }
);
```

两种方案互补使用：B 清理已有消息，A 防止新消息。

**文件变更：**
- [ ] 修改 `src/engine/dispatcher.ts` — dispatch 前检查任务状态
- [ ] 修改 `src/cli/task.ts` — 操作后清理未读消息

#### 9.5 依赖自动阻塞与解除

当前 `task_dependencies` 有记录但不强制执行。

**自动阻塞**（dispatch 时检查）：
```typescript
// dispatcher.ts — DEV dispatch 前
const unmetDeps = rawQuery(
  `SELECT t.id, t.title FROM task_dependencies td
   JOIN tasks t ON t.id = td.depends_on
   WHERE td.task_id = ? AND t.status != 'done'`,
  [taskId]
);
if (unmetDeps.length > 0) {
  update("tasks", { id: taskId }, { status: "blocked" });
  insert("task_events", {
    task_id: taskId, from_status: currentStatus, to_status: "blocked",
    changed_by: "system",
    reason: `依赖未完成: ${unmetDeps.map(d => `#${d.id}`).join(", ")}`
  });
  return; // 不 dispatch
}
```

**自动解除**（每 tick 检查）：
```typescript
// 新建 dependency-checker.ts
const blockedTasks = select("tasks", { status: "blocked" });
for (const task of blockedTasks) {
  const unmet = rawQuery(
    `SELECT 1 FROM task_dependencies td
     JOIN tasks t ON t.id = td.depends_on
     WHERE td.task_id = ? AND t.status != 'done' LIMIT 1`,
    [task.id]
  );
  if (unmet.length === 0) {
    // 恢复到阻塞前状态
    const lastEvent = rawQuery(
      `SELECT from_status FROM task_events
       WHERE task_id = ? AND to_status = 'blocked'
       ORDER BY created_at DESC LIMIT 1`,
      [task.id]
    );
    const restoreStatus = lastEvent[0]?.from_status || "pending_dev";
    update("tasks", { id: task.id }, { status: restoreStatus });
    insert("task_events", { ... });
    insert("messages", {
      from_role: "system", to_role: "PM", type: "notification",
      content: `任务 #${task.id} 依赖已满足，已自动解除阻塞`,
      related_task_id: task.id,
    });
  }
}
```

**文件变更：**
- [ ] 新建 `src/engine/dependency-checker.ts`
- [ ] 修改 `src/engine/scheduler.ts` — 每 tick 调用依赖检查
- [ ] 修改 `src/engine/dispatcher.ts` — DEV dispatch 前检查依赖

#### 9.6 实现优先级

| Phase | 内容 | 优先级 |
|-------|------|--------|
| Phase 1 | 9.1 + 9.2（状态扩展 + CLI 命令） | 最高 |
| Phase 2 | 9.3 + 9.4（用户优先 + 调度感知） | 高 |
| Phase 3 | 9.5（依赖自动管理） | 中 |
| Phase 4 | 9.2 的 `edit` 子命令 | 低 |

#### 文件变更汇总

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/cli/task.ts` | 新建 | 任务管理子命令组 |
| `src/index.ts` | 修改 | 注册 task 子命令 |
| `src/engine/scheduler.ts` | 修改 | 用户消息优先 + 跳过 paused/blocked + 依赖检查 |
| `src/engine/dispatcher.ts` | 修改 | dispatch 前检查任务状态和依赖 |
| `src/engine/dependency-checker.ts` | 新建 | 依赖自动检查与解除 |
| `src/cli/status.ts` | 修改 | 新增 paused/blocked 状态展示 |
| `.win-agent/roles/PM.md` | 修改 | 说明新状态和用户指令处理 |
| `.win-agent/roles/DEV.md` | 修改 | 说明 paused/blocked 行为 |
| `.win-agent/roles/QA.md` | 修改 | 说明 paused 行为 |

#### 注意事项

1. **向后兼容**：paused/blocked 是新增状态值，不改表结构，不影响已有任务
2. **CLI-Engine 通信**：沿用 cancel 命令模式，CLI 直接操作 DB + 插入消息通知引擎
3. **并发安全**：SQLite WAL 模式已启用，CLI 和 Engine 并发写入安全
4. **审计完整性**：所有状态变更记录 task_events，changed_by 区分 "user"/"system"/"角色名"

---

### 阶段 9：健壮性 + 边界处理

**目标**：处理各种异常情况，使系统可靠运行。

#### 9.1 错误处理
- [x] opencode server 连接失败重试
- [x] session.prompt() 超时处理
- [x] LLM 返回格式不符合预期的兜底
- [x] SQLite 并发写入保护（WAL 模式）

#### 9.2 PM 双通道冲突处理
- [x] 用户对话期间 PM busy → 角色消息排队
- [x] PM 空闲后优先处理用户消息，再处理角色消息
- [x] 参考 [architecture.md PM session 冲突处理](../win-agent-design/docs/architecture.md#2-调度器scheduler)

#### 9.3 记忆过期清理
- [x] 迭代回顾时清理 > 90 天的记忆
- [x] 30~90 天记忆仅高相似度召回

#### 9.4 日志记录
- [x] 所有角色操作写入 logs 表
- [x] 引擎关键事件日志（调度、触发、轮转、错误）
- [x] 终端输出格式化日志

---

### 阶段 10：数据可追溯性

**目标**：补全开发过程中的关键数据缺口，使角色决策可审计、任务历史可回溯。

#### 10.1 LLM 输出持久化 (`role_outputs` 表)

**问题**：`dispatchToRole()` 拿到 LLM 响应后只取了 token 数，角色的推理过程和完整输出没有存储。LLM 的动作（创建任务、发消息）已分散记录在 tasks/messages 表，但决策过程和推理上下文丢失。session 轮转后不可恢复。

**方案**：新建 `role_outputs` 表，在 dispatcher 和 session-manager 中自动记录。

```sql
CREATE TABLE IF NOT EXISTS role_outputs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  role                TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  input_summary       TEXT NOT NULL,       -- 注入 prompt 的摘要（前 500 字）
  output_text         TEXT NOT NULL,       -- LLM 完整文本输出
  input_tokens        INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  related_task_id     INTEGER REFERENCES tasks(id),
  related_workflow_id INTEGER REFERENCES workflow_instances(id),
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)
```

**写入点**：
- `dispatcher.ts`：`dispatchToRole()` 在收到 LLM 响应后写入
- `session-manager.ts`：`rotateSession()` 和 `writeAllMemories()` 中的记忆写入环节写入

**清理策略**：90 天后清理（与 messages 对齐），在 `cleanExpiredMemories()` 旁增加 `cleanExpiredOutputs()`

**权限**：所有角色 select，system 写入（引擎自动记录，角色无需感知）

实现清单：
- [x] `schema.ts`：新增 `role_outputs` 表 + 索引 `idx_role_outputs_role ON role_outputs(role, created_at)`
- [x] `dispatcher.ts`：`dispatchToRole()` 返回前提取 LLM 文本输出并写入 `role_outputs`
- [x] `session-manager.ts`：`rotateSession()` 和 `writeAllMemories()` 中写入记忆写入环节的输出
- [x] `permissions.ts`：所有角色对 `role_outputs` 表的 `select` 权限
- [x] `workflow-checker.ts`：迭代回顾完成时调用 `cleanExpiredOutputs()` 清理 90 天前记录
- [x] `sync-agents.ts`：database tool 的 TABLES 常量加入 `role_outputs`

#### 10.2 任务状态变更历史 (`task_events` 表)

**问题**：tasks 表只存最终态。任务被打回 2 次再通过，`rejection_reason` 被覆盖，只留最后一次。OPS 统计打回率时无法区分"当前被打回"和"曾经被打回过"。

**方案**：新建 `task_events` 事件表，由 database tool 的 update 函数自动拦截 tasks 表的 status 变更并记录。对角色 prompt 零侵入。

```sql
CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  from_status TEXT,              -- 旧状态（首次创建时为 NULL）
  to_status   TEXT NOT NULL,     -- 新状态
  changed_by  TEXT NOT NULL,     -- 触发变更的角色名
  reason      TEXT,              -- 变更原因（打回理由、阻塞原因等）
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)
```

**写入机制**：
- 修改 `sync-agents.ts` 中 database tool 模板的 `update` 函数
- 当 `table === 'tasks'` 且 `data` 中包含 `status` 字段时：
  1. 查询任务当前状态 `SELECT status FROM tasks WHERE id = ?`
  2. 写入 `task_events`：`{ task_id, from_status: 旧状态, to_status: 新状态, changed_by: ctx.agent, reason: data.rejection_reason || null }`
- 角色正常调用 `database_update({ table: "tasks", ... })` 即可，无需额外操作

**清理策略**：跟随所属 task 生命周期，不主动清理（事件量小，每个任务平均 3-5 条）

**权限**：所有角色 select（OPS 统计分析用），insert 由 database tool 内部自动写入（不需要角色显式权限）

**OPS 指标查询示例**：
```sql
-- 累计打回次数（比当前的 tasks.status='rejected' 计数更准确）
SELECT COUNT(*) FROM task_events WHERE to_status = 'rejected' AND task_id IN (SELECT id FROM tasks WHERE iteration = ?)
-- 单个任务的完整生命周期
SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at
```

实现清单：
- [x] `schema.ts`：新增 `task_events` 表 + 索引 `idx_task_events_task ON task_events(task_id, created_at)`
- [x] `sync-agents.ts`：database tool 的 `update` 函数增加 tasks status 变更拦截逻辑
- [x] `sync-agents.ts`：database tool 的 TABLES 常量加入 `task_events`
- [x] `permissions.ts`：所有角色对 `task_events` 表的 `select` 权限
- [x] `templates/roles/OPS.md`：在关注指标部分提示 OPS 可查询 `task_events` 获取更精确的打回统计

---

## 开发顺序总结

```
阶段 1  ━━━━━━━━━━━━━━━━━━━━━━  项目脚手架 + SQLite + 配置
    ↓
阶段 2  ━━━━━━━━━━━━━━━━━━━━━━  CLI 命令 (先 stub 引擎逻辑)
    ↓
阶段 3  ━━━━━━━━━━━━━━━━━━━━━━  opencode SDK 集成 + Session + 自定义工具
    ↓
阶段 4  ━━━━━━━━━━━━━━━━━━━━━━  Embedding + 向量检索
    ↓
阶段 5  ━━━━━━━━━━━━━━━━━━━━━━  调度器主循环 + 消息分发 (核心)
    ↓
阶段 6  ━━━━━━━━━━━━━━━━━━━━━━  端到端流程打通 (new-feature + bug-fix)
    ↓
阶段 7  ━━━━━━━━━━━━━━━━━━━━━━  Onboarding + 角色自我反思 + Proposal
    ↓
阶段 8  ━━━━━━━━━━━━━━━━━━━━━━  迭代回顾 + OPS 优化
    ↓
阶段 9  ━━━━━━━━━━━━━━━━━━━━━━  健壮性 + 边界处理
    ↓
阶段 10 ━━━━━━━━━━━━━━━━━━━━━━  数据可追溯性
```

---

## 关键设计决策备忘

1. **消息驱动而非状态机**：流程模板只提供上下文（当前阶段、角色职责），不控制执行顺序。角色间的实际协作通过 messages 表自由流动。
2. **双层权限**：opencode agent 配置控制工具可见性（静态），自定义工具内部 `checkPermission` 校验细粒度条件（动态）。
3. **Session 不持久化**：每次启动创建新 session，通过 memory 表回忆恢复上下文。
4. **DEV/QA 按任务创建 session**：不在启动时创建，被调度时按需创建。
5. **PM 是唯一面向用户的角色**：其他角色的消息通过 PM session 间接呈现给用户。
6. **.win-agent/roles/*.md 是 prompt 源文件**：引擎启动时加上 frontmatter 同步到 .opencode/agents/*.md。
7. **Onboarding 由 PM 直接写文件**：首次启动时 PM 拥有 `.win-agent/roles/` 写权限，直接改写角色 prompt。这是一次性的特殊流程，用户全程在对话中参与即等同于审批。
8. **Proposal 是角色到用户的异步提案通道**：区别于 messages（紧急阻塞），proposals 用于"不阻塞但用户应知道"的事项。角色在任何时候都可以提交，不需要特定触发时机。只在用户主动与 PM 交互时才处理。PM 是唯一可以变更 proposal 状态的角色。
9. **自我反思只在关键节点触发**：工作流结束和被打回时反思，session 轮转时只写记忆不做反思，避免噪音。
