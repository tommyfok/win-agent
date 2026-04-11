# win-agent 工作流程

## STEP 1: `init` 命令初始化目录

一次性项目初始化向导，在用户工作目录下创建 `.win-agent/` 工作空间并完成所有前置配置。

### Phase 1 — 环境检查

验证 Node.js、git 等基础工具可用，确认工作空间路径。

### Phase 2 — 工作空间初始化

创建 `.win-agent/` 目录结构：

```
.win-agent/
├── win-agent.db          # SQLite 数据库（含 12 张表）
├── roles/
│   ├── PM.md             # PM 角色指令（可编辑）
│   └── DEV.md            # DEV 角色指令（可编辑）
├── docs/                 # 项目文档
│   ├── overview.md       # 项目概览
│   ├── development.md    # 开发指南
│   ├── validation.md     # 验收规范
│   └── spec/             # Feature 规格文档
├── attachments/          # 用户上传的附件
├── backups/              # 数据库备份
└── engine.log            # 引擎日志
```

### Phase 3 — 幂等检查

如已初始化过，询问用户是否重新运行。

### Phase 4 — 项目信息收集

收集项目名称和描述，写入 `project_config` 表。

### Phase 4.5 — 项目模式检测（空目录时触发）

检测工作目录是否有代码。**空目录**时让用户选择：

| 选项 | 含义 | 后续行为 |
|------|------|----------|
| **从零开始（0-to-1）** | 用户要创建新项目 | 写入 `project_mode='greenfield'`，Phase 7 跳过 AI 分析，生成占位文档 |
| **已有代码** | 用户会把代码放进来 | Phase 7 跳过分析（等代码放入后 re-init） |

### Phase 5 — 项目上下文导入

可选步骤：
- **导入参考资料**：将 PRD、设计稿等文件导入知识库（`knowledge` 表，`category='reference'`）
- **声明技术约束**：目标部署环境、必须/禁止使用的技术、其他约束，写入 `project_config` 和知识库（`category='convention'`）

### Phase 6 — 同步角色配置 & MCP 服务

1. 将 PM.md / DEV.md 角色模板部署到 `.opencode/agents/`
2. 将数据库工具（database_query / database_insert / database_update / database_PM_insert）部署到 `.opencode/tools/`
3. 检查必要的 MCP 服务（如 Playwright MCP 等）是否就绪

### Phase 7 — 工作空间分析（AI 扫描项目结构）

根据项目模式走不同路径：

**Greenfield（0-to-1）模式：**
- 跳过 AI 分析
- 生成占位文档 `development.md` 和 `validation.md`（内容为"待脚手架任务完成后补充"）

**已有代码模式：**
- 启动 opencode 服务器，使用 PM Agent 扫描项目
- 自动生成三份文档：
  - `overview.md`：项目定位、技术栈、核心模块、架构要点
  - `development.md`：环境准备、开发命令、编码要求
  - `validation.md`：代码检查命令、E2E 验收方式
- 如 docs 已有实际内容（非骨架），询问用户是否覆盖

### Phase 8 — 注入项目上下文到角色文件

在 PM.md / DEV.md 中注入 `<!-- win-agent:project-context -->` 块，包含项目名称、描述和概览路径。

### Phase 9 — 确保 docs 文件存在 & 快照 mtime

- 如 docs 文件缺失，创建骨架模板
- 快照角色文件和 docs 文件的修改时间（用于首次 `start` 时检测用户是否已审阅）

---

## STEP 2: 用户审阅 & 编辑

init 完成后、start 之前，用户应审阅并根据项目实际情况修改以下文件：

| 文件 | 内容 | 审阅要点 |
|------|------|----------|
| `.win-agent/roles/PM.md` | PM 角色行为指令 | 确认需求处理流程、验收标准符合项目实际 |
| `.win-agent/roles/DEV.md` | DEV 角色行为指令 | 确认开发流程、归档规则符合项目实际 |
| `.win-agent/docs/overview.md` | 项目概览 | 确认项目定位、技术栈、模块划分描述准确 |
| `.win-agent/docs/development.md` | 开发指南 | 确认安装/构建/开发命令正确可执行，补充 TODO 标记处 |
| `.win-agent/docs/validation.md` | 验收规范 | 确认 lint/build/test 命令正确，E2E 验收方式合理，补充 TODO 标记处 |

---

## STEP 3: `start` 启动引擎

### 3.1 前置检查

1. **冲突检测**：检查是否已有引擎在运行（PID 锁文件）
2. **环境检查**：验证 Node.js、git 等
3. **工作空间初始化**：确保 `.win-agent/` 和数据库表完整
4. **Onboarding 检查**：未执行过 init 则拒绝启动
5. **文件审阅检查**（仅首次启动）：
   - 对比 mtime 快照，检测角色文件和 docs 文件是否被用户修改过
   - 检测 docs 文件是否仍有 TODO 标记
   - **未审阅 = 拒绝启动**，强制用户先完成审阅
6. **Skills 推荐检查**：根据项目技术栈推荐 opencode Skills

### 3.2 启动后台引擎

- Spawn 独立子进程运行 `_engine` 命令
- 输出重定向到 `.win-agent/engine.log`
- 写入 PID 锁文件

### 3.3 引擎初始化（daemon 进程内）

1. 初始化数据库连接
2. 同步 Agent 配置到 `.opencode/`
3. 启动 opencode 服务器
4. 为 PM 创建持久 session
5. 动态检测模型 context limit
6. 恢复中断状态（如有）
7. 启动调度器主循环

---

## STEP 4: 调度器主循环（Engine Loop）

引擎核心是一个 **1 秒轮询**的调度循环，V1 采用**串行策略**（每个 tick 最多调度一个角色）。

### 单次 Tick 执行流程

```
┌─ 0. 自动解除依赖满足的 blocked 任务
│
├─ 0.5 提升 deferred 消息为 unread（当 PM 空闲且无待处理消息时）
│
├─ 1. 优先调度：user→PM 的未读消息（跳过冷却期，最高优先级）
│
├─ 2. 常规调度：按角色顺序（PM 优先）找到第一个有未读消息的角色
│   ├─ PM 冷却期保护：PM 调度完成后 3 秒内不再调度 PM（给用户消息让路）
│   ├─ PM 饥饿保护：PM 连续调度 3 次后让位给 DEV
│   └─ DEV 按 task 分组调度（每个 task 在独立 session 中处理）
│
├─ 3. 调度完成后检查 session 轮转（memory rotation）
│
└─ 4. 检查自动触发条件 + 迭代完成检查
```

### 自动触发条件

| 触发条件 | 触发动作 | 触发次数 |
|----------|----------|----------|
| 脚手架 task 完成（greenfield 模式） | 通知 PM 生成 overview.md + 审阅 docs | 一次性 |
| 活跃迭代所有 task 完成 | 生成统计报告 → 通知 PM 复盘 | 每迭代一次 |
| 活跃迭代打回率 > 30% | 生成统计报告 → 通知 PM 提前介入 | 每迭代一次 |

### Memory Rotation（上下文轮转）

当角色的 session token 用量接近 context limit 的 80%（或输出 token 骤降超过 70%，即"焦虑检测"）时：

1. 让当前角色总结工作状态（写入 `memory` 表 + 向量存储）
2. 创建新 session
3. 新 session 启动时注入 recall prompt（从向量数据库语义检索近期记忆）

---

## STEP 5: PM 角色工作流程

PM 负责需求管理、任务派发和质量把关。**绝对红线：不写代码、不操作项目文件、不执行构建/测试命令。**

### 每次唤醒的流程

```
Phase 1 — 环境感知（必做）
├─ 阅读系统注入的上下文（触发消息、DEV 待处理队列）
├─ 查询 tasks 表了解全局状态
└─ 按需查询 messages 表补充历史上下文

Phase 2 — 消息分派（根据消息类型选择流程）
├─ 特殊判定：greenfield 模式 + 无已完成 task → 进入「项目启动流程」
└─ 常规分派（见下表）
```

| 来源 | 类型 | 场景 | 流程 |
|------|------|------|------|
| user | — | 新需求 | → 需求处理 |
| user | — | 取消任务 | → 取消任务 |
| user | — | 迭代相关 | → 迭代管理 |
| DEV | feedback | `feature#N 阻塞：` | → 阻塞处理 |
| DEV | feedback | `feature#N 验收报告：` | → 验收审核 |
| system | system | 脚手架完成/迭代统计/打回率告警 | → 对应处理 |
| system | reflection | 反思触发 | → 反思 |

### 项目启动流程（仅 0-to-1 首次触发）

**触发条件：** `project_mode='greenfield'` 且 tasks 表无 `status='done'` 的记录。

1. **需求探索** → 与用户讨论核心问题、MVP 边界、参考系统 → 写入知识库
2. **技术选型** → 提出 2-3 个方案及 trade-off → **等用户确认**
3. **架构规划** → 输出目录结构、模块划分、数据模型 → 写入 `spec/architecture.md` + 知识库
4. **脚手架派发** → 创建 `[scaffold]` task → 发 directive 给 DEV
5. 脚手架完成后 → 回到常规「需求处理」流程

### 需求处理流程（三步确认制）

**Step 1 — Specify**：将用户描述转化为结构化规格草稿（用户故事 + 功能点 + 边界条件），回显给用户

**Step 2 — Clarify**：识别模糊点向用户提问（每轮 ≥ 2 个问题），直到规格完整

**Step 3 — Confirm & Dispatch**：
1. 展示最终 Spec → **等用户明确确认**
2. 写入 `.win-agent/docs/spec/<feature-slug>.md`
3. 写入知识库
4. 拆分为 task → 写入 tasks 表 → 发 directive 给 DEV

### 验收审核（四项检查，全部满足才接受）

| # | 检查项 | 要求 |
|---|--------|------|
| 1 | 代码检查 | lint/build/test 的实际命令和输出 |
| 2 | E2E 验证 | 端到端执行记录（浏览器截图 / curl 输出等） |
| 3 | 验收标准覆盖 | 逐条对照 task 验收标准，每条有证据 |
| 4 | 经验归档 | 双写完成（DB + MD 文件） |

不满足 → 打回 DEV 并指出具体缺失项；全部满足 → 向用户汇报完成。

---

## STEP 6: DEV 角色工作流程

DEV 负责编码实现和独立验收。**文件操作权限受限**（禁止操作 `.win-agent/` 目录，仅允许写经验归档和特定任务中更新 docs）。

### 每次唤醒的流程

```
Phase 1 — 环境感知（必做）
├─ git log + git status 了解代码现状
├─ 检查近期工作回忆（memory 表 + messages 表）
└─ 阅读系统注入的上下文

Phase 2 — 消息分派
├─ directive → 新任务，更新 task 状态为 in_dev → Phase 3
├─ feedback → 按类型处理（证据不足/代码问题/归档不完整/阻塞回复）
├─ cancel_task → 回滚代码 + 更新状态为 cancelled
├─ system → 按指示行动
└─ reflection → 反思代码质量，写 memory + proposals

Phase 3 — 开发和自测（三种任务类型）
├─ [scaffold] 脚手架任务 → S1~S5 特殊流程
├─ [update-docs] 文档更新任务 → U1~U4 特殊流程
└─ 常规任务 → Step 1~5 标准流程

Phase 4 — 收尾
├─ git commit
├─ 更新 task 状态为 done
├─ 写交接记忆（memory 表）
├─ 经验归档（双写 DB + MD）
└─ 发验收报告给 PM
```

### 脚手架任务流程（`[scaffold]`）

| Step | 做什么 |
|------|--------|
| S1 | 根据 directive 中的技术选型，使用脚手架工具或手动搭建项目结构 |
| S2 | 配置 lint/format/test/tsconfig/.gitignore 等开发基础设施 |
| S3 | 安装依赖 → build 通过 → dev server 可启动 → lint 通过 |
| S4 | **必须**更新 `development.md` 和 `validation.md`（从占位模板填充为实际内容） |
| S5 | git init + commit → Phase 4 |

### 常规任务流程（5 步）

| Step | 做什么 | 依据文档 |
|------|--------|----------|
| Step 1 环境准备 | 执行安装/初始化命令 | `development.md`「环境准备」 |
| Step 2 基线验证 | 修改代码前先跑检查，记录已有失败 | `validation.md`「代码检查」 |
| Step 3 编码实现 | 按编码要求开发 | `development.md`「编码要求」+「开发命令」 |
| Step 4 代码检查 | lint/build/test 全部通过（已有失败可豁免） | `validation.md`「代码检查」 |
| Step 5 E2E 验收 | 端到端验证，记录命令输出/截图作为证据 | `validation.md`「E2E 验收」 |

### 报错处理机制

1. 向量查询 `knowledge` 表（`category='issue'`）→ 有匹配直接参考
2. 查 `.win-agent/docs/known-issues.md`
3. 自行排查，成功后**双写归档**（DB + MD）
4. 超过 30 分钟 → `git revert` 重来或发阻塞消息给 PM

---

## STEP 7: 知识与经验体系

### 知识库（knowledge 表 + 向量搜索）

| category | 来源 | 用途 |
|----------|------|------|
| `issue` | DEV 遇到的技术问题 | 后续 DEV 报错时语义检索参考 |
| `dev_note` | DEV 发现的项目开发细节 | 涉及对应子项目时参考 |
| `efficiency` | DEV 发现的效率瓶颈 | 优化开发流程 |
| `requirement` | PM 收集的需求信息 | 需求背景参考 |
| `convention` | 技术约束、架构决策 | 开发时遵循 |
| `reference` | 用户导入的参考资料 | PM/DEV 理解项目上下文 |

向量搜索基于本地 BGE-small-zh-v1.5 模型（512 维），也支持 OpenAI embeddings（1536 维）。

### 经验归档（双写规则）

DEV 在 Phase 4 收尾时执行，同时写入 DB 和 MD 文件：

| 场景 | DB 写入 | MD 追加 |
|------|---------|---------|
| 技术问题 | `knowledge`（`category='issue'`） | `.win-agent/docs/known-issues.md` |
| 开发经验 | `knowledge`（`category='dev_note'`） | `.win-agent/docs/dev-notes.md` |
| 效率优化 | `knowledge`（`category='efficiency'`） | `.win-agent/docs/efficiency-and-skills.md` |

---

## STEP 8: 迭代管理

### 创建迭代

PM 与用户讨论后创建，写入 `iterations` 表，后续 task 关联 `iteration_id`。

### 迭代生命周期

```
active → completed（所有 task 完成，引擎自动标记）→ reviewed（PM 审阅统计后标记）
```

### 统计报告（引擎自动生成，零 LLM 成本）

包含：任务概况（按状态统计）、质量指标（打回率、阻塞数）、Token 消耗（按角色统计）、打回次数最多的任务 Top 5。

---

## 其他 CLI 命令

| 命令 | 功能 |
|------|------|
| `win-agent stop` | 停止引擎（优雅中断当前调度 + 清理 PID 锁） |
| `win-agent restart` | 停止 + 重启 + 打开 PM 对话页面 |
| `win-agent talk` | 打开浏览器访问 PM 对话 Web UI |
| `win-agent status` | 显示引擎状态、迭代信息、任务统计、Token 消耗 |
| `win-agent log` | Tail 引擎日志 |
| `win-agent update` | 更新角色模板到最新包版本 |
| `win-agent clean` | 清除 `.win-agent` 和 `.opencode` 目录 |
| `win-agent task list` | 查看任务列表 |
| `win-agent task show <id>` | 查看任务详情 |
| `win-agent task pause/resume <id>` | 暂停/恢复任务 |

---

## 数据库表一览

| 表 | 用途 |
|----|------|
| `messages` | 角色间通信（directive/feedback/cancel_task/system/reflection） |
| `tasks` | Feature 任务定义与状态 |
| `task_dependencies` | 任务间依赖关系 |
| `task_events` | 任务状态变更历史 |
| `knowledge` | 共享知识库（含向量索引） |
| `memory` | 角色上下文记忆（session 轮转时保存） |
| `iterations` | 迭代定义与状态 |
| `project_config` | 项目配置（KV 存储） |
| `role_outputs` | 角色调度审计日志（tokens/输入/输出/时间戳） |
| `logs` | 系统操作日志 |
| `proposals` | 改进建议 |
| `role_permissions` | 角色访问控制 |
