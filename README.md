# win-agent

> 多 Agent 协作的软件开发自动化引擎，由 PM（产品经理）和 DEV（开发者）两个 AI 角色驱动，完成从需求到代码的全流程自动化。

---

## 目录

- [项目概述](#项目概述)
- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [命令参考](#命令参考)
- [项目架构](#项目架构)
- [框架工作流程](#框架工作流程)
- [配置说明](#配置说明)
- [技术栈](#技术栈)

---

## 项目概述

win-agent 是一个基于 OpenCode SDK 的多 Agent 工作流引擎，通过协调 **PM 角色**（负责需求分析、任务拆解、验收评审）和 **DEV 角色**（负责代码实现）实现软件开发的自动化闭环。

引擎在后台以守护进程形式运行，持续调度两个角色完成迭代任务，支持：

- 自动检测项目类型（全新项目 / 待开发 / 既有项目）
- 基于向量检索的知识库管理
- 上下文窗口自动轮转与记忆压缩
- 任务依赖图管理与自动触发

---

## 核心特性

| 特性 | 说明 |
|------|------|
| **多 Agent 串行调度** | PM 和 DEV 角色串行执行，公平轮转，避免资源竞争 |
| **任务依赖管理** | 支持任务依赖图，自动阻塞/解锁下游任务 |
| **向量知识库** | 支持本地（HuggingFace）或 OpenAI 嵌入，相似度检索注入上下文 |
| **上下文自动轮转** | 检测 token 用量超过 80% 时自动压缩记忆并开启新会话 |
| **项目模式识别** | 自动判断 greenfield / pending / existing 并生成对应文档 |
| **自动触发器** | 脚手架完成、所有任务结束、拒绝率过高时自动触发下一阶段 |
| **Skill 集成** | 根据技术栈自动推荐并安装 OpenCode Skills |
| **持久化会话** | PM 维护长期对话，DEV 按任务创建独立会话 |

---

## 快速开始

### 安装

```bash
# 全局安装（推荐）
npm install -g win-agent

# 或通过 npx 直接使用
npx win-agent <command>
```

### 初始化项目

在你的项目根目录执行：

```bash
win-agent init
```

交互式向导将引导你完成：

1. **环境检查** — 验证 AI 提供商配置（API Key、模型选择）
2. **嵌入配置** — 选择本地嵌入或 OpenAI 嵌入
3. **项目扫描** — 分析项目结构与技术栈，识别子项目
4. **文档生成** — 自动生成 `overview.md`、`development.md`、`validation.md`
5. **知识库初始化** — 将文档注入向量数据库
6. **角色配置** — 部署 PM 和 DEV 的 Agent 配置文件
7. **Skill 推荐** — 根据技术栈推荐并安装适配的 Skills

初始化完成后，`.win-agent/` 目录将被创建：

```
.win-agent/
├── config.json          # 工作区配置
├── engine.log           # 引擎运行日志
├── engine.pid           # 守护进程 PID
├── roles/               # PM 和 DEV 的 Prompt 模板（可手动编辑）
│   ├── PM.md
│   └── DEV.md
└── db/
    └── win-agent.db     # SQLite 数据库
```

### 启动引擎

```bash
win-agent start
```

引擎以后台守护进程运行，PM 开始接收需求并向 DEV 分配任务。

### 与 PM 对话

```bash
win-agent talk
```

在浏览器中打开与 PM 的对话界面，输入需求或跟进任务进度。

---

## 命令参考

| 命令 | 说明 |
|------|------|
| `win-agent init` | 项目初始化（首次使用必须执行） |
| `win-agent start` | 启动后台引擎守护进程 |
| `win-agent stop` | 停止运行中的引擎 |
| `win-agent restart` | 重启引擎 |
| `win-agent status` | 查看引擎状态与当前迭代进度 |
| `win-agent talk` | 打开 PM 对话界面（浏览器） |
| `win-agent log` | 实时查看引擎日志 |
| `win-agent task` | 任务管理子命令（列表、状态筛选） |
| `win-agent cancel <id>` | 取消指定迭代 |
| `win-agent skills` | 根据技术栈推荐并安装 Skills |
| `win-agent update` | 更新角色模板到最新版本 |
| `win-agent clean` | 清理 `.win-agent/` 和 `.opencode/` 目录 |

---

## 项目架构

```
src/
├── index.ts              # CLI 入口，Commander.js 命令注册
├── cli/                  # 各命令的实现逻辑
│   ├── init.ts           # 初始化流程编排
│   ├── start.ts          # 启动守护进程
│   ├── engine.ts         # 守护进程内部入口（由 start 调用）
│   ├── check.ts          # 环境检查与提供商配置
│   ├── task.ts           # 任务管理命令
│   ├── status.ts         # 状态展示
│   ├── talk.ts           # 打开 PM 对话
│   ├── skills.ts         # 技术栈检测与 Skill 推荐
│   ├── stop.ts           # 停止引擎
│   ├── cancel.ts         # 取消迭代
│   ├── restart.ts        # 重启引擎
│   ├── log.ts            # 日志流式输出
│   ├── update.ts         # 更新文档模板
│   └── clean.ts          # 清理工作区
├── engine/               # 核心调度引擎
│   ├── scheduler.ts          # 主事件循环
│   ├── scheduler-dispatch.ts # dispatch 状态与子流程（用户优先 / 轮转）
│   ├── dispatcher.ts         # 消息路由主流程编排
│   ├── dispatch-filter.ts    # 消息过滤与依赖检查
│   ├── prompt-builder.ts     # Prompt 组装：知识注入 + 任务上下文
│   ├── event-bus.ts          # 内部事件总线（解耦调度器与各模块）
│   ├── session-manager.ts    # PM/DEV 会话生命周期管理
│   ├── session-store.ts      # sessions.json 持久化与恢复
│   ├── session-factory.ts    # 会话创建工厂
│   ├── memory-writer.ts      # 记忆写入（去重后的统一入口）
│   ├── memory-rotator.ts     # 上下文轮转与焦虑检测
│   ├── role-manager.ts       # 角色忙闲状态管理
│   ├── auto-trigger.ts       # 里程碑自动触发器
│   ├── iteration-stats.ts    # 迭代统计计算
│   ├── dependency-checker.ts # 任务依赖图检查（支持传递依赖）
│   ├── iteration-checker.ts  # 迭代完成检测
│   ├── opencode-server.ts    # OpenCode 服务器管理与健康检查
│   ├── opencode-config.ts    # OpenCode 配置构建
│   ├── output-cleaner.ts     # 输出清洗
│   └── retry.ts              # 指数退避重试
├── db/                   # 数据库层
│   ├── connection.ts     # SQLite 连接（WAL 模式 + sqlite-vec）
│   ├── schema.ts         # 表结构与向量虚拟表定义
│   ├── repository.ts     # 通用查询抽象（含 withTransaction）
│   ├── state-machine.ts  # 任务状态机（合法转换校验）
│   ├── types.ts          # TaskStatus / MessageStatus 枚举
│   └── permissions.ts    # RBAC 权限种子数据
├── embedding/            # 向量嵌入与语义检索
│   ├── index.ts          # 嵌入提供商工厂（含 LRU 缓存）
│   ├── knowledge.ts      # 知识库写入与相似度检索
│   ├── memory.ts         # 记忆写入、召回与上下文构建
│   ├── local.ts          # 本地嵌入（HuggingFace bge-small-zh-v1.5）
│   └── openai.ts         # OpenAI 嵌入（text-embedding-3-small）
├── workspace/            # 工作区管理
│   ├── init.ts           # 创建 .win-agent/ 结构，生成初始文档
│   └── sync-agents.ts    # 同步 Agent 配置到 .opencode/agents/
├── config/               # 配置管理
│   └── index.ts          # 全局预设、工作区配置、PID 文件管理
├── templates/            # 角色 Prompt 模板（Markdown）
│   ├── PM.md             # PM 角色系统提示词
│   ├── PM-reference.md
│   ├── PM-task-handling.md
│   ├── DEV.md            # DEV 角色系统提示词
│   ├── DEV-reference.md
│   ├── DEV-scaffold.md
│   └── DEV-update-docs.md
└── utils/
    ├── format.ts         # Token 格式化工具
    └── logger.ts         # 结构化日志（pino）
```

### 数据库结构

| 表名 | 说明 |
|------|------|
| `messages` | 角色间通信消息，含状态追踪 |
| `tasks` | 开发任务，含依赖关系与状态 |
| `task_dependencies` | 任务依赖图 |
| `knowledge` | 项目知识文档（含向量） |
| `memory` | 上下文摘要（含向量），用于记忆召回 |
| `iterations` | 工作迭代记录 |
| `proposals` | 建议与提案 |
| `logs` | 角色操作审计日志 |
| `role_permissions` | 角色访问控制配置 |
| `role_outputs` | Token 用量与输出历史 |
| `task_events` | 任务状态变更历史 |
| `project_config` | 工作区键值配置 |

---

## 框架工作流程

### 整体生命周期

```
init  →  start  →  [后台引擎循环]  →  stop
          |                |
        talk            scheduler
       (PM对话)          主循环
```

### 调度主循环（Scheduler）

```
每次循环 (~500ms):
  1. 检查自动触发器
     ├── 脚手架完成？→ 通知 PM 开始任务分配
     ├── 所有任务完成？→ 触发迭代评审
     └── 拒绝率过高？→ PM 介入调整

  2. 轮询各角色未读消息
     └── 按任务上下文分组消息

  3. 消息分发（Dispatcher）
     ├── 查询相关知识（向量检索）
     ├── 注入知识上下文
     └── 发送给对应角色处理

  4. 检查上下文轮转阈值
     ├── input tokens > 80% max？
     ├── 输出方差 > 30%（焦虑检测）？
     └── 触发记忆压缩 → 创建新会话

  5. 更新任务状态与依赖关系

  6. Sleep → 下一轮
```

### 角色协作模式

```
用户
 │
 │  (浏览器对话)
 ▼
PM 角色
 ├── 分析需求
 ├── 拆解任务（含验收标准）
 ├── 分配给 DEV
 └── 评审 DEV 输出（通过/拒绝）
      │
      ▼
    DEV 角色（每个任务独立会话）
     ├── 读取任务上下文
     ├── 实现代码
     ├── 自测验证
     └── 返回结果给 PM
```

### 上下文轮转（Memory Rotation）

```
检测触发条件
    │
    ├── tokens 超阈值 (>80%)
    └── 输出波动过大 (anxiety)
              │
              ▼
        角色生成记忆摘要
              │
              ▼
        摘要存入 memory 表（含向量）
              │
              ▼
        创建新会话（清空上下文）
              │
              ▼
        下次 dispatch 时召回相关记忆
```

---

## 配置说明

### 全局配置（`~/.win-agent/providers.json`）

存储命名的提供商预设，可在多个工作区复用：

```json
{
  "my-preset": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "embedding": {
      "type": "openai",
      "model": "text-embedding-3-small"
    }
  }
}
```

### 工作区配置（`.win-agent/config.json`）

```json
{
  "workspaceId": "a1b2c3d4",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "embedding": {
    "type": "local"
  },
  "contextRotation": {
    "threshold": 0.8,
    "anxietyThreshold": 0.3
  },
  "engine": {
    "tickIntervalMs": 1000,
    "pmCooldownMs": 3000,
    "dispatchTimeoutMs": 3600000,
    "sessionInitTimeoutMs": 60000,
    "minTasksForRejectionStats": 3,
    "rejectionRateThreshold": 0.3
  }
}
```

`engine` 字段所有项均有默认值，缺省时行为不变。各项说明：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `tickIntervalMs` | 1000 | 调度循环间隔（ms） |
| `pmCooldownMs` | 3000 | PM dispatch 后的冷却时间（ms） |
| `dispatchTimeoutMs` | 3600000 | 单次 dispatch 超时时间（ms） |
| `sessionInitTimeoutMs` | 60000 | 会话初始化等待超时（ms） |
| `minTasksForRejectionStats` | 3 | 触发打回率告警的最少任务数 |
| `rejectionRateThreshold` | 0.3 | 打回率告警阈值（30%） |

### 角色 Prompt 定制

初始化后，`roles/PM.md` 和 `roles/DEV.md` 会被复制到 `.win-agent/roles/`，你可以直接编辑这些文件来定制角色行为，无需修改源码。

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js (ESM) |
| 语言 | TypeScript 5.8 |
| Agent 框架 | @opencode-ai/sdk |
| 数据库 | SQLite (better-sqlite3) + sqlite-vec |
| 向量嵌入 | HuggingFace Transformers / OpenAI Embeddings API |
| CLI 框架 | Commander.js + @inquirer/prompts |
| 构建工具 | tsup |

---

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式（监听文件变化）
pnpm dev

# 构建
pnpm build

# 运行单元测试
pnpm test

# 本地链接（用于测试 CLI）
pnpm link --global
```

构建产物为 `dist/index.js`，包含 shebang，可直接作为 CLI 执行。
