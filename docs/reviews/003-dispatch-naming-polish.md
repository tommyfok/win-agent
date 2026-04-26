# Dispatch 路径命名 Polish

> 背景：`plans/004` 闭环后 `DispatchIntent` 抽象已删除，相关变量/函数名仍带历史术语 "intent"。本计划只改名，不改行为。

## 改动清单

### 1. `src/engine/message-scheduler.ts`

函数 `detectMessageDispatchIntents` → `findRolesReadyForDispatch`。

返回值已经是 `Role[]`，名字里的 "Intents" 不再贴合。

### 2. `src/engine/scheduler.ts`

调用点同步改名：

```ts
// before
const dispatchIntents = detectMessageDispatchIntents(states);
await tryDispatchNormalRole(..., states, dispatchIntents);

// after
const rolesReadyForDispatch = findRolesReadyForDispatch(states);
await tryDispatchNormalRole(..., states, rolesReadyForDispatch);
```

### 3. `src/engine/scheduler-dispatch.ts`

- `tryDispatchNormalRole` 第 6 个参数 `rolesWithUnreadMessages?: Role[]` → `candidateRoles?: Role[]`。该函数本身不关心"为什么这些 role 是候选"。
- `orderRolesForDispatch` 函数体内 `rolesWithUnreadMessages` 局部变量 → `candidateRoles`。
- `tryDispatchNormalRole` 函数体内 `intentRoles` 局部变量 → `orderedRoles`。

### 4. 测试

`src/engine/__tests__/scheduler-dispatch.test.ts` 和 `src/engine/__tests__/message-scheduler.test.ts` 中函数引用跟着改即可。当前传参形式（`[Role.PM, Role.DEV]`）不变。

## 验收

- `pnpm tsc --noEmit` 无报错
- `pnpm vitest run src/engine/__tests__/` 全过
- 全仓库 `rg "DispatchIntent|detectMessageDispatchIntents|intentRoles|rolesWithUnreadMessages"` 无残留

## 不在范围内

- `IdleNudger` / `SessionWatchdog` / `SchedulerMaintenance` 不改。
- 行为、节流、阈值常量不改。
