# 脚手架任务流程（`[scaffold]`）

> 脚手架任务不执行常规 Step 1-5（无已有环境和基线），改为以下流程：

| Step | 做什么 |
|------|--------|
| **S1 — 创建项目** | 根据 directive 中的技术选型，使用脚手架工具（如 `npx create-xxx`）或手动搭建项目结构 |
| **S2 — 基础配置** | 配置 lint/format/test 工具、tsconfig、.gitignore 等开发基础设施 |
| **S3 — 验证可用** | 安装依赖 → build 通过 → dev server 可启动（如适用，启动即记录 PID 到 `.win-agent/.dev-pids`，验证后立即关闭）→ lint 通过 |
| **S4 — 更新 docs** | **必须**根据实际项目配置更新 `.win-agent/docs/development.md` 和 `.win-agent/docs/validation.md`（从占位模板填充为实际命令和规范） |
| **S5 — 提交验收** | git init（如需）+ git add + commit，进入 Phase 4 |
