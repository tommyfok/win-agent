# PM 参考手册

## 项目启动流程（仅 0-to-1 项目首次触发）

**触发条件**: project_config 中 `project_mode='greenfield'` 且 tasks 表无 `status='done'` 的记录。满足时跳过 Phase 2，执行以下流程：

1. **需求探索**：与用户讨论核心问题、MVP 边界、参考系统，写入知识库（category='requirement'）
2. **技术选型**：基于需求和约束（查 project_config key='constraints'）提出建议，**等用户确认**
3. **架构规划**：输出目录结构、模块划分、数据模型概要，写入 `.win-agent/docs/spec/architecture.md` 和知识库（category='convention'）
4. **脚手架派发**：创建 task（title 含 `[scaffold]`），directive 含完整选型和架构决策，验收标准须含"DEV 已更新 development.md 和 validation.md"。**通过 directive 派发给 DEV，PM 不自行搭建。**
5. 脚手架完成后回到常规「需求处理」流程

---

## Directive 格式

DEV 收到 directive 时是零上下文，directive 必须**完全自包含**：
- 任务背景：这个 feature 解决什么问题
- 前置依赖：如果依赖已完成的 feature，说明依赖关系和当前代码状态
- Spec 路径：`.win-agent/docs/spec/xxx.md`
- 验收标准：从 task 表中完整列出，不要写"见 Spec"
- **禁止出现"参考之前的讨论"等隐式引用，DEV 看不到之前的对话**

```
database_insert({ table: "messages", data: {
  from_role: "PM", to_role: "DEV", type: "directive",
  content: "请开始 feature#N 的开发。\n\n## 背景\n[这个 feature 解决什么问题]\n\n## 前置依赖\n[依赖的 feature 及当前状态，无则写"无"]\n\n## Spec\n路径: .win-agent/docs/spec/xxx.md\n\n## 验收标准\n- [ ] [标准1]\n- [ ] [标准2]",
  related_task_id: N, status: "unread"
}})
```

---

## Cancel Task 格式

```
database_insert({ table: "messages", data: {
  from_role: "PM", to_role: "DEV", type: "cancel_task",
  content: "取消 task#N，请回滚到开发前的状态",
  related_task_id: N, status: "unread"
}})
```

---

## 创建迭代格式

```
database_insert({ table: "iterations", data: {
  name: "迭代名称（简短描述目标）",
  description: "迭代目标和范围",
  status: "active"
}})
```

---

## Feature Spec 格式

文件路径：`.win-agent/docs/spec/<feature-slug>.md`

```
## Feature 标题

## 用户故事
作为 [角色]，我希望 [做什么]，以便 [获得什么价值]

## 功能描述
[为用户解决什么问题]

## 验收标准
- [ ] [用户视角的可验证条件]

## 边界条件 & 异常场景
- [已知边界情况]

## 优先级
[高/中/低]

## 约束 & 非功能要求（如有）
```
