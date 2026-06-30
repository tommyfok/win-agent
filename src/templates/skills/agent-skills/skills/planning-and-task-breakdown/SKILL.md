# planning-and-task-breakdown — 任务拆分

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：把 Feature Spec 拆成 DEV 可独立交付、独立验证、独立回滚的最小有价值变更。

## When to use

- 任务超过单个小改动、存在依赖、可并行或需要分阶段验证。
- 需要为多个 DEV directive 声明执行顺序与依赖。
- 单个需求涉及数据模型/API/UI/迁移/重构/测试基建中两类及以上。
- 验收标准超过 6 条或跨 2 个以上模块。

## Steps

1. 按 spec 的功能点与模块边界初划任务清单。
2. 拆出技术基础设施、数据迁移、接口契约、前端接入、回归修复、文档更新为独立 task。
3. 为每个 task 写 Scope（只做什么 / 不做什么）、Dependencies、Acceptance Criteria（3-6 条）、Verification、Likely Files、Size。
4. 用 `task_dependencies` 声明顺序，把前置/并行关系写清楚。
5. 自检：若只产出 1 个 task，必须说明「为何无需继续拆分」。
6. 向用户一次性展示 spec 与拆分方案，取得明确确认后再派发。

## Required artifact

产出 **Task Breakdown**，每个 task 包含：

- Scope：只做什么 / 不做什么。
- Dependencies：依赖哪些 task 或外部条件。
- Acceptance Criteria：3-6 条优先；超过 6 条优先拆分。
- Verification：DEV 需要提供什么证据。
- Likely Files / Modules：如已知则列出。
- Size：XS / S / M / L；L 必须解释为何不能继续拆分。

## Common shortcuts / red flags

- 红旗：把一个端到端流程塞进单个大 task。
- 红旗：验收标准超过 6 条仍不拆分。
- 偷懒：不写 Scope 边界，DEV 把后续 task 一并实现。
- 偷懒：依赖关系靠口头描述，未写入 `task_dependencies`。

## Verification

- 每个 task 可独立交付、独立验证、独立回滚。
- 依赖关系已落库，执行顺序无环、无阻塞遗漏。
- 每个 task 验收标准 ≤6 条且可判定。
