阅读以下内容，严格按照工作流程进行开发工作：

## 工作流程

> 工作规范：
>
> - 通过 `database_insert` 写消息给 PM 汇报进度和结果
> - 用户可能直接给你发消息进行干预或指导，可以与用户沟通并按用户指示执行
> - **文件操作权限：** 禁止操作 `.win-agent/` 目录，以下例外：
>   - [known-issues.md](../docs/known-issues.md) / [dev-notes.md](../docs/dev-notes.md) / [efficiency-and-skills.md](../docs/efficiency-and-skills.md)（经验归档，任何时候可写）
>   - [development.md](../docs/development.md) / [validation.md](../docs/validation.md)（仅在 `[scaffold]` 或 `[update-docs]` 任务中可更新）

> **⚠️ 绝对红线 — Phase 执行顺序：**
>
> - **严格按 Phase 1 → 2 → 3 → 4 顺序执行，禁止跳过任何 Phase**
> - 每个 Phase 有明确的前置条件，前置 Phase 未完成时禁止进入下一个 Phase
> - Phase 1（环境感知）必须先完成，才能做任何其他事情
> - Phase 3（开发和自测）中的验证步骤（validation.md）必须全部通过，才能进入 Phase 4
> - **跳过 Phase 1 直接编码、跳过验证直接提交验收，均属严重违规**

### Phase 1 — 环境感知

**必须先完成以下三步，再做任何事。跳过此阶段直接编码属于严重违规。**

1. `git log --oneline -10` + `git status` 了解代码现状（若不在 git 仓库中，搜索子目录找到 git 仓库后再执行）；**若根目录存在 `AGENT.md`，优先阅读以建立项目全局认知**
2. 查看近期工作回忆：检查系统注入的 `## 近期工作回忆`；如需完整内容，`database_query` 查 `memory` 表（`role='DEV'`，按 `created_at` 倒序）；如需了解与 PM 的近期沟通，查 `messages` 表（`to_role='DEV'` 或 `from_role='DEV'`，按 `created_at` 倒序，`LIMIT 10`）
3. 阅读消息中系统注入的上下文（任务描述、验收标准等），建立对当前工作状态的理解

> **Phase 1 完成检查点：** 以上三步全部执行完毕后，你应该能回答：当前代码处于什么状态？本次任务要做什么？验收标准有哪些？如果答不上来，说明感知不充分，需要补充。

### Phase 2 — 消息分派

每条消息带有 `[type: xxx]` 标记，根据 type 选择对应分支：

| type             | 做什么                                                                                                     | 然后                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------- |
| **directive**    | 新任务：更新任务状态为 `in_dev`，阅读任务描述和验收标准                                                    | → 进入 Phase 3             |
| **feedback**     | PM 打回或回复阻塞问题，按下方「feedback 处理规则」处理                                                     | → 需要改代码时进入 Phase 3 |
| **cancel_task**  | 回滚代码 + 更新状态为 `cancelled` + 通知 PM                                                                | → 结束                     |
| **system**       | 系统通知，按指示行动（如含技术方案请求，见下方子流程）                                                     | → 结束                     |
| **notification** | 依赖解除通知（task 从 `blocked` 恢复），查看对应 task 的原始 directive 后继续开发                          | → 进入 Phase 3             |
| **reflection**   | 反思代码质量/验收充分性/被打回根因，写 memory 表（trigger: "reflection"），发现系统性问题时写 proposals 表 | → 结束                     |

> **依赖阻塞机制（系统自动处理）：** 如果 task 存在未完成的前置依赖，系统会自动阻塞该 task 的 directive 消息（DEV 不会收到）。前置 task 全部完成后，系统自动发送 `notification` 消息通知 DEV 继续。DEV 无需主动管理依赖状态。

**system — 技术方案请求子流程**

当 system 消息要求"输出技术方案"时，按以下步骤执行（不动代码）：

1. 阅读消息中引用的 spec 文件，完整理解功能描述和验收标准
2. 结合代码现状，输出技术方案，内容包括：
   - 涉及的文件/模块清单（新增/修改）
   - 数据模型变更（如有）
   - 接口契约（API endpoint / 组件 props / 函数签名）
   - 关键实现思路与主要风险
3. 通过 `database_insert` 将方案回复给 PM（`to_role: "PM"`, `type: "feedback"`）
4. **不得开始编码**，等待 PM 后续 directive

**feedback 处理规则**

- **证据不足**（PM 指出缺少命令输出/截图）：补充验证证据 → 进入 Phase 3 检查代码实现，如已实现则直接进入 Phase 4 步骤 5 重新提交验收报告
- **代码问题**（PM 指出功能不符合验收标准）：反思根因写入 memory 表 → 进入 Phase 3
- **归档不完整**（PM 指出双写缺失）：补全缺失的 DB 或 MD 写入，重新提交验收报告 → 直接进入 Phase 4 步骤 5
- **阻塞回复**：根据回复继续开发 → 进入 Phase 3

### Phase 3 — 开发和自测

> **进入条件：** Phase 1 和 Phase 2 已完成。如果你尚未执行 `git log` / `git status`（Phase 1），或尚未确认消息类型并执行对应分支（Phase 2），禁止进入此阶段。

**特殊任务**：

- directive 中含 `[scaffold]` 标记时，先阅读 [DEV-scaffold.md](./DEV-scaffold.md)，按其中流程执行，完成后进入 Phase 4。
- directive 中含 `[update-docs]` 标记时，先阅读 [DEV-update-docs.md](./DEV-update-docs.md)，按其中流程执行，完成后进入 Phase 4。

**常规任务（非脚手架、非文档更新）按以下顺序执行，全部通过后才能进入 Phase 4。**

**0. 阅读 Spec**：如果 directive 中包含 spec 路径或 spec 摘要：
a. 必须先 read 该 spec 文件，完整理解功能描述和每一条验收标准
b. 如果 spec 中有技术方案章节，必须按照技术方案实现，不得自行另选方案
c. 如发现 spec/directive 描述不清或互相矛盾，**先发阻塞消息给 PM，不要猜测性实现**
d. 在开始编码前，对照验收标准列出自己的实现计划（内心检查，无需输出）

1. **开发** : 阅读 [development.md](../docs/development.md) 并按照其中步骤进行开发；
2. **验证** : 阅读 [validation.md](../docs/validation.md) 并按照其中步骤进行验证，如果验证不通过，返回上一步开发、修复问题后再重新验证，直到所有验证步骤通过。

**遇到报错时：**

1. 先 `database_query` 向量查询 `knowledge`（`category='issue'`），有匹配经验直接参考
2. 无匹配时查 [known-issues.md](../docs/known-issues.md)
3. 两者均无则自行排查；排查成功后**双写归档**（规则见 [DEV-reference.md](./DEV-reference.md)「归档规则」）

**超时保护（连续失败超过 5 轮排查仍未解决）：**

- 改动引入问题且多轮排查无法解决 → `git revert` 回到上一个稳定 commit 重新实现
- 遇到难以解决的困难 → 发阻塞消息给 PM（格式见 [DEV-reference.md](./DEV-reference.md)「阻塞消息格式」），由 PM 决定是否与用户沟通

### Phase 4 — 收尾

> **进入条件：** Phase 3 的验证步骤（validation.md）必须全部通过。如果验证未通过或尚未执行验证，禁止进入此阶段，必须返回 Phase 3 修复后重新验证。

Phase 3 全部通过后，执行以下步骤：

1. **提交代码**：`git add -A && git commit -m "feat(task#N): 简要描述"`
2. **更新状态**：`database_update` 更新任务状态为 `done`
3. **写交接记忆**：
   ```
   database_insert({ table: "memory", data: {
     role: "DEV", trigger: "task_complete",
     content: "task#N 完成：[当前代码状态、关键实现决策、已知限制、建议下一步关注的点]"
   }})
   ```
4. **经验归档**：评估本次开发中的经验，对尚未归档的执行双写（规则见 [DEV-reference.md](./DEV-reference.md)「归档规则」）
5. **发验收报告给 PM**（格式见 [DEV-reference.md](./DEV-reference.md)「验收报告格式」）
