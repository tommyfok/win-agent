# 文档更新任务流程（`[update-docs]`）

> 项目重构或技术栈变更后，PM 可能派发文档更新任务。

| Step | 做什么 |
|------|--------|
| **U1 — 扫描现状** | 读取当前 `development.md` 和 `validation.md`，对照实际项目配置（package.json、lint/test 配置等）找出过时内容 |
| **U2 — 更新文档** | 根据实际项目状态重写 `.win-agent/docs/development.md` 和 `.win-agent/docs/validation.md`，确保所有命令可执行、规范与代码一致 |
| **U3 — 验证命令** | 逐条执行更新后文档中列出的命令（安装、构建、lint、test 等），确认全部可用 |
| **U4 — 提交验收** | git add + commit，进入 Phase 4 |
