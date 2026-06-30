# browser-testing-with-devtools — 浏览器运行时验证

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：Web UI / 浏览器运行时变更，用 Playwright MCP 操作页面、查 console/network/DOM、截图留证。

## When to use

- Web 前端/全栈项目的 UI 行为变更。
- 需要验证 console 报错、网络请求、DOM 渲染或截图。
- 验收标准涉及用户可见的浏览器行为。
- Agent 可自主执行（非手动 GUI 操作）。

## Steps

1. 启动 dev server（按 validation.md 启动方式，必要时记录 PID 便于清理）。
2. 用 Playwright MCP 打开目标页面，执行关键交互。
3. 检查 console 是否有报错、network 请求是否返回预期。
4. 检查关键 DOM/元素状态是否符合预期。
5. 截图留证关键状态与结果。
6. 完成后按对称原则清理常驻进程。

## Required artifact

产出 **Browser Verification**：

```markdown
## Browser Verification

- 启动命令:
- 访问 URL / 操作步骤:
- Console: 无报错 / [报错摘要]
- Network: 关键请求与状态码
- DOM / 元素状态:
- 截图: [引用]
- 清理: 已执行 / 不适用
```

- 禁止生成需人类手动操作的步骤。
- 启动了常驻进程必须有对称清理步骤。

## Common shortcuts / red flags

- 红旗：只看页面能打开，不查 console/network。
- 红旗：启动 dev server 不留清理步骤，污染后续运行。
- 偷懒：用「手动看过」代替可复现的 MCP 操作记录。
- 偷懒：不截图，验收无据可查。

## Verification

- Browser Verification 字段完整，含 console/network 结论。
- 关键状态有截图或 DOM 断言。
- 常驻进程已清理，无残留。
