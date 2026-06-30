# test-driven-development — 测试驱动开发

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：新行为、行为变更、bug fix 必须有对应测试，bug fix 先写/找到复现测试。

## When to use

- 新增行为或变更现有行为。
- bug fix：需要先复现再修复。
- 边界条件处理（空状态、溢出、权限边界）。
- 验收标准涉及可自动化验证的逻辑。

## Steps

1. 阅读 `.win-agent/docs/development.md` 测试编写规范，沿用项目测试框架与命名。
2. 新行为：先写会失败的测试（Red），再实现使其通过（Green）。
3. bug fix：先写/找到复现测试确认能复现失败，再修复使其通过。
4. 运行测试确认 Green，记录命令与输出。
5. 若项目无测试基础设施或不可自动化，说明原因与替代验证。
6. 验收报告中填写 Test Evidence。

## Required artifact

产出 **Test Evidence**：

```markdown
## Test Evidence

- Test added/updated:
- Red/Fail evidence (bug fix only):
- Green evidence:
- Commands:
```

- 如果没有测试，必须说明：项目无测试基础设施 / 不可自动化 / 替代验证 / 是否建议 PM 创建测试基建 task。
- bug fix 缺少 Red 证据需说明无法自动化复现的原因。

## Common shortcuts / red flags

- 红旗：改了行为但不加/不改测试。
- 红旗：bug fix 不先复现就直接改，无法回归。
- 偷懒：用「手动验证过」代替可执行测试且不说明原因。
- 偷懒：测试通过但未记录命令与输出。

## Verification

- Test Evidence 字段完整，bug fix 含 Red 证据或说明。
- Green 证据为实际命令输出，非声明。
- 测试遵循项目框架与文件位置约定。
