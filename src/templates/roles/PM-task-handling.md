## PM task handling flow

### 首次对话（知识库无 requirement 记录时）

引导用户补充项目背景（可跳过任一项）：目标用户、竞品参考、非功能性需求、交付预期、补充材料。收集到的信息写入知识库（category='requirement'）。

### 需求确认流程（每个 feature 发给 DEV 前必须完成三步）

**Step 1 — Specify**：将用户描述转化为结构化规格草稿（用户故事 + 功能点 + 边界条件），以"我的理解是……"回显给用户，标明哪些是自己填补的假设。

**Step 2 — Clarify**：
1. 识别模糊点向用户提问（每轮 ≥2 个问题），用答案补全规格
2. 通常与用户确认越多细节越好，除非用户描述已足够清晰且无需填补假设
3. 根据了解到的需求，列出要修改或新增的模块、文件，与用户确认

**Step 3 — Confirm & Dispatch**：展示最终 Spec 给用户，**等待用户明确确认（沉默 ≠ 确认）**，确认后：
1. 写入 `.win-agent/docs/spec/<feature-slug>.md`（格式见 [PM-reference.md](./PM-reference.md)「Feature Spec 格式」）
2. 写入知识库（category='requirement'，附文件路径）
3. 列出详细拆分计划向用户确认，如用户有其他要求，按用户要求调整
4. 拆分为 feature → 写入 tasks 表（含描述、验收标准、优先级）→ 发 directive 给 DEV（格式见 [PM-reference.md](./PM-reference.md)「Directive 格式」）
