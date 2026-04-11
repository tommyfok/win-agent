# Win-Agent Docs + DB 双写协同计划（基于当前实现现状）

## 背景

当前 `win-agent` 已具备两类知识载体能力：

1. Markdown 文档（`.win-agent/docs/*.md`）  
   - 在角色模板中被引用：`development.md`、`validation.md`、`known-issues.md`、`dev-notes.md`、`efficiency-and-skills.md`
   - 用于流程规范与经验归档

2. 本地数据库（`win-agent.db`）  
   - 已有 `knowledge`、`memory`、`proposals` 等表，支持向量召回（`knowledge_vec` / `memory_vec`）
   - Onboarding 流程已支持向 `knowledge` 表写入知识；运行时调度层（scheduler/dispatcher）已支持向量相似度查询召回

目标是采用“双写保留”的策略：经验同时沉淀到 DB 和 Markdown；读取时优先 DB，未命中再查文档。  
当前 PM.md 对经验归档的指令为“更新 docs **或**写入 knowledge”（二选一），双写规范尚未建立。

## 当前实现状态（as-is）

1. 角色模板中已存在 docs 引用（开发/验证/经验归档）
2. 代码层已支持 `knowledge` / `memory` 的写入与召回
3. 尚未形成统一的“检索顺序 + 双写格式 + 分类规范”
4. docs 文件本身可能按项目动态创建，不一定预置在仓库中

## 目标（to-be）

建立“DB 优先召回 + Markdown 归档可读”的统一规则：

1. 明确双写范围（哪些经验类内容必须同时写 DB 与 MD）
2. 明确检索顺序（先 DB，再 docs）
3. 不引入 schema 变更即可执行
4. 降低双写后的一致性风险

## 协同策略

### A. 读取顺序（统一）

1. 遇到问题或需要历史经验时，先查询 DB：`knowledge` / `memory`
2. DB 无有效命中或需要流程原文时，再查看 `.win-agent/docs/*`

### B. 双写范围（统一）

经验类内容执行双写（DB + MD）：

- 技术坑/排障经验：`knowledge(category='issue')` + `known-issues.md`
- 开发细节/实现经验：`knowledge(category='dev_note')` + `dev-notes.md`
- 效率优化/重复操作改进：`knowledge(category='efficiency')` + `efficiency-and-skills.md`

规则类内容以 Markdown 为主：

- `development.md`（开发流程规范）
- `validation.md`（自测与验收规范）

## 实施计划

### 阶段 1：规范定义（无代码/模板改动）

目标：把协同策略转化为可执行的书面约定，作为后续所有改动的参考基准。

产出：
- `knowledge.category` 枚举固定为：`issue`、`dev_note`、`efficiency`、`requirement`、`convention`、`reference`
- 双写时序约定：**先写 DB（`database_insert`），再追加 MD 对应文件**；仅写其一视为未完成
- 检索约定：**先向量查询 `knowledge` / `memory`，命中则直接使用；未命中或需要查看流程全文时，再打开 docs 文件**

---

### 阶段 2：更新 PM.md 归档指令（模板改动）

**触发原因**：PM.md 当前对经验归档的表述是"更新 docs **或**写入 knowledge"（二选一），与双写目标矛盾。

改动点：PM.md "验收审核流程" 第 6 步

| 场景 | 当前行为 | 目标行为 |
|------|----------|----------|
| 遇到技术问题 | 更新 `known-issues.md` **或** 写入 knowledge | 同时写入 `knowledge(category='issue')` **并** 追加 `known-issues.md` |
| 发现开发细节 | 更新 `dev-notes.md` **或** 写入 knowledge | 同时写入 `knowledge(category='dev_note')` **并** 追加 `dev-notes.md` |
| 发现效率瓶颈 | 更新 `efficiency-and-skills.md` **或** 写入 knowledge | 同时写入 `knowledge(category='efficiency')` **并** 追加 `efficiency-and-skills.md` |

同时在表格下方补充说明：若对应 docs 文件不存在，直接创建；DB 写入使用上述 category 枚举，不得自造分类。

---

### 阶段 3：更新 DEV.md 检索顺序（模板改动）

**触发原因**：DEV.md"开发和自测"第 3 步当前直接读 `known-issues.md`，没有先查 DB 的步骤。

改动点：将第 3 步调整为：

遇到报错，先向量查询 `knowledge`（`category='issue'`），有匹配经验直接参考；无匹配时再查 `.win-agent/docs/known-issues.md`；两者均无则自行排查，排查成功后执行双写。

---

### 阶段 4：将 docs 规则文件纳入 start 前置检查（代码改动）

**触发原因**：当前 `start.ts` 的 `checkRoleFilesReviewed()` 已对 `roles/*.md` 和 `overview.md` 做 mtime 快照比对——未修改则阻断启动（`process.exit(1)`）。`development.md` / `validation.md` 不在此机制覆盖范围内，用户可能跳过定制直接 start。

**改动涉及两个文件：**

**`onboarding.ts`**（快照阶段）：
1. onboard 流程结束前，检查 `.win-agent/docs/development.md` 和 `validation.md` 是否存在，不存在则创建含章节骨架的空白模板
2. 在 `snapshotRoleMtimes()` 同步或新增逻辑，将两个 docs 文件的 mtime 存入 `project_config`（key：`docs_mtimes_snapshot`）

**`start.ts`**（检查阶段）：
在 `checkRoleFilesReviewed()` 内读取 `docs_mtimes_snapshot`，与当前文件 mtime 对比，未改动则追加到阻断列表，输出格式与现有检查一致：

```
❌ 以下文件自 onboard 后未经修改，请审核后再启动：
   • .win-agent/docs/development.md
   • .win-agent/docs/validation.md

   根据项目实际情况审核并调整以上文件，完成后重新执行 npx win-agent start
```

---

### 阶段 5：运行验证

观察 1–2 个迭代，记录：

- **DB 命中率**：遇到问题时先查 DB，统计有效命中比例
- **双写完整性**：随机抽查 5 条 `knowledge` 记录，确认对应 md 中有同步记录
- **category 一致性**：`knowledge` 表中 category 字段是否只出现枚举值

如效果稳定，再评估二期（如增加 `source` 字段标记知识来源、自动同步脚本等）。

---

## 验收标准

1. PM.md 归档指令为"并"（双写），不再是"或"（单写）
2. DEV.md 遇到问题时先查 DB，再看 docs
3. `knowledge.category` 只使用约定枚举，无随意分类
4. Onboarding 完成后有明确提示要求定制 `development.md` / `validation.md`
5. 全程不引入 DB schema 变更

## 风险与缓解

1. **双写执行不完整**（只写 docs 漏写 DB，或反之）  
   缓解：在 PM.md 中将双写拆为两个明确步骤（step A 写 DB，step B 追加 md），不合并为一句话

2. **category 枚举随意扩展**  
   缓解：枚举值定义在本文档，模板中直接列出，不留"其他"兜底项

3. **development.md / validation.md 被跳过不写**  
   缓解：Onboarding 提示设为显眼警告；PM 首次派发 directive 前检查文件是否已定制（可加入 PM 环境感知步骤）

4. **docs 与 DB 内容不一致**（后续有人只改了其中一处）  
   缓解：约定 md 中只写"摘要 + 关键词"，详细内容在 DB；不追求两者完全一致，以 DB 为准

## 产出清单

| 产出 | 涉及文件 | 阶段 |
|------|----------|------|
| category 枚举约定 | 本文档 | 阶段 1 |
| PM.md 归档指令改为双写 | `src/templates/roles/PM.md` | 阶段 2 |
| DEV.md 检索步骤前置 DB 查询 | `src/templates/roles/DEV.md` | 阶段 3 |
| docs 规则文件 mtime 快照 | `src/cli/onboarding.ts` | 阶段 4 |
| start 前置检查覆盖 docs 文件 | `src/cli/start.ts` | 阶段 4 |
| docs 空白模板文件（首次 onboard 自动创建） | `.win-agent/docs/development.md` / `validation.md` | 阶段 4 |
