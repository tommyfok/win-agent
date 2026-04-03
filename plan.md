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
- [ ] 定义统一接口 `generateEmbedding(text: string): Promise<number[]>`
- [ ] 实现 OpenAI embedding adapter（text-embedding-3-small）
- [ ] 从 config 读取 embedding provider 配置

#### 4.2 知识库向量检索
- [ ] 写入 knowledge 时自动生成 embedding
- [ ] `queryRelevantKnowledge(text, category?, limit?)`：category 精确过滤 + 向量排序
- [ ] 使用 sqlite-vec 的 `vec_distance_cosine()` 函数

#### 4.3 记忆向量检索
- [ ] 写入 memory 时基于 summary 生成 embedding
- [ ] `buildRecallPrompt(role, currentContext)`：7 天内记忆 + 向量相似度排序 + 摘要注入
- [ ] 7-30 天记忆仅高相似度时召回，30 天以上清理

---

### 阶段 5：引擎核心——调度器 + 消息分发

**目标**：主循环跑通，能轮询消息并触发角色工作。

参考：[implementation.md 引擎主循环](../win-agent-design/docs/implementation.md#4-引擎主循环)、[消息调度](../win-agent-design/docs/implementation.md#5-消息调度引擎如何触发角色)

#### 5.1 角色状态管理 (`src/engine/role-manager.ts`)
- [ ] `busyRoles: Set<string>`
- [ ] `isBusy(role)` / `setBusy(role, busy)`

#### 5.2 消息调度 (`src/engine/dispatcher.ts`)
- [ ] `dispatchToRole(client, sessionManager, role, messages)`：
  1. 获取或创建 session
  2. 查询相关知识库条目（向量检索）
  3. 查询当前工作流阶段信息
  4. 组装 prompt（`buildDispatchPrompt`）
  5. 调用 `session.prompt()`
  6. 标记消息为 read
  7. 检查上下文占用率，必要时轮转 session
- [ ] `buildDispatchPrompt(role, messages, knowledge, workflowContext)`：
  - 待处理消息区
  - 当前工作流上下文区（模板 + 阶段 + roles_guide）
  - 相关知识库区
  - 操作提示区

#### 5.3 自动触发检测 (`src/engine/auto-trigger.ts`)
- [ ] 检查迭代回顾触发条件：
  - 当前迭代所有任务 done → 触发 OPS
  - 打回率 > 30% → 触发 OPS
- [ ] 防止重复触发（记录已触发的 workflow_id + 条件）

#### 5.4 工作流完成检测 (`src/engine/workflow-checker.ts`)
- [ ] 遍历 active workflow_instances
- [ ] 加载对应流程模板的 completion.condition
- [ ] new-feature / bug-fix：关联任务全部 done → 推进到 done 阶段 + 通知 PM
- [ ] iteration-review：PM 完成归档 → 更新 workflow + iteration 状态

#### 5.5 调度器主循环 (`src/engine/scheduler.ts`)
- [ ] `mainLoop(client, sessionManager)`：
  1. 遍历 ALL_ROLES，检查未读消息
  2. 空闲角色有消息 → setBusy → dispatchToRole → setIdle
  3. checkAutoTriggers()
  4. checkWorkflowCompletion()
  5. sleep(1000) 避免空转
- [ ] PM 的特殊处理：当 PM busy 时，角色消息排队等待
- [ ] V1 串行：每轮只处理一个角色

#### 5.6 Session 轮转 (`src/engine/memory-rotator.ts`)
- [ ] 检测上下文占用率 > 60%
- [ ] 向当前 session 发送"写记忆"指令 → 角色总结当前工作
- [ ] 记忆写入 memory 表（含 embedding）
- [ ] 创建新 session → 注入身份 → 回忆相关记忆
- [ ] 更新 session 映射

---

### 阶段 6：端到端流程打通

**目标**：跑通一个完整的 new-feature 工作流。

#### 6.1 启动流程串联
- [ ] `win-engine start` 完整流程：环境检查 → 初始化 → opencode 启动 → agent 同步 → session 创建 → 主循环启动
- [ ] `win-engine talk` 打开浏览器 → 用户与 PM 对话

#### 6.2 new-feature 工作流验证
按 [README.md 核心工作流程](../win-agent-design/README.md#核心工作流程) 逐步验证：
- [ ] 用户与 PM 对话描述需求 → PM 写入 knowledge + 发消息给 SA
- [ ] 调度器检测到 SA 有消息 → 触发 SA session → SA 设计方案 + 拆分任务
- [ ] SA 发消息给 PM 审核 → PM 审核通过 → PM 发消息给 DEV
- [ ] DEV 领取任务 → 编码 → 自测 → 发消息给 QA
- [ ] QA 验收 → 通过/打回 → 消息流转
- [ ] 所有任务完成 → 引擎检测 → 通知 PM → PM 向用户汇报

#### 6.3 bug-fix 工作流验证
- [ ] 用户报告 Bug → PM 确认 → SA 分析 → DEV 修复 → QA 验证 → PM 反馈

#### 6.4 中断恢复验证
- [ ] `win-engine stop` 后重新 `start`，验证记忆回忆和工作流恢复
- [ ] 检查 active workflow 被正确恢复

---

### 阶段 7：迭代回顾 + OPS

**目标**：iteration-review 工作流跑通，OPS 能分析指标和执行优化。

参考：[workflows/iteration-review.json](../win-agent-design/workflows/iteration-review.json)、[roles/OPS.md](../win-agent-design/roles/OPS.md)

#### 7.1 迭代管理
- [ ] 迭代自动创建：PM 审核通过任务时，无 active 迭代则自动创建
- [ ] 迭代完成检测：关联任务全部 done → 标记 completed
- [ ] 迭代回顾自动触发：completed → 创建 iteration-review workflow + 通知 OPS

#### 7.2 OPS 工作流
- [ ] OPS 统计指标（打回率、阻塞率等）→ 发回顾报告给 PM
- [ ] PM 审核优化方案 → 发消息给 OPS 批准/驳回
- [ ] OPS 执行优化：修改 .win-agent/roles/*.md、维护 knowledge、调整 workflows
- [ ] OPS 文件写操作前自动备份到 .win-agent/backups/

#### 7.3 打回率阈值触发
- [ ] 实时检测打回率 > 30% → 自动触发 iteration-review
- [ ] 防重复触发机制

---

### 阶段 8：健壮性 + 边界处理

**目标**：处理各种异常情况，使系统可靠运行。

#### 8.1 错误处理
- [ ] opencode server 连接失败重试
- [ ] session.prompt() 超时处理
- [ ] LLM 返回格式不符合预期的兜底
- [ ] SQLite 并发写入保护（WAL 模式）

#### 8.2 PM 双通道冲突处理
- [ ] 用户对话期间 PM busy → 角色消息排队
- [ ] PM 空闲后优先处理用户消息，再处理角色消息
- [ ] 参考 [architecture.md PM session 冲突处理](../win-agent-design/docs/architecture.md#2-调度器scheduler)

#### 8.3 记忆过期清理
- [ ] 迭代回顾时清理 > 30 天的记忆
- [ ] 7-30 天记忆仅高相似度召回

#### 8.4 日志记录
- [ ] 所有角色操作写入 logs 表
- [ ] 引擎关键事件日志（调度、触发、轮转、错误）
- [ ] 终端输出格式化日志

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
阶段 7  ━━━━━━━━━━━━━━━━━━━━━━  迭代回顾 + OPS 优化
    ↓
阶段 8  ━━━━━━━━━━━━━━━━━━━━━━  健壮性 + 边界处理
```

---

## 关键设计决策备忘

1. **消息驱动而非状态机**：流程模板只提供上下文（当前阶段、角色职责），不控制执行顺序。角色间的实际协作通过 messages 表自由流动。
2. **双层权限**：opencode agent 配置控制工具可见性（静态），自定义工具内部 `checkPermission` 校验细粒度条件（动态）。
3. **Session 不持久化**：每次启动创建新 session，通过 memory 表回忆恢复上下文。
4. **DEV/QA 按任务创建 session**：不在启动时创建，被调度时按需创建。
5. **PM 是唯一面向用户的角色**：其他角色的消息通过 PM session 间接呈现给用户。
6. **.win-agent/roles/*.md 是 prompt 源文件**：引擎启动时加上 frontmatter 同步到 .opencode/agents/*.md。
