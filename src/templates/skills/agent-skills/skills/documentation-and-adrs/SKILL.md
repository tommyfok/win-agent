# documentation-and-adrs — 文档与架构决策记录

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：公共接口、架构决策、运维流程或规则文档变化时，同步更新文档并记录关键决策。

## When to use

- 新增/修改公共接口、组件 API、模块对外行为。
- 做出影响后续实现的架构决策。
- 运维流程、部署规则或验收命令变化。
- 需要让后续 agent 理解「为什么这样做」。

## Steps

1. 识别本变更影响的文档（overview/development/validation/spec/known-issues）。
2. 更新受影响的规则类文档（命令、流程、约定）。
3. 对关键架构决策记录 ADR：背景、决策、替代方案、后果。
4. 接口变更同步到 spec 或技术方案的接口契约章节。
5. 经验类问题双写到 knowledge 与对应 docs 文件。
6. 验收时确认文档与代码一致，无遗留 TODO。

## Required artifact

产出 **Doc / ADR Update**：

```markdown
## Doc / ADR Update

- 受影响文档:
- 更新内容摘要:
- ADR（如有）:
  - 背景:
  - 决策:
  - 替代方案:
  - 后果:
- 残留 TODO:
```

- 文档变更须与代码变更同批次完成。
- 关键决策必须有 ADR，避免「只有代码没有为什么」。

## Common shortcuts / red flags

- 红旗：改了接口/流程但不更新文档。
- 红旗：关键架构决策无 ADR，后续无人知为何如此。
- 偷懒：文档留一堆 TODO 不补。
- 偷懒：只改代码不双写 knowledge（经验类问题）。

## Verification

- 受影响文档已更新且与代码一致。
- 关键决策有 ADR 记录。
- 残留 TODO 已列出或有明确计划。
