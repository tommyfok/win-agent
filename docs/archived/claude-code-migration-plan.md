# win-agent 迁移计划：解耦 opencode，支持 Claude Code

## 一、现状分析

win-agent 当前强绑定 opencode 的 6 个核心能力：

| 能力 | opencode 实现方式 | 涉及文件 |
|------|-------------------|----------|
| LLM 交互 | `client.session.prompt()` / `promptAsync()` | `dispatcher.ts`, `session-manager.ts` |
| Session 管理 | `client.session.create/get/list/delete/messages` | `session-manager.ts` |
| Server 进程 | `opencode serve` 子进程 + HTTP API | `opencode-server.ts` |
| Agent 定义 | `.opencode/agents/*.md` YAML frontmatter | `sync-agents.ts` |
| 自定义 Tool | `.opencode/tools/*.ts` + `@opencode-ai/plugin` | `sync-agents.ts` |
| MCP 配置 | `~/.config/opencode/opencode.json` | `sync-agents.ts` |
| Web UI | `serverUrl/{workspace}/session/{id}` | `talk.ts` |

## 二、目标架构

```
                  ┌─────────────────────┐
                  │    win-agent 引擎     │
                  │  scheduler/dispatcher │
                  └──────────┬──────────┘
                             │
                    ┌────────┴────────┐
                    │  LLMRuntime 接口  │  ← 新增抽象层
                    └────────┬────────┘
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────┴───┐  ┌──────┴──────┐  ┌───┴────────┐
     │  Opencode   │  │ Claude Code │  │  其他未来   │
     │  Runtime    │  │  Runtime    │  │  Runtime   │
     └────────────┘  └─────────────┘  └────────────┘
```

## 三、LLMRuntime 接口定义

```typescript
// src/engine/runtime/types.ts

export interface PromptResult {
  text: string;                    // 合并后的文本输出
  parts: Array<{type: 'text'; text: string}>;
  tokens: { input: number; output: number };
}

export interface SessionInfo {
  id: string;
  title: string;
}

export interface AgentDeployConfig {
  role: string;
  description: string;
  mode: string;
  tools: Record<string, boolean>;
  permission: Record<string, string | Record<string, string>>;
  promptContent: string;           // 角色 prompt markdown
}

export interface LLMRuntime {
  // ── 生命周期 ──
  start(workspace: string): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;

  // ── Session 管理 ──
  createSession(title: string): Promise<string>;
  deleteSession(id: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  getSession(id: string): Promise<SessionInfo>;
  getSessionMessages(id: string): Promise<Array<{role: string; content: string}>>;

  // ── 核心交互 ──
  prompt(sessionId: string, agent: string, text: string): Promise<PromptResult>;
  promptAsync(sessionId: string, agent: string, text: string): Promise<void>;

  // ── 部署 ──
  deployAgent(config: AgentDeployConfig): void;
  deployTools(workspace: string): void;
  configureMcp(workspace: string): void;

  // ── UI（可选）──
  getConversationUrl?(sessionId: string): string | null;

  // ── 进程信息（用于 stop/status）──
  getPid(): number | null;
}
```

## 四、实施步骤

### Step 1: 提取 LLMRuntime 接口

**新建文件：**
- `src/engine/runtime/types.ts` — 接口定义
- `src/engine/runtime/index.ts` — 导出 + factory

**目标：** 定义清晰的接口契约，所有 runtime 实现都遵循此接口。

### Step 2: 实现 OpencodeRuntime

**新建文件：**
- `src/engine/runtime/opencode.ts`

**改造方式：**
1. 将 `opencode-server.ts` 的逻辑迁移到 `OpencodeRuntime.start()` / `stop()`
2. 将 `session-manager.ts` 中所有 `this.client.session.*` 调用改为通过 runtime 接口
3. 将 `sync-agents.ts` 的 agent/tool 部署逻辑迁移到 `OpencodeRuntime.deployAgent()` / `deployTools()`

**保持行为完全不变**，纯重构。

### Step 3: 改造消费端（dispatcher, session-manager, scheduler）

**改造文件：**
- `src/engine/session-manager.ts` — 构造函数接收 `LLMRuntime` 而非 `OpencodeClient`
- `src/engine/dispatcher.ts` — 函数签名改为接收 `LLMRuntime`
- `src/engine/scheduler.ts` — 创建 runtime 实例并注入
- `src/engine/memory-rotator.ts` — 通过 session-manager 间接使用，无需改动
- `src/cli/start.ts` — 根据配置选择 runtime
- `src/cli/talk.ts` — 通过 runtime 获取 conversation URL
- `src/cli/stop.ts` — 通过 runtime 获取 PID

### Step 4: 将 database tools 抽取为独立 MCP Server

**新建文件：**
- `src/mcp/database-server.ts` — 标准 MCP Server，暴露 query/insert/update 三个 tool

**原因：**
- opencode 用 `.opencode/tools/*.ts` + `@opencode-ai/plugin` 定义 tool
- Claude Code 用 MCP Server 定义 tool
- MCP 是两者的公共协议，抽成 MCP Server 后两边都能用

**实现要点：**
- 复用现有 `getDatabaseToolContent()` 中的核心逻辑（权限检查、SQL 构建等）
- 每个 role 启动独立 MCP Server 进程（不同 role 有不同权限）
- OpencodeRuntime 可以选择继续用 `.opencode/tools/` 或也切换到 MCP

### Step 5: 实现 ClaudeCodeRuntime

**新建文件：**
- `src/engine/runtime/claude-code.ts`

**实现方案：使用 Claude Code Agent SDK (`@anthropic-ai/claude-code`)**

```typescript
import { query } from '@anthropic-ai/claude-code';

class ClaudeCodeRuntime implements LLMRuntime {
  // Session 管理：自行维护 Map<sessionId, ConversationHistory>
  // 持久化到 .win-agent/sessions/ 目录
  private sessions: Map<string, ConversationTurn[]>;

  async prompt(sessionId, agent, text) {
    const session = this.sessions.get(sessionId);
    const result = await query({
      prompt: text,
      systemPrompt: session.rolePrompt,
      options: {
        maxTurns: 50,           // 允许多轮 tool use
        allowedTools: [...],     // 根据 agent config 控制
        mcpServers: {            // 注入 database MCP
          [`database_${agent}`]: {
            command: 'node',
            args: ['src/mcp/database-server.js', '--role', agent],
          }
        },
      },
      messages: session.history, // 传入历史实现"session"
    });
    // 更新历史
    session.history.push(...result.messages);
    return parseResult(result);
  }
}
```

**关键适配点：**

| opencode 概念 | Claude Code 对应 |
|---------------|-----------------|
| `session.create` | 创建内存中的 conversation history |
| `session.prompt` | `query()` 传入 history + systemPrompt |
| `session.promptAsync` | `query()` 后台执行（spawn worker） |
| `session.messages` | 读取内存中的 history |
| `session.delete` | 清除 history |
| agent frontmatter (tools) | `allowedTools` 参数 |
| agent frontmatter (permission) | `permissions` 参数 |
| `.opencode/tools/` | MCP Server（Step 4） |
| Web UI | 无直接等价，talk 命令改为终端交互或提示使用 IDE |

### Step 6: 配置与切换

**改造文件：**
- `src/config/index.ts` — 增加 `runtime` 字段
- `src/cli/onboarding.ts` — onboard 时选择 runtime

**config.json 新增：**
```json
{
  "runtime": "opencode" | "claude-code",
  "provider": { ... }
}
```

**factory：**
```typescript
// src/engine/runtime/index.ts
export function createRuntime(config: WinAgentConfig): LLMRuntime {
  switch (config.runtime) {
    case 'claude-code':
      return new ClaudeCodeRuntime(config);
    case 'opencode':
    default:
      return new OpencodeRuntime(config);
  }
}
```

### Step 7: Talk 命令适配

**改造文件：**
- `src/cli/talk.ts`

**Claude Code runtime 下的 talk 行为：**
- 无 Web UI 可打开
- 方案 A: 启动 `claude --resume <session-id>` 交互式终端
- 方案 B: 提示用户在 VS Code 中使用 Claude Code 插件连接
- 由 runtime 的 `getConversationUrl()` 返回 `null` 时触发降级逻辑

## 五、文件变更总览

```
新增：
  src/engine/runtime/types.ts          — LLMRuntime 接口定义
  src/engine/runtime/index.ts          — factory + 导出
  src/engine/runtime/opencode.ts       — OpencodeRuntime 实现
  src/engine/runtime/claude-code.ts    — ClaudeCodeRuntime 实现
  src/mcp/database-server.ts           — 数据库 MCP Server

改造：
  src/engine/session-manager.ts        — client → runtime
  src/engine/dispatcher.ts             — client → runtime
  src/engine/scheduler.ts              — 创建 runtime 实例
  src/engine/opencode-server.ts        — 逻辑迁移到 opencode.ts，可删除或保留为 re-export
  src/workspace/sync-agents.ts         — agent/tool 部署逻辑迁入各 runtime
  src/cli/start.ts                     — 根据 config.runtime 选择 runtime
  src/cli/stop.ts                      — 通过 runtime 获取 PID
  src/cli/talk.ts                      — 支持无 Web UI 降级
  src/cli/onboarding.ts                — 增加 runtime 选择
  src/config/index.ts                  — 增加 runtime 配置字段
```

## 六、实施顺序与依赖关系

```
Step 1 (接口定义)
  ↓
Step 2 (OpencodeRuntime) ←→ Step 4 (MCP Server)  可并行
  ↓
Step 3 (改造消费端)
  ↓
Step 5 (ClaudeCodeRuntime)
  ↓
Step 6 (配置切换)
  ↓
Step 7 (Talk 适配)
```

Step 1-3 完成后，现有功能不受影响（纯重构）。
Step 4-7 是增量功能，可逐步推进。

## 七、Claude Code Runtime 的限制与 trade-off

| 维度 | opencode | Claude Code |
|------|----------|-------------|
| Session 持久化 | 服务端管理 | 需自行维护 conversation history |
| Web UI | 自带 | 无，需降级到终端或 IDE |
| Agent 隔离 | frontmatter 精确控制 | allowedTools + MCP 组合控制 |
| 多 Agent 并发 | 单进程多 session | 每个 prompt 是独立 subprocess |
| Token 统计 | API 直接返回 | Agent SDK result 中包含 |
| Context rotation | 依赖 session token info | 需自行计算 history token 数 |

**最大差异：Session 模型。** opencode 有服务端 session，Claude Code 没有。ClaudeCodeRuntime 需要自行序列化 conversation history 到磁盘，并在每次 prompt 时回传。这意味着：
- 需要做 history 压缩/截断策略（避免超出 context window）
- 现有的 rotation 逻辑需要适配为"截断 history + 写 memory"而非"新建 session"
