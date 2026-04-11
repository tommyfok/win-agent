# plan-02.md 修正计划

基于 plan-02.md 的审查，以下是需要修正的问题及具体改法。

---

## 修正 1：幂等检查前移

**问题：** Phase 3（幂等检查）在 Phase 2（工作空间初始化）之后，目录已经创建/覆盖了再检查没有意义。

**改法：** Phase 2 和 Phase 3 互换顺序。先检测 `.win-agent/` 是否已存在，用户确认后再执行目录创建。

---

## 修正 2：Phase 编号规范化

**问题：** Phase 4.5 是后插的编号，不规范。

**改法：** 从 Phase 1 到 Phase 10 连续编号。原 Phase 4（项目信息收集）不变，原 Phase 4.5（模式检测）改为 Phase 5，后续依次顺延。

---

## 修正 3："已有代码"选项逻辑矛盾

**问题：** Phase 4.5 说"已有代码"选项会"Phase 7 跳过分析（等代码放入后 re-init）"，但 Phase 7 的"已有代码模式"描述的是直接启动 AI 分析。两处行为矛盾。而且 `re-init` 这个概念在文档中没有定义。

**改法：**
- 将选项名从"已有代码"改为"稍后放入代码"，语义更准确
- 增加 `project_mode='pending'` 状态与 greenfield 区分
- 明确"re-init"就是用户再跑一次 `init` 命令（幂等检查会询问是否重新运行）
- 在 Phase 8（原 Phase 7）补充 pending 模式的路径描述：跳过分析，生成骨架文档，提示用户代码就绪后重新 init

---

## 修正 4：greenfield 模式下 overview.md 生成时机不明

**问题：** Phase 7 greenfield 路径只生成占位的 `development.md` 和 `validation.md`，没提 `overview.md`。但自动触发条件说脚手架完成后"通知 PM 生成 overview.md"，Phase 9 又说"docs 文件缺失则创建骨架模板"。三处不一致。

**改法：** Phase 8（原 Phase 7）greenfield 路径补上 `overview.md` 的占位生成，三份文档统一处理。Phase 10（原 Phase 9）的兜底逻辑保留但不再是 overview.md 的主要来源。

---

## 修正 5：greenfield 首次启动被审阅检查卡死

**问题：** 3.1 前置检查要求所有 docs 文件被修改过且无 TODO 标记，否则拒绝启动。但 greenfield 模式下 docs 全是占位内容（"待脚手架任务完成后补充"），用户无法有意义地审阅，会被永远卡在启动环节。

**改法：**
- Phase 10（原 Phase 9）快照 mtime 时区分模式：greenfield/pending 仅快照角色文件（roles/），不快照 docs
- 3.1 审阅检查同步调整：greenfield 模式仅检查角色文件是否被修改，跳过 docs 的 TODO 检查
- STEP 2 用户审阅表格按模式拆分，greenfield 只列角色文件，注明 docs 在脚手架完成后单独审阅

---

## 修正 6：DEV 文件权限自相矛盾

**问题：** STEP 6 开头说"禁止操作 `.win-agent/` 目录"，但经验归档要写 `.win-agent/docs/known-issues.md` 等文件，规则自相矛盾。

**改法：** 将笼统的"禁止操作 `.win-agent/`"改为白名单制，明确列出：
- ✅ `.win-agent/docs/known-issues.md`、`dev-notes.md`、`efficiency-and-skills.md`：仅追加（经验归档）
- ✅ `.win-agent/docs/development.md`、`validation.md`：仅在 `[scaffold]` 和 `[update-docs]` 任务中允许
- ❌ `.win-agent/` 下其他文件：禁止

同时给 `role_permissions` 表补充说明"角色文件访问控制（白名单规则）"，让这张表有实际用途。

---

## 修正 7：目录结构缺少归档文件

**问题：** Phase 2 的目录树只列了 `overview.md`、`development.md`、`validation.md`、`spec/`，但经验归档多次引用 `known-issues.md`、`dev-notes.md`、`efficiency-and-skills.md`，目录结构图里看不到。

**改法：** 在 `docs/` 下补全这三个文件。

---

## 修正 8：报错处理"超过 30 分钟"不可行

**问题：** LLM Agent 没有可靠方式感知墙钟时间，"超过 30 分钟"这个阈值在实际中无法执行。

**改法：** 改为"连续失败超过 5 轮排查仍未解决"，基于 Agent 可观测的轮次指标。

---

## 修正 9："PM 饥饿保护"命名反了

**问题：** "PM 饥饿保护：PM 连续调度 3 次后让位给 DEV"——这保护的是 DEV 不被饿死，不是 PM。

**改法：** 改名为"DEV 饥饿保护"。

---

## 优先级

关键（会导致流程卡死或逻辑错误）：修正 3、5、6

重要（信息不一致，会导致实现混乱）：修正 1、4、7

次要（命名/指标优化）：修正 2、8、9
