# DEV 参考手册

## Skill 证据门槛

DEV 触发 [DEV.md](./DEV.md)「DEV Skill Router Matrix」中的 skill 后，必须在 Phase 4 验收报告留下对应证据章节。任务很小可跳过，但验收报告要写明「无需该 skill 的原因」。

### Slice Plan 门槛（incremental-implementation）

多文件任务开始编码前，至少形成内部 slice plan。验收报告中简要汇总：

```markdown
## Slice Plan

- Slice 1:
  - Scope:
  - Verification:
- Slice 2:
  - Scope:
  - Verification:
```

规则：

- 任务很小可跳过，但验收报告要写「无需 slice 的原因」。
- 不允许长时间积累大批未验证改动后一次性测试。

### Test Evidence 门槛（test-driven-development）

行为变更或 bug fix 必须提供：

```markdown
## Test Evidence

- Test added/updated:
- Red/Fail evidence (bug fix only):
- Green evidence:
- Commands:
```

如果没有测试，必须说明：

- 当前项目没有测试基础设施，或该变更不可自动化测试。
- 使用了什么替代验证。
- 是否建议 PM 创建后续测试基建 task。

### Debug Evidence 门槛（debugging-and-error-recovery）

发生失败或 PM 打回时，必须记录：

```markdown
## Debug Evidence

- Reproduction:
- Failure:
- Root cause:
- Fix:
- Regression verification:
```

可写入 review_result，问题值得复用时双写到 knowledge 和 `.win-agent/docs/known-issues.md`。

### Source Evidence 门槛（source-driven-development）

涉及框架关键用法时，优先查官方文档。验收报告中至少写：

```markdown
## Source Evidence

- Stack/version:
- Official docs checked:
- Decision:
- Conflict with existing code (if any):
```

规则：

- 不要求所有小改动都联网查文档。
- 新框架、陌生 API、升级/迁移、认证/路由/数据获取/状态管理等模式必须查。

---

## 归档规则

> 如果 docs 文件夹或对应文件不存在，直接创建。仅完成 Step A 或仅完成 Step B 视为归档未完成，两步都做才算完成。开发过程中已归档的无需重复。

| 场景                                                              | Step A：写入 DB                                            | Step B：追加 MD                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| 遇到技术问题（库/框架坑、lint 规则、构建问题、排查 >5min 的问题） | `database_insert` → `knowledge`（`category='issue'`）      | 追加 `.win-agent/docs/known-issues.md`          |
| 发现项目开发细节、经验                                            | `database_insert` → `knowledge`（`category='dev_note'`）   | 追加 `.win-agent/docs/dev-notes.md`             |
| 发现效率瓶颈或重复操作                                            | `database_insert` → `knowledge`（`category='efficiency'`） | 追加 `.win-agent/docs/efficiency-and-skills.md` |

> `knowledge.category` 枚举值：`issue`、`dev_note`、`efficiency`、`requirement`、`convention`、`reference`，仅限以上值。
> 规则类文件（`development.md`、`validation.md`）以 Markdown 为主，无需双写 DB。

---

## 验收报告格式

```
database_insert({ table: "messages", data: {
  from_role: "DEV", to_role: "PM", type: "review_result",
  content: "feature#N 验收报告：\n\n## 实现说明\n[做了什么，git diff 摘要]\n\n## 代码检查\n[lint/build/test 命令及输出]\n\n## E2E 验收\n[端到端验证的操作步骤、命令输出/截图]\n\n## 验收标准逐项确认\n\n对照 spec 文件中的每一条验收标准，逐条列出：\n\n- [标准原文]：✅ [具体证据：命令输出/截图/代码引用，不接受纯文字声明]\n- [标准原文]：❌ [未实现的原因和计划]\n\n**如有任何标准标记为 ❌，不得提交验收报告，必须先完成或发阻塞消息给 PM。**\n\n## 经验归档\n[本次归档的经验条目，无则写\"无新增\"]\n\n## Skill 证据（按触发的 skill 填写，未触发则省略或写\"未触发\"）\n- Slice Plan / Test Evidence / Debug Evidence / Source Evidence / Security·API Notes：见上方「Skill 证据门槛」对应模板",
  related_task_id: N,
  related_iteration_id: N,
  attachments: JSON.stringify({
    protocol: "win-agent.message.v1",
    type: "review_result",
    task_id: N,
    iteration_id: N,
    result: "submitted"
  }),
  status: "unread"
}})
```

---

## 阻塞消息格式

```
database_insert({ table: "messages", data: {
  from_role: "DEV", to_role: "PM", type: "feedback",
  content: "feature#N 阻塞：\n\n## 问题描述\n[具体遇到了什么问题]\n\n## 已尝试\n[做了哪些排查，结果如何]\n\n## 需要 PM 协助\n[需要什么信息或决策]",
  related_task_id: N,
  related_iteration_id: N,
  attachments: JSON.stringify({
    protocol: "win-agent.message.v1",
    type: "feedback",
    task_id: N,
    iteration_id: N,
    reason: "blocked"
  }),
  status: "unread"
}})
```

---

## Proposal

发现不紧急但有价值的事项（更优实现、技术债务、测试盲区等），写入 proposals 表（submitted_by: "DEV"）。

---

## docs 速查

| 文件                                       | 何时阅读                           |
| ------------------------------------------ | ---------------------------------- |
| `.win-agent/docs/development.md`           | Phase 3 步骤 1（开发）             |
| `.win-agent/docs/validation.md`            | Phase 3 步骤 2（验证）             |
| `.win-agent/docs/known-issues.md`          | 遇到报错时，排查前先查阅           |
| `.win-agent/docs/dev-notes.md`             | 涉及对应子项目时，了解项目特有经验 |
| `.win-agent/docs/efficiency-and-skills.md` | 收尾归档时参考，避免重复记录       |
| `.win-agent/skills/agent-skills/skills/`   | 按 DEV Skill Router Matrix 触发时按需读取对应 `SKILL.md` |
