# win-agent model 命令 & OpenCode Zen/Go Provider 支持

## 背景

win-agent 在 `init` 完成后，无法切换工作空间使用的 LLM 模型。用户若想更换模型，只能 `clean` 后重新 `init`，代价过高。

同时，OpenCode 平台提供了两种模型订阅方案——**Zen**（按量付费，精选模型）和 **Go**（$10/月订阅，低成本模型），但 win-agent 的 provider 选择中未包含这两种类型，用户无法直接使用。

本次改动解决以上两个问题。

## 改动概要

### 1. 新增 `win-agent model` 命令

允许用户在 init 完成后随时切换工作空间的 LLM Provider / Embedding 配置，无需重新 init。

### 2. 新增 OpenCode Zen / Go Provider 类型

在 provider 选择流程中新增两个选项，使用户可直接配置 OpenCode 平台的模型。

## 设计细节

### `win-agent model` 命令

**文件**: `src/cli/model.ts` (新增)

交互流程：

1. 显示当前 Provider 和 Embedding 配置
2. 若引擎正在运行（检测 PID），提示用户切换后需 `restart` 才能生效，要求确认
3. 用户选择操作类型：
   - 仅切换 LLM Provider / 模型
   - 仅切换 Embedding 模型
   - 同时切换两者
4. 复用已有的全局预设（`~/.win-agent/providers.json`）或新建配置
5. 写入 `.win-agent/config.json`

使用方式：

```bash
npx win-agent model      # 交互式切换
npx win-agent restart    # 重启引擎使配置生效
```

**关键决策**：配置写入即生效（写文件），但运行中的引擎不会热更新——需要用户手动 `restart`。这比自动重启更安全，避免中断正在执行的任务。

### OpenCode Zen / Go Provider

**涉及文件**:

- `src/cli/check.ts` — provider 选择流程
- `src/engine/opencode-config.ts` — opencode 服务端配置生成

#### Provider 类型映射

| win-agent type | opencode model 格式      | API Key 环境变量   | 说明                   |
| -------------- | ------------------------ | ------------------ | ---------------------- |
| `opencode-zen` | `opencode/<model-id>`    | `OPENCODE_API_KEY` | 按量付费，精选模型     |
| `opencode-go`  | `opencode-go/<model-id>` | `OPENCODE_API_KEY` | $10/月订阅，低成本模型 |

#### Zen 模型选择

通过 `https://opencode.ai/zen/v1/models` API 动态拉取可用模型列表，用户从列表中选择。失败时允许手动输入。

可用模型包括（不限于）：

- Claude 系列: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 等
- GPT 系列: gpt-5.4, gpt-5.3-codex, gpt-5.1 等
- Gemini 系列: gemini-3.1-pro, gemini-3-flash
- 其他: glm-5.1, kimi-k2.5, qwen3.6-plus 等

#### Go 模型选择

Go 无公开 /models endpoint，使用内置硬编码列表：

```
glm-5.1, glm-5, kimi-k2.5, mimo-v2-pro, mimo-v2-omni,
minimax-m2.7, minimax-m2.5, qwen3.6-plus, qwen3.5-plus
```

#### `buildOpencodeConfig` 配置生成

Zen 和 Go 作为 opencode 的内置 provider 处理（非 custom），生成格式：

```json
{
  "model": "opencode/claude-sonnet-4-6",
  "provider": {
    "opencode": {
      "env": ["OPENCODE_API_KEY=<key>"]
    }
  },
  "permission": { "edit": "allow", "bash": "allow" }
}
```

Go 类似，`model` 前缀为 `opencode-go/`，provider key 为 `opencode-go`。

不需要额外安装 npm 包（`ensureOpencodePackages` 中 `isCustom = false`，跳过 SDK 安装）。

## 文件变更清单

| 文件                                           | 变更类型 | 说明                                                                                             |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `src/cli/model.ts`                             | 新增     | `win-agent model` 命令实现                                                                       |
| `src/cli/check.ts`                             | 修改     | 导出 `promptNewProvider`；新增 Zen/Go 选项；新增 `fetchZenModels()` 和 `OPENCODE_GO_MODELS` 常量 |
| `src/engine/opencode-config.ts`                | 修改     | `buildOpencodeConfig` 新增 `opencode-zen` / `opencode-go` 分支                                   |
| `src/index.ts`                                 | 修改     | 注册 `model` 命令                                                                                |
| `src/engine/__tests__/opencode-config.test.ts` | 新增     | 18 个测试用例，覆盖所有 provider 类型的配置生成                                                  |

## 测试覆盖

新增 `src/engine/__tests__/opencode-config.test.ts`，18 个用例：

| 分组                  | 用例数 | 覆盖内容                                                               |
| --------------------- | ------ | ---------------------------------------------------------------------- |
| built-in providers    | 3      | anthropic / openai / apiKey 为空                                       |
| custom providers      | 4      | custom-openai / custom-anthropic / reasoning 标记 / 无 baseURL         |
| OpenCode Zen          | 4      | Claude / GPT / Gemini 模型 / apiKey 为空                               |
| OpenCode Go           | 4      | GLM / Kimi / Qwen 模型 / apiKey 为空                                   |
| provider type routing | 3      | Zen/Go 不走 custom 分支、不走 built-in 分支、正确使用 OPENCODE_API_KEY |

构建与测试结果：`tsc --noEmit` 通过，`vitest run` 107 个用例全部通过。
