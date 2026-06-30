# idea-refine — 方向收敛与方案比较

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：在用户方向未收敛时，发散比较多个 MVP 方向并形成结构化 one-pager，再进入 spec。

## When to use

- 用户只有模糊想法，多个方案都可能成立。
- 需要先比较 MVP 方向，而非直接写完整 spec。
- 技术选型或产品形态存在明显分叉，需要用户做取舍。
- PM 无法判断哪个方向更符合用户真实目标。

## Steps

1. 复述用户原始想法，标明其中模糊或未定的部分。
2. 至少列出 2 个候选方向，给出各自的核心假设、MVP 范围与代价。
3. 对每个方向评估：解决什么问题、关键假设、不做什么。
4. 给出推荐方向并说明理由，同时列出开放问题。
5. 用 AskQuestion 请用户选择或确认方向。
6. 用户确认后，将方向固化为 Idea One-pager，再进入 spec。

## Required artifact

产出 **Idea One-pager** 并取得用户选择或确认：

```markdown
## Idea One-pager

- Problem Statement:
- Recommended Direction:
- Alternatives Considered:
- Key Assumptions:
- MVP Scope:
- Not Doing:
- Open Questions:
```

- 至少比较 2 个方向，除非用户明确已指定唯一方向。
- `Not Doing` 必填，避免后续 task 膨胀。
- 未确认方向时，不得进入 task dispatch。

## Common shortcuts / red flags

- 红旗：只列 1 个方向就直接进入实现。
- 红旗：`Not Doing` 留空，导致 scope 后续失控。
- 偷懒：用「都做」回避取舍。
- 偷懒：方案比较停留在口号，不写假设与代价。

## Verification

- Idea One-pager 字段完整，至少含 2 个候选方向。
- 存在用户对推荐方向的明确选择/确认。
- 开放问题已列出，未遗留影响派发的歧义。
