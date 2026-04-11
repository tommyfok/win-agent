# 优化计划

基于对现有架构的分析，整理以下优化方向，按优先级排序。

---

## P0 — DEV 冷启动上下文（根目录 AGENT.md）

**问题**：DEV 每次冷启动只能依靠 `git log`、注入的 memory 和 vector 搜索知识拼凑项目概貌，命中质量不稳定，导致 DEV 需要额外探索才能建立全局认知。

**方案**：
1. `init` 阶段在项目根目录生成 `AGENT.md`，内容包括：项目简介、技术栈、关键目录说明、常用命令（开发/测试/构建）、开发约定
2. `update` 命令支持重新生成/更新 `AGENT.md`（类似现有 overview.md 的更新逻辑）
3. 在 DEV 的 Phase 1 提示词中加一行：「若根目录存在 `AGENT.md`，优先阅读以建立项目全局认知」

**前提验证**：确认 opencode 是否会自动读取根目录 `AGENT.md`（类似 Claude Code 读 `CLAUDE.md` 的机制）。若自动读取，则步骤 3 可省略；若不自动读取，步骤 3 中显式引导即可。

**预期收益**：DEV Phase 1 时间缩短，减少因项目结构不熟悉导致的探索失误。

---

## P1 — docs/ 与 knowledge DB 双写一致性检查

**问题**：`DEV-reference.md` 要求 DEV 在归档经验时「双写」（同时写 knowledge 表和对应 MD 文件），但依赖 AI 角色自觉执行，没有机器验证。当只写了一侧时，PM 的验收也不一定每次都能发现。

**方案**：
在 `check` 命令中增加一项 lint：
- 对比 `knowledge` 表中 `category='issue'` 的条目与 `docs/known-issues.md` 的内容
- 输出「仅在 DB」或「仅在文件」的条目列表，供用户人工确认
- 不强制报错，仅作提示（避免误判格式差异）

**可选扩展**：对 `dev-notes.md` 和 `efficiency-and-skills.md` 做类似检查。

---

## P2 — PM「已排队消息」注入范围收窄

**问题**：`dispatcher.ts:371` 每次唤醒 PM 时，把所有未读 DEV 消息全量注入 prompt（防止 PM 重复派发）。当 DEV 积压消息较多时，这部分噪音会稀释 PM 的注意力。

**现状代码位置**：`src/engine/dispatcher.ts` `buildDispatchPrompt()` → 「DEV pending queue」section

**方案**：将注入范围从「全部未读 DEV 消息」收窄为「与当前触发消息同 task 相关的」未读消息，其余只显示计数摘要：

```
DEV 待处理队列（共 8 条未读）：
  - 当前 task#3 相关（2 条）：[msg#12] ... [msg#13] ...
  - 其他 task 共 6 条，无需关注
```

---

## P3 — 调度器公平性：PM/DEV 轮询

**问题**：scheduler 固定顺序「先检查 PM，再检查 DEV」，PM 优先级始终高于 DEV。用户频繁发消息时，DEV 的任务执行可能被连续推迟。

**方案**：调整调度逻辑：
1. 用户消息（`from_role='user'`）始终最高优先级，触发 PM
2. 其余情况采用 round-robin：记录上次执行的 role，下次优先调度另一个 role
3. 连续 N 个 tick 内某 role 无消息，则跳过直到有消息为止

**影响范围**：`src/engine/scheduler.ts`

---

## P4 — 上下文轮换阈值可配置化

**问题**：memory-rotator 中的 token 阈值若为硬编码常数，在切换 provider/model 时需要改代码（不同模型的上下文窗口差异很大，如 Haiku vs Opus）。

**方案**：
- 在 `config.json` 中增加可选字段 `contextRotation.inputThreshold` 和 `contextRotation.outputThreshold`
- memory-rotator 优先读取配置值，未配置时使用默认值
- `check` 命令输出当前生效的阈值，便于用户确认

**影响范围**：`src/engine/memory-rotator.ts`、`src/config/index.ts`
