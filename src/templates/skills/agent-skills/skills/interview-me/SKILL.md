# interview-me — 意图澄清访谈

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：在写 spec 前，用结构化访谈确认用户真实意图，避免把错误假设写成「正确 spec」。

## When to use

- 缺少用户是谁、为什么现在做、成功标准、关键约束或非目标。
- PM 发现自己在自行填补假设（「我猜用户想要……」）。
- 用户只有一句话需求，且无法判断验收边界。
- 用户描述的方案与其真实目标之间存在落差。

## Steps

1. 先列出已知信息与未知项，明确缺哪些维度（who / why / success / constraint / out-of-scope）。
2. 按 AskQuestion 格式组织提问，每轮至少 2 个问题，给出 2-4 个候选 + 其他 + 跳过。
3. 区分「用户想要的」与「用户实际需要的」：追问目标，而非只问实现细节。
4. 用「我的理解是……」回显，标明填补的假设，请用户确认或纠正。
5. 识别矛盾或模糊边界，必要时再次追问，不要带着歧义进入 spec。
6. 若用户拒绝继续澄清，记录「用户要求跳过澄清」并列出剩余风险。

## Required artifact

产出 **Confirmed Intent** 并取得用户明确确认：

```markdown
## Confirmed Intent

- Outcome:
- User:
- Why now:
- Success:
- Constraint:
- Out of scope:
- Confidence:
- Explicit confirmation:
```

- `Confidence < 70%` 不得进入 spec。
- 「随便你」「你看着办」「直接做」不算 explicit confirmation。

## Common shortcuts / red flags

- 红旗：PM 跳过提问，直接把脑补需求写进 spec。
- 红旗：把用户随口一句当成完整确认。
- 偷懒：只问技术细节，不问目标与成功标准。
- 偷懒：一轮提问就草草结束，未覆盖非目标与约束。

## Verification

- Confirmed Intent 每个字段非空或显式标注「不适用」。
- 存在用户对 Confirmed Intent 的明确认可语句。
- 剩余风险已记录，Confidence 已量化。
