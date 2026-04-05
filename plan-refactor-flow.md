# 工作流重构计划：从"技术任务驱动"到"Feature 驱动"

## 一、问题诊断

### 当前模型的根本问题

当前工作流让 PM 承担了技术拆分职责：一个 feature 被拆成 5-10 个细粒度 task，每个 task 带依赖关系，每个 task 走完整的 Sprint Contract + 开发 + QA 验收流水线。

**实际后果**：
- 一个改 2 行代码的 task 要经历 4-6 轮调度（每轮 1s+ LLM 调用），仪式感远超实际价值
- task 间依赖导致 DEV 串行等待，前一个 task 没被 QA 标记 done，后一个就 blocked
- PM 花大量 token 在技术拆分上，而这不是 PM 的专业领域，拆分质量无法保证
- QA 逐个验收 1-2 行改动毫无意义，无法验证 feature 级别的完整性

### 真实开发流程

```
用户提需求 → PM 定义 feature（做什么、验收标准） → DEV 自主实现整个 feature → 
QA 验收完整 feature → DEV/QA 直接迭代修 bug → 通过 → PM 确认交付
```

核心区别：
- PM 只管"做什么"，不管"怎么做"
- DEV 自主决定实现方式，不需要被拆成碎片任务
- QA 验收的是完整 feature，不是代码片段
- DEV 和 QA 直接迭代修 bug，不需要每次经过 PM

---

## 二、目标设计

### Task 语义变化

| | 旧模型 | 新模型 |
|--|--------|--------|
| Task 粒度 | 技术子任务（改某个文件、加某个接口） | Feature 级（用户可感知的完整功能） |
| 谁创建 | PM 拆分 | PM 根据用户需求创建 |
| 谁决定怎么实现 | PM（写实现要点） | DEV 自主决定 |
| 依赖关系 | PM 定义 task 间依赖 | 基本不需要；如有，PM 只定义 feature 级别的先后顺序 |
| 验收对象 | 单个技术改动 | 完整 feature 的端到端功能 |

### 新状态流

```
pending_dev → in_dev → pending_qa → in_qa → done
                                      ↓
                                   rejected → in_dev → pending_qa → ...（DEV/QA 直接迭代）
```

**移除的状态/机制**：
- `planning` 状态 — 去掉，DEV 直接进入 `in_dev`
- Sprint Contract（plan_review / plan_confirmed 流程）— 去掉，DEV/QA 在验收阶段自然对齐

**简化理由**：Sprint Contract 的初衷是防止 DEV 理解偏差导致返工。但在 feature 级别，验收标准由 PM 写清楚即可，DEV 对着验收标准实现，QA 对着验收标准验收。如果 DEV 理解有误，QA 打回时自然会纠正。额外加一轮 plan_review 在 feature 粒度下 ROI 太低。

### 角色职责重新定义

**PM**：
- 接收用户需求，澄清不明确的部分
- 定义 feature：标题、描述、验收标准、优先级
- 验收标准必须是用户视角（"用户可以登录"），不是技术视角（"POST /api/login 返回 200"）
- 不做技术拆分，不定义实现方式
- 关键节点向用户汇报进度
- 对 DEV/QA 的陈述保持审慎，多轮确认后再向用户汇报

**DEV**：
- 领取 feature，自主决定实现方案
- 自行决定先改什么后改什么，不受外部依赖阻塞
- 实现完成后自测，一次性提交整个 feature 给 QA
- 被 QA 打回后直接修复，不需要经过 PM

**QA**：
- 验收完整 feature，不是碎片改动
- 代码审查 → 测试套件 → E2E 验证，三步都通过才算通过
- 打回时直接跟 DEV 迭代，不需要经过 PM
- 只有验收标准本身有问题时才联系 PM

---

## 三、需要改动的文件

### 3.1 角色模板（核心改动）

#### `src/templates/roles/PM.md`

**改动点**：
- 去掉"任务拆分"中的技术拆分指导（架构设计、模块划分、依赖定义等）
- task = feature，每个 task 是一个用户可感知的完整功能
- 验收标准写用户视角，不写技术视角
- 去掉"为每个任务编写验收流程"中的技术步骤模板，改为功能验收描述
- 去掉 task 间依赖关系的指导（`task_dependencies` 基本不再使用）
- 简化输出格式：去掉"实现要点"、"前置依赖"字段，只保留标题、描述、验收标准、优先级

#### `src/templates/roles/DEV.md`

**改动点**：
- 去掉 Sprint Contract 整个章节（实现计划协商、plan_review、等待 QA 确认）
- 领取任务后直接进入 `in_dev`，不经过 `planning`
- 去掉"每次只处理一个任务"的限制（feature 粒度已经足够大）
- 强调自主实现：自行决定技术方案、文件结构、实现顺序
- 完成后一次性提交整个 feature，而不是碎片提交
- 被 QA 打回后直接修复并重新提交，不需要通知 PM
- 保留自测标准，但调整为 feature 级别的验证

#### `src/templates/roles/QA.md`

**改动点**：
- 去掉 Sprint Contract 审查章节（实现计划审查）
- 验收流程不变（代码审查 → 测试 → E2E），但验收对象从技术改动变为完整 feature
- 打回后直接跟 DEV 迭代，不通知 PM（除非是验收标准本身的问题）
- 去掉 `plan_confirmed` 相关的消息类型说明

### 3.2 引擎代码改动

#### `src/workspace/sync-agents.ts`（生成的 database tool）

**改动点**：
- 移除 Sprint Contract guard（`planning → in_dev` 需要 `plan_confirmed` 的检查）
- 因为不再有 `planning` 状态，这个 guard 不再需要

具体位置：生成的 update tool 中的 Sprint Contract 检查代码块（当前约在 line 466-473 的模板字符串中）。

#### `src/engine/dependency-checker.ts`

**改动点**：
- `checkAndBlockUnmetDependencies` 保留但预期很少触发（feature 级别很少有依赖）
- 不需要移除，只是使用频率大幅降低
- 可选：如果 PM 没有定义任何依赖，跳过检查以节省开销

#### `src/db/permissions.ts`

**改动点**：
- QA 的 `status_in` 权限列表去掉 `"planning"`（不再有这个状态）
- 添加说明注释

#### `src/engine/auto-trigger.ts`

**改动点**：
- 迭代完成检测逻辑不变（所有 task done 时触发）
- 拒绝率统计不变
- 无需大改，因为 task 只是粒度变了，状态流简化了

#### `src/engine/workflow-checker.ts`

**改动点**：
- 无需大改，workflow 模板逻辑不受影响

#### `src/engine/dispatcher.ts`

**改动点**：
- `dispatchToRoleGrouped` 保留（DEV/QA 仍然按 task 分组 dispatch）
- 过滤 paused/cancelled/blocked task 的逻辑保留

### 3.3 数据库 Schema

**不需要改**。tasks 表结构足够灵活：
- `planning` 状态不再使用，但不需要从 schema 中删除（向后兼容）
- `task_dependencies` 表保留，只是很少会插入数据
- `acceptance_process` 字段保留，QA 仍然需要知道如何验证

---

## 四、DEV/QA 直接迭代机制

这是最重要的行为变化：QA 打回后不再需要经过 PM。

### 当前流程（每次打回都要走 PM）

```
QA 打回 → rejected → 消息给 DEV → DEV 修复 → pending_qa → 消息给 QA → QA 重新验收
                    ↘ 同时消息给 PM（PM 介入）
```

### 新流程（DEV/QA 直接迭代）

```
QA 打回 → rejected → 消息给 DEV（附缺陷描述） → DEV 修复 → pending_qa → 消息给 QA → QA 回归验收
（PM 不介入，除非 DEV 主动上报阻塞或 QA 上报验收标准问题）
```

**需要在模板中明确**：
- QA 打回时只发消息给 DEV，不发给 PM
- DEV 修复后只发消息给 QA，不发给 PM
- 仅在以下情况通知 PM：
  - DEV 认为需求本身有问题（不是 bug，是需求不合理）
  - QA 认为验收标准需要调整
  - DEV 遇到技术阻塞无法自行解决
  - feature 最终验收通过时（QA → PM 发验收报告）

---

## 五、迁移策略

### 对已有项目的影响

1. **已存在的细粒度 tasks**：不做自动迁移。已有 task 继续按旧流程走完。新 task 按新流程
2. **`planning` 状态的 task**：如果存在，需要手动推进到 `in_dev` 或由 PM 重新评估
3. **Sprint Contract guard**：移除后，旧 task 也不再需要 `plan_confirmed`

### 部署步骤

1. 更新三个角色模板（`src/templates/roles/*.md`）
2. 更新 `sync-agents.ts` 移除 Sprint Contract guard
3. 更新 `permissions.ts` 移除 `planning` 状态
4. 重新 build
5. 对已有项目：删除 `.win-agent/roles/*.md` 让引擎重新复制模板，或手动编辑
6. 重启引擎

### 风险评估

| 风险 | 影响 | 缓解 |
|------|------|------|
| DEV 实现方向偏离 | feature 级别偏离代价比 task 级别更大 | PM 验收标准写清楚；QA 第一时间打回；DEV 不确定时主动问 PM |
| QA/DEV 无限迭代 | 反复打回消耗 token | auto-trigger 的拒绝率监控仍然生效，超过 30% 自动通知 PM 介入 |
| PM 失去可见性 | 不知道 DEV/QA 在迭代什么 | QA 验收通过时通知 PM；PM 可随时查询 task 状态和 task_events |

---

## 六、实施优先级

**Phase 1**（核心流程变更）：
1. 重写 PM.md — 去掉技术拆分，task = feature
2. 重写 DEV.md — 去掉 Sprint Contract，自主实现
3. 重写 QA.md — 去掉 plan review，打回直接跟 DEV 迭代
4. 移除 Sprint Contract guard（sync-agents.ts）

**Phase 2**（清理和对齐）：
5. 更新 permissions.ts（去掉 planning 状态）
6. 更新 fix-round-2.md（#11 Sprint Contract 可绕过的问题不再存在）
7. 清理 DEV.md 中对 `planning` 状态的引用

**Phase 3**（可选优化）：
8. 依赖检查器优化：无依赖时跳过检查
9. 考虑 DEV 并行：feature 级别的 task 更独立，更适合并行开发
10. 考虑 QA 批量回归：同一 feature 的多次打回合并验证
