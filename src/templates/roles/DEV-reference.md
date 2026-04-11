# DEV 参考手册

## 归档规则

> 如果 docs 文件夹或对应文件不存在，直接创建。仅完成 Step A 或仅完成 Step B 视为归档未完成，两步都做才算完成。开发过程中已归档的无需重复。

| 场景 | Step A：写入 DB | Step B：追加 MD |
|------|----------------|----------------|
| 遇到技术问题（库/框架坑、lint 规则、构建问题、排查 >5min 的问题） | `database_insert` → `knowledge`（`category='issue'`） | 追加 `.win-agent/docs/known-issues.md` |
| 发现项目开发细节、经验 | `database_insert` → `knowledge`（`category='dev_note'`） | 追加 `.win-agent/docs/dev-notes.md` |
| 发现效率瓶颈或重复操作 | `database_insert` → `knowledge`（`category='efficiency'`） | 追加 `.win-agent/docs/efficiency-and-skills.md` |

> `knowledge.category` 枚举值：`issue`、`dev_note`、`efficiency`、`requirement`、`convention`、`reference`，仅限以上值。
> 规则类文件（`development.md`、`validation.md`）以 Markdown 为主，无需双写 DB。

---

## 验收报告格式

```
database_insert({ table: "messages", data: {
  from_role: "DEV", to_role: "PM", type: "feedback",
  content: "feature#N 验收报告：\n\n## 实现说明\n[做了什么，git diff 摘要]\n\n## 代码检查\n[lint/build/test 命令及输出]\n\n## E2E 验收\n[端到端验证的操作步骤、命令输出/截图]\n\n## 验收标准逐项确认\n- [标准1]：✅ [证据]\n- [标准2]：✅ [证据]\n\n## 经验归档\n[本次归档的经验条目，无则写"无新增"]",
  related_task_id: N, status: "unread"
}})
```

---

## 阻塞消息格式

```
database_insert({ table: "messages", data: {
  from_role: "DEV", to_role: "PM", type: "feedback",
  content: "feature#N 阻塞：\n\n## 问题描述\n[具体遇到了什么问题]\n\n## 已尝试\n[做了哪些排查，结果如何]\n\n## 需要 PM 协助\n[需要什么信息或决策]",
  related_task_id: N, status: "unread"
}})
```

---

## Proposal

发现不紧急但有价值的事项（更优实现、技术债务、测试盲区等），写入 proposals 表（submitted_by: "DEV"）。

---

## docs 速查

| 文件 | 何时阅读 |
|------|----------|
| `.win-agent/docs/development.md` | Phase 3 Step 1（环境准备）、Step 3（编码实现） |
| `.win-agent/docs/validation.md` | Phase 3 Step 2（基线验证）、Step 4（代码检查）、Step 5（E2E 验收） |
| `.win-agent/docs/known-issues.md` | 遇到报错时，排查前先查阅 |
| `.win-agent/docs/dev-notes.md` | 涉及对应子项目时，了解项目特有经验 |
| `.win-agent/docs/efficiency-and-skills.md` | 收尾归档时参考，避免重复记录 |
