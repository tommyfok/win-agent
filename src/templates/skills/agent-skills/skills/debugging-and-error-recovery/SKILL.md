# debugging-and-error-recovery — 调试与错误恢复

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：测试/build/lint/运行失败或 PM 打回时，记录复现、根因、修复与回归验证，避免「改了能跑就行」。

## When to use

- 测试、构建、lint 或运行时失败。
- PM 打回指出问题，需要排查根因。
- 修复后需要证明问题不再复现。
- 排查耗时 >5min 的技术问题。

## Steps

1. 记录复现命令与失败现象（完整报错/输出，不要只贴片段）。
2. 先查 `.win-agent/docs/known-issues.md` 是否已有同类问题。
3. 定位根因：定位到具体文件/行/依赖版本/数据状态，不要停留在猜测。
4. 实施最小修复，避免顺带重构无关代码。
5. 运行回归验证：复现测试转 Green，并跑相关 lint/build/test。
6. 记录 Debug Evidence；值得复用的双写到 knowledge 与 known-issues.md。

## Required artifact

产出 **Debug Evidence**：

```markdown
## Debug Evidence

- Reproduction:
- Failure:
- Root cause:
- Fix:
- Regression verification:
```

- 可写入 review_result，问题值得复用时双写到 knowledge 和 `.win-agent/docs/known-issues.md`。
- Regression verification 必须是实际执行结果，非声明。

## Common shortcuts / red flags

- 红旗：改到不报错就停，未确认根因。
- 红旗：只贴「已修复」，无复现命令与回归输出。
- 偷懒：用 try/catch 吞掉错误当修复。
- 偷懒：排查 >5min 的问题不归档，下次重复踩坑。

## Verification

- Debug Evidence 字段完整，Root cause 指向具体位置。
- Regression verification 为实际命令输出。
- 值得复用的问题已双写归档。
