# Fix Round 2 — Win-Agent 全链路审计问题清单

## 一、严重逻辑错误 (Critical/High)

### 3. context 上限取错 — memory-rotator.ts:44-60

**位置**: `src/engine/memory-rotator.ts:44-60`

```ts
if (typeof ctx === "number" && ctx > maxCtx) {
  maxCtx = ctx;
}
```

**问题**: `detectModelContextLimit` 遍历 provider 列表中所有模型，取最大的 context window 作为阈值。若列表中有 1M token 模型而实际使用 200K 模型，rotation 阈值按 1M 计算（80% = 800K），实际 200K 的模型早已超限也不会触发 rotation，导致 context 溢出、输出质量下降。

**修复方向**: 从 config 中读取当前活跃模型名，只取该模型的 context limit。

---

### 6. PM 迭代回顾使用幽灵状态 — PM.md:170

**位置**: `src/templates/roles/PM.md:170`

```markdown
database_update({ table: "iterations", where: { id: <迭代ID> }, data: { status: "reviewed" } })
```

**问题**: PM 被指示将迭代状态设为 `"reviewed"`，但引擎中没有任何逻辑检查此状态。`auto-trigger.ts` 只认 `"active"` 和 `"completed"`，`workflow-checker.ts` 检查的是 `wf.phase === "done"` 而非迭代状态。这是一个无效操作，PM 执行后不会产生任何引擎行为。

**修复方向**: 要么让引擎识别 `"reviewed"` 状态并据此推进流程，要么修改 PM prompt 使用引擎实际识别的状态值。

---

## 二、中等问题 (Medium)

### 7. session 泄漏 — session-manager.ts:204

**位置**: `src/engine/session-manager.ts:204-207`

```ts
releaseTaskSession(taskId: number): void {
  this.taskSessions.delete(`${taskId}-DEV`);
  this.taskSessions.delete(`${taskId}-QA`);
}
```

**问题**: 任务完成后只从内存 map 中删除 session 引用，不调用 opencode API 删除 server 端的 session。同样，`rotateSession` 创建新 session 后也不删除旧 session。长时间运行会在 opencode server 上积累大量孤儿 session，消耗内存。

**修复方向**: release 和 rotate 时调用 `client.session.delete({ path: { id: oldSessionId } })`。

---

### 8. session bind 竞态 — session-manager.ts:368

**位置**: `src/engine/session-manager.ts:368-385`

**问题**: `createRoleSession` 使用 `promptAsync` 发送 bind prompt（角色定义 + 记忆注入），`await` 只等 HTTP 请求被接受，不等 LLM 完成处理。`boundSessions.add(sessionId)` 立即执行。若 `waitForSessionsReady` 超时（PM 启动时）或 task session 无 wait 机制，后续 `session.prompt` 可能与 bind prompt 的 LLM 响应并发，导致 session 内两个 turn 同时进行。

**修复方向**: 在首次 dispatch 前确认 bind prompt 已完成（轮询 session 直到有 assistant 响应），或使用同步 `prompt` 替代 `promptAsync`。

---

### 9. workflow 同 tick 双跳 — workflow-checker.ts:18-22

**位置**: `src/engine/workflow-checker.ts:18-22`

```ts
for (const wf of activeWorkflows) {
  checkPhaseAdvancement(wf);   // 可能将 wf.phase 改为 "done"
  const completed = checkCompletion(wf);   // 立即看到 phase === "done"，标记 completed
```

**问题**: `checkPhaseAdvancement` 在内存中将 phase 改为 `"done"` 后，紧接着 `checkCompletion` 看到 done 就标记 workflow 为 completed — 一个 tick 内 workflow 从 review 直接跳到 completed。PM 收到完成通知时 workflow 已关闭，无法再对回顾结果采取行动。

**修复方向**: phase advancement 和 completion check 应在不同 tick 执行，或 completion 只在下一次 tick 检查。

---

### 10. 拒绝率统计定义不一致 — auto-trigger.ts:167 vs :256

**位置**: `src/engine/auto-trigger.ts:167-173` vs `auto-trigger.ts:256-264`

**问题**:
- Trigger 用 `SELECT SUM(CASE WHEN status = 'rejected' ...) FROM tasks` — 只计当前状态为 rejected 的任务（修复后变 done 就不算了）
- Stats 报告用 `task_events` 表统计历史拒绝次数

两处定义不同，trigger 阈值和报告数据矛盾。一个任务被拒 3 次最终通过，trigger 计数为 0 但报告计数为 3。

**修复方向**: trigger 也使用 `task_events` 统计历史拒绝次数。

---

### 11. Sprint Contract 可绕过 — QA.md:67-79

**位置**: `src/templates/roles/QA.md:67-79`

**问题**: QA "确认计划" 和 "需要补充" 两种响应都使用 `type: "plan_confirmed"`。DB tool 的 Sprint Contract guard 只检查是否存在 `from_role='QA' AND type='plan_confirmed'` 的消息就放行 `planning→in_dev` 转换。即使 QA 说"需要补充"，DEV 也能立即进入开发阶段。

**修复方向**: 引入 `type: "plan_needs_revision"` 区分两种情况，guard 只认 `plan_confirmed` 不认 `plan_needs_revision`。

---

### 12. PID 文件竞态 — start.ts:46,142

**位置**: `src/cli/start.ts:46,142`

```ts
writePidFile();           // 写入 CLI 进程的 PID
// ... spawn 子进程 ...
writePidFile(workspace, child.pid);  // 覆写为 daemon PID
```

**问题**: 两次写入之间有窗口期，`status` 命令可能读到 CLI 进程的 PID（即将退出），误判为 engine 正在运行，然后 PID 失效被自动清理，造成状态混乱。

**修复方向**: 不要在 spawn 前写 PID 文件，只在 daemon 进程内写一次。

---

### 13. clean 命令不完整 — clean.ts

**位置**: `src/cli/clean.ts`, `src/index.ts:47`

```ts
// index.ts
.description("Clean .win-agent and .opencode from current directory")
```

**问题**: 描述说清理 `.win-agent` 和 `.opencode`，但代码只删除 `.win-agent/`。残留的 `.opencode/tools/database.ts` 包含已删除 DB 的硬编码绝对路径，`.opencode/agents/` 包含过期的角色配置。

**修复方向**: 同时清理 `.opencode/agents/` 和 `.opencode/tools/`，或至少清理 win-agent 生成的文件。

---

### 14. CLI 与 daemon 状态竞态 — task.ts, cancel.ts

**位置**: `src/cli/task.ts`, `src/cli/cancel.ts`

**问题**: CLI 命令（`task pause`、`task cancel` 等）直接写 DB 修改任务状态。若 daemon 正在为同一任务进行 in-flight LLM 调用，LLM 完成后通过 database tool 更新状态，会覆盖用户的 pause/cancel 操作。

**修复方向**: 
- 方案 A: CLI 不直接写 DB，而是通过 messages 表发消息给 PM
- 方案 B: database tool 的 update 逻辑检查状态变更的合法性（不允许从 paused/cancelled 转到其他状态，除非是 resume）

---

### 15. DEV 单任务指令与 scheduler 多消息派发矛盾 — DEV.md:19 vs scheduler.ts

**位置**: `src/templates/roles/DEV.md:19`, `src/engine/scheduler.ts:167-169`

**问题**: DEV prompt 说"每次只处理一个任务，完成后再领取下一个"，但 scheduler 查询 DEV 的所有未读消息（可能来自多个任务）并一次性 dispatch。DEV 收到多个任务指令时无明确优先级指导。

**修复方向**: 与 #1 一并修复 — scheduler 按 task 分组，每次只 dispatch 一个 task 的消息。

---

### 16. PM 修改角色文件不立即生效 — PM.md:110

**位置**: `src/templates/roles/PM.md:110`

```markdown
改写每个角色的 `.win-agent/roles/*.md` 文件，将用户偏好融入角色行为准则中
```

**问题**: PM 可以修改角色 prompt 文件，但修改后不会影响已有的 session。`syncAgents()` 只在 engine 启动或 onboarding 完成后触发一次，且只是把文件同步到 `.opencode/agents/`，不会重新 bind 已有 session。PM 不知道改动需要 engine 重启才能生效。

**修复方向**: 在 PM prompt 中说明生效条件，或在 scheduler 中检测 role 文件变更后自动 re-sync + rotate session。

---

## 三、低风险问题 (Low)

### 17. repository.ts SQL 拼接无白名单校验

**位置**: `src/db/repository.ts:16,57,94,116`

table 名、column 名、orderBy 参数直接字符串插值进 SQL。虽然通过 database tool 调用时有 zod 校验，但引擎内部直接调用 `select()`/`insert()` 等函数时无任何校验。

**修复方向**: 在 repository 层加 `KNOWN_TABLES` 白名单校验。

---

### 18. embeddingDimension 全局可变量无调用顺序保证

**位置**: `src/db/schema.ts:154-175`

`setEmbeddingDimension()` 必须在 `createAllTables()` 之前调用，否则向量表维度默认 512。当前代码正确调用了，但没有强制机制防止未来的调用顺序错误。

**修复方向**: 将 `dim` 作为 `createAllTables()` 的必传参数。

---

### 19. embedding 失败导致知识/记忆孤儿行

**位置**: `src/embedding/knowledge.ts:18-38`, `src/embedding/memory.ts:31-49`

知识/记忆行先插入主表，再生成 embedding 插入向量表。若 embedding 失败（网络错误等），主表行存在但向量表无对应行，语义搜索永远找不到该条目，且无重试机制。

**修复方向**: 用事务包裹插入，或增加孤儿检测 + 重试逻辑。

---

### 20. memory 清理非原子操作

**位置**: `src/embedding/memory.ts:177-184`

`cleanExpiredMemories` 先删 `memory_vec` 再删 `memory`，未用事务。中间 crash 会导致不一致。

**修复方向**: `db.transaction(() => { ... })()`。

---

### 21. API key 文件权限过宽

**位置**: `src/config/index.ts:64`

`writeFileSync` 写 `~/.win-agent/providers.json` 时使用默认 umask（通常 0o644 世界可读），API key 暴露给同机其他用户。

**修复方向**: `fs.writeFileSync(path, data, { mode: 0o600 })`。

---

### 22. memory recall 30-90 天阈值未实现

**位置**: `src/embedding/memory.ts:133-141`

注释说 30-90 天记忆需要更高相关度才召回，但代码中 7-90 天统一使用同一阈值 0.3。

**修复方向**: 增加第二级阈值判断。

---

### 23. QA 无 task_events insert 权限

**位置**: `src/db/permissions.ts:74`

QA 更新任务状态时，database tool 自动插入 `task_events` 审计记录，但 QA 无该表 insert 权限，插入被 try/catch 静默吞掉。QA 的状态变更不会被审计。

**修复方向**: 给 QA 添加 `task_events` 的 insert 权限。

---

### 24. PM 连续计数器在 user-priority 分支不重置

**位置**: `src/engine/scheduler.ts:131`

user 消息优先分支中 `pmConsecutiveCount++` 但不重置。持续的用户消息会累积计数器，最终导致正常循环中 PM 消息被不公正地跳过（饥饿保护误触发）。

**修复方向**: user-priority 分支 dispatch 完成后 `pmConsecutiveCount = 0`。

---

### 25. SIGTERM handler 注册过晚

**位置**: `src/cli/engine.ts:154`

signal handler 在 `startOpencodeServer` 和 `initPersistentSessions` 之后才注册。启动阶段收到 SIGTERM 无法优雅退出（不会清理 PID 文件、不会保存记忆）。

**修复方向**: 在 `engineCommand` 入口处立即注册 signal handler。

---

### 26. SQL 模板字符串插值

**位置**: `src/engine/auto-trigger.ts:284-291`

```ts
WHERE context LIKE '%"iteration_id":${iterationId}%'
```

`iterationId` 是 number 类型，不构成注入风险，但与项目其他地方的参数化查询风格不一致，属于维护隐患。

**修复方向**: 使用 `?` 参数化。

---

### 27. boundSessions 死代码

**位置**: `src/engine/session-manager.ts`

`boundSessions: Set<string>` 只有 `add()` 操作，从未被读取。

**修复方向**: 移除或补全其用途。

---

### 28. PM.md 迭代回顾步骤编号错误

**位置**: `src/templates/roles/PM.md:144-175`

步骤编号 1-5 后重新从 2 开始，LLM 可能重复执行或混淆顺序。

**修复方向**: 修正为连续编号 1-7。

---

### 29. loadConfig 不处理损坏的 JSON

**位置**: `src/config/index.ts:92-94`

`loadConfig()` 直接 `JSON.parse` 无 try/catch（不像 `loadPresets` 有保护），损坏的 `config.json` 会导致引擎启动崩溃。

**修复方向**: 加 try/catch，返回默认配置或抛出明确错误信息。

---

### 30. dispatcher 空消息返回空 sessionId

**位置**: `src/engine/dispatcher.ts:76-78`

所有消息被过滤后返回 `{ sessionId: "", inputTokens: 0, outputTokens: 0 }`，调用方将空字符串传给 `checkAndRotate`。虽然当前不会触发 rotation，但空字符串作为 sentinel 值很脆弱。

**修复方向**: 返回 `null` 并在调用方判断跳过 rotation。

---

### 31. DEV/QA prompt 未说明 DB tool 可能返回错误

**位置**: `src/templates/roles/DEV.md:84`, `src/templates/roles/QA.md:115`

当 `database_update` 因权限、Sprint Contract guard 等原因失败时返回 `{ "error": "..." }`，但角色 prompt 中无任何关于错误处理的指导。Agent 收到错误后行为不可预测。

**修复方向**: 在 DEV/QA prompt 中增加"检查 DB tool 返回值，如遇错误则..."的指导。

---

### 32. QA prompt 未处理 cancelled/blocked 状态

**位置**: `src/templates/roles/QA.md:21`

QA prompt 只提到 `paused` 时暂停工作，未提及 `cancelled` 或 `blocked`。若验收中任务被取消，QA 的 in-flight 响应完成后仍会尝试更新任务状态。

**修复方向**: 在 QA prompt 中增加对 `cancelled`/`blocked` 的处理指导。

---

## 修复优先级建议

**P1 — 尽快修复**（影响稳定性和数据一致性）:
1. #3 context 上限取错
2. #7 session 泄漏
3. #11 Sprint Contract 可绕过
4. #14 CLI/daemon 状态竞态

**P2 — 计划修复**（影响体验和可维护性）:
5. #6, #9, #10, #12, #13, #15, #16 及其余低风险问题
