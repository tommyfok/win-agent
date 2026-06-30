# incremental-implementation — 增量实现

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：多文件改动先列 slice plan，每个 slice 保持可构建、可验证，避免一次性堆大批未验证改动。

## When to use

- 多文件改动、较大功能、容易一次性写太多代码。
- 任务跨多个模块，需要分阶段验证。
- 长时间积累改动后一次性测试风险高。

## Steps

1. 阅读 spec / directive，明确改动范围与验收标准。
2. 把改动切成若干 slice，每个 slice 是可独立构建、可验证的最小增量。
3. 为每个 slice 写 Scope 与 Verification（用什么命令/测试验证）。
4. 按 slice 顺序实现，每完成一个 slice 立即验证再进入下一个。
5. 遇到失败立即停下排查，不要带病叠加下一 slice。
6. 验收报告中汇总 Slice Plan 与每个 slice 的验证结果。

## Required artifact

产出 **Slice Plan**（验收报告中汇总）：

```markdown
## Slice Plan

- Slice 1:
  - Scope:
  - Verification:
- Slice 2:
  - Scope:
  - Verification:
```

- 任务很小可跳过，但验收报告要写「无需 slice 的原因」。
- 不允许长时间积累大批未验证改动后一次性测试。

## Common shortcuts / red flags

- 红旗：一口气改完所有文件才跑测试。
- 红旗：slice 之间无验证，依赖最后一次性验证兜底。
- 偷懒：slice 范围过大，失去增量意义。
- 偷懒：跳过 slice plan 又不写理由。

## Verification

- 每个 slice 有明确的 Verification 并实际执行。
- 中间任一 slice 失败有记录，未带病推进。
- 验收报告含 Slice Plan 或「无需 slice 的原因」。
