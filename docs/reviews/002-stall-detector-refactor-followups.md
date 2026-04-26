# StallDetector 拆分重构 Follow-ups

> 上一份评审：`plans/003-stall-detector-refactor-review.md`
>
> 上一份评审中标为"必须合并前修"的两项（3.1 / 3.2）以及大部分"可下个 PR"的项已闭环，详见 §1。本文记录剩余可改进项。

## 1. 上一份评审闭环情况

| 评审项 | 状态 | 实现要点 |
| --- | --- | --- |
| 3.1 `pending_work` intent 死代码 | ✅ | `DispatchIntent.reason` 收窄为字面量 `'unread_messages'`；`scheduler-dispatch.ts` 删除 `INTENT_PRIORITY`，`orderRolesForDispatch` 简化为单层 dedup + rotate |
| 3.2 测试缺口 | ✅ | 新增 `idle-nudger.test.ts` (10 cases) 和 `session-watchdog.test.ts` (5 cases)，全过 |
| 3.3 删除 `pm-idle-monitor.ts` | ✅ | 文件 + 测试一并删除 |
| 3.4 `SessionWatchdog` 类型缩窄 | ✅ | `detectStuckSessions` 直接返回 `StuckSession[]`，不再借用 `DispatchIntent` |
| 3.5 删除 `IdleNudger.CHECK_INTERVAL_MS` | ✅ | `lastCheckAt` / `CHECK_INTERVAL_MS` 已删除，cadence 完全交给外层 `SchedulerMaintenance` |
| 3.6 注释依赖检查频率变化 | ✅ | `scheduler-maintenance.ts:12-15` 加了 JSDoc |
| 3.7 SQL 合并查询 | — | 当时定义为"不必"，无需处理 |

## 2. 剩余 Follow-up 项

按重要性从高到低，全部为可选优化，不阻断任何已合并功能。

### 2.1 `DispatchIntent` 已退化为 `Role[]`，可考虑彻底删除该抽象

**现状**：

```ts
// dispatch-intent.ts
export interface DispatchIntent {
  role: Role;
  reason: 'unread_messages';
}
```

`reason` 是单字面量，没有信息量。`scheduler-dispatch.ts` 的 `orderRolesForDispatch` 也只用 `role`：

```ts
const rolesWithUnreadMessages = [...new Set(intents.map((i) => i.role))];
```

**建议**：

- **方案 A（推荐）**：让 `detectMessageDispatchIntents` 直接返回 `Role[]`，`tryDispatchNormalRole` / `orderRolesForDispatch` 也收 `Role[]`，删除 `dispatch-intent.ts` 整个文件。当前唯一的"reason 字段"实质是常量，去掉更诚实。
- **方案 B**：保留 `DispatchIntent` 作为扩展点，在文件头注释里说清"目前只有一种 reason，是有意保留的扩展位"。

如果未来确认不再有第二种 reason，A 更干净。

### 2.2 `idle-nudger.test.ts` 的依赖 mock 方式不一致且风格脆弱

**现状** (`__tests__/idle-nudger.test.ts:7,18-20,47-51`)：

```ts
import * as schedulerDispatch from '../scheduler-dispatch.js';
mockGetDevLastDispatchEnd = vi.spyOn(schedulerDispatch, 'getDevLastDispatchEnd');
// ...
function createNudger(devLastDispatchEnd = 0) {
  schedulerDispatch.setPmLastDispatchEnd(baseTime - 11 * 60 * 1000);   // 真改模块状态
  mockGetDevLastDispatchEnd.mockReturnValue(devLastDispatchEnd);       // spy 返回值
  return new IdleNudger();
}
```

**问题**：

1. PM 走"改模块状态" / DEV 走"spy 返回值"——两种风格并存，不对称。
2. `vi.spyOn` patch ESM namespace 在 vitest 默认配置下能工作，但属于实现细节依赖。生产代码里 `idle-nudger.ts` 是 `import { getDevLastDispatchEnd } from './scheduler-dispatch.js'`，spy 是否生效取决于 vitest/Node 当前对 ESM live binding 的处理方式，未来升级可能踩坑。
3. 测试隐式共享了 `scheduler-dispatch` 的全局状态（`pmLastDispatchEnd` 是模块级变量），不同测试之间需要靠顺序保证隔离。

**建议**：把时间依赖通过构造函数注入到 `IdleNudger`：

```ts
export interface IdleNudgerDeps {
  getPmLastDispatchEnd: () => number;
  getDevLastDispatchEnd: () => number;
}

export class IdleNudger {
  constructor(private deps: IdleNudgerDeps = defaultDeps) {}
  // ...
}
```

测试就能直接传桩值，不依赖 vitest spy 行为，也不再写 module 状态。生产代码在 `SchedulerMaintenance` 里组装时把真实 getter 注进去即可。

`SessionWatchdog` 已经是这种风格（`client` 通过参数传入），保持一致更好。

### 2.3 `session-watchdog.test.ts` 超时用例的边界条件

**现状** (`__tests__/session-watchdog.test.ts:113-115`)：

```ts
const pending = watchdog.detectStuckSessions(states(), client as never);
await vi.advanceTimersByTimeAsync(5_000);
await expect(pending).resolves.toEqual([]);
```

`STUCK_CHECK_TIMEOUT_MS = 5_000`，`advanceTimersByTimeAsync(5_000)` 推进刚好等于阈值，依赖 `setTimeout` 在端点触发。当前实测通过，但属于边界条件。

**建议**：改成 `advanceTimersByTimeAsync(5_001)` 或 `6_000`，远离边界。

### 2.4 `idle-nudger.test.ts` 中数字 `21` 缺注释

**现状** (`__tests__/idle-nudger.test.ts:157-171`)：

```ts
nudger.detect(states(false, false));
mockNow.mockReturnValue(baseTime + 10 * 60 * 1000);
nudger.detect(states(false, false));
// ...
expect(msgs[1].content).toContain('21');
```

`21` = 初始空闲 11 分钟 + 时间推进 10 分钟。读代码需要心算。

**建议**：加注释 `// 11min initial idle + 10min advance = 21min reported`，或抽常量。

### 2.5 `orderRolesForDispatch` 微简化

**现状** (`scheduler-dispatch.ts:138-148`)：

```ts
function orderRolesForDispatch(intents?: DispatchIntent[]): Role[] {
  if (!intents || intents.length === 0) {
    return rotateRolesAfterLastDispatched([...AGENT_ROLES]);
  }

  const ordered: Role[] = [];
  const rolesWithUnreadMessages = [...new Set(intents.map((i) => i.role))];
  ordered.push(...rotateRolesAfterLastDispatched(rolesWithUnreadMessages));

  return ordered;
}
```

`ordered` 数组冗余。

**建议**：

```ts
const rolesWithUnread = [...new Set(intents.map((i) => i.role))];
return rotateRolesAfterLastDispatched(rolesWithUnread);
```

如果同时采纳 2.1 方案 A，签名也可以变成 `orderRolesForDispatch(roles?: Role[]): Role[]`。

## 3. 建议处理顺序

1. **2.1（合并相关）+ 2.5**：一起做，一个 PR 完成"删除 `DispatchIntent` 抽象"。简化幅度最大。
2. **2.2**：构造函数注入 `IdleNudger` 时间依赖。提升测试稳定性。
3. **2.3 / 2.4**：测试 polish，可顺带也可单独。

全部完成预期净 LOC 变化：约 -30 行（主要来自删除 `dispatch-intent.ts` 和简化 `orderRolesForDispatch`）。

## 4. 不建议处理的项

- 把 `SchedulerMaintenance` 改成插件式注册机制：当前只有 3 个维护项（依赖解锁 / idle 提醒 / stuck 检测），过度抽象的成本高于收益。等真要加第 4、第 5 项时再说。
- `MAINTENANCE_INTERVAL_MS` 配置化：当前 30s 是合理 default，配置项会增加心智负担，等出现实际场景再加。
