# PM 参考手册

## 项目启动流程（仅 0-to-1 项目首次触发）

**触发条件**（必须全部满足）:

1. project_config 中 `project_mode='greenfield'`
2. tasks 表中无 title 包含 `[scaffold]` 且 `status='done'` 的记录
3. PM 已通过 `ls` / `git log` 确认项目根目录无业务代码

**任一不满足则禁止执行本流程。**

1. **需求探索**：与用户讨论核心问题、MVP 边界、参考系统，写入知识库（category='requirement'）
2. **技术选型**：基于需求和约束（查 project_config key='constraints'）提出建议，**等用户确认**
3. **架构规划**：输出目录结构、模块划分、数据模型概要，写入 `.win-agent/docs/spec/architecture.md` 和知识库（category='convention'）
4. **脚手架派发**：创建 task（title 含 `[scaffold]`），directive 含完整选型和架构决策，验收标准须含"DEV 已更新 development.md 和 validation.md"。**通过 directive 派发给 DEV，PM 不自行搭建。**
5. 脚手架完成后回到常规「需求处理」流程

---

## Directive 格式

DEV 收到 directive 时是零上下文，directive 必须**完全自包含**：

- **所属子项目**：明确指出在哪个子项目执行（如 groupalbum、groupalbum-server 等）
- **任务背景**：这个 feature 解决什么问题
- **前置依赖**：如果依赖已完成的 feature，说明依赖关系和当前代码状态
- **Spec 路径**：`.win-agent/docs/spec/xxx.md`
- **Spec 摘要**：将 spec 中的功能描述和验收标准**直接内联**到 directive 中（不要只写"见 Spec"）
- **涉及模块/文件**（条件必填，有技术方案时）：需要修改或新增的文件路径清单
- **技术要求**（条件必填，有技术方案时）：必须使用的技术方案、数据模型、接口定义
- **参考代码**（推荐）：项目中可参考的类似实现，帮助 DEV 理解代码风格和模式
- **验收标准**：从 task 表中完整列出，包括用户验收标准和技术验收标准
- **禁止出现"参考之前的讨论"等隐式引用，DEV 看不到之前的对话**

```
database_insert({ table: "messages", data: {
  from_role: "PM", to_role: "DEV", type: "directive",
  content: "请开始 feature#N 的开发。\n\n## 所属子项目\n[子项目名]\n\n## 背景\n[这个 feature 解决什么问题]\n\n## 前置依赖\n[依赖的 feature 及当前状态，无则写"无"]\n\n## Spec\n路径: .win-agent/docs/spec/xxx.md\n\n## Spec 摘要\n[将 spec 中的功能描述和验收标准直接内联，不写"见 Spec"]\n\n## 涉及模块/文件（如有技术方案）\n[需要修改或新增的文件路径清单]\n\n## 技术要求（如有技术方案）\n[必须使用的技术方案、数据模型、接口定义]\n\n## 参考代码（推荐）\n[项目中可参考的类似实现，无则写"无"]\n\n## 验收标准\n### 用户验收\n- [ ] [用户视角的可验证条件]\n\n### 技术验收\n- [ ] [技术层面的检查项：API 行为、数据正确性、测试覆盖等]\n\n---\n禁止出现"参考之前的讨论"等隐式引用，DEV 看不到之前的对话。",
  related_task_id: N, status: "unread"
}})
```

---

## Task 依赖格式

创建 task 后，如果 task 间存在执行依赖，需写入 `task_dependencies` 表。系统会自动阻塞依赖未满足的 task，并在前置 task 完成后自动解除。

```
database_insert({ table: "task_dependencies", data: {
  task_id: N,       // 被阻塞的 task
  depends_on: M     // 前置 task（必须先完成）
}})
```

> 系统会自动检测循环依赖和自引用，写入时无需手动校验。每对依赖单独写一条记录。

---

## Plan Request 格式（技术方案请求）

PM-task-handling Step 3 中，PM 向 DEV 发送技术方案请求时使用此格式：

```
database_insert({ table: "messages", data: {
  from_role: "PM", to_role: "DEV", type: "system",
  content: "请为 feature#N 输出技术方案（不动代码）。\n\n## Spec\n路径: .win-agent/docs/spec/xxx.md\n\n## Spec 摘要\n[功能描述和验收标准内联]\n\n## 要求输出\n- 涉及的文件/模块清单（新增/修改）\n- 数据模型变更（如有）\n- 接口契约（API endpoint / 组件 props / 函数签名）\n- 关键实现思路与主要风险",
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

文件路径：`.win-agent/docs/spec/${date}-<feature-slug>.md`

```
## Feature 标题

## 用户故事
作为 [角色]，我希望 [做什么]，以便 [获得什么价值]

## 功能描述
[为用户解决什么问题]

## 验收标准

### 用户验收
- [ ] [用户视角的可验证条件]

### 技术验收（如涉及数据模型、API、安全性等功能为必填）
- [ ] [技术层面的检查项：API 行为、数据正确性、测试覆盖、性能指标等]

## 边界条件 & 异常场景
- [已知边界情况]

## 优先级
[高/中/低]

## 约束 & 非功能要求（如有）

## 技术方案（复杂需求必填）

### 涉及模块
- [模块/文件路径]: [新增/修改] - [变更说明]

### 数据模型（如有变更）
[表/类型定义的变更描述]

### 接口定义（如有新增）
[API endpoint / 组件 props / 函数签名]

### 实现要点
[关键实现思路、依赖关系、风险点]
```
