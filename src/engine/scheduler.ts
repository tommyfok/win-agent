import type { OpencodeClient } from "@opencode-ai/sdk";
import type { SessionManager } from "./session-manager.js";
import { RoleManager, ALL_ROLES } from "./role-manager.js";
import { dispatchToRole, dispatchToRoleGrouped, type MessageRow } from "./dispatcher.js";
import { AbortError } from "./retry.js";
import { checkAndRotate } from "./memory-rotator.js";
import { checkAutoTriggers, resetTriggers } from "./auto-trigger.js";
import { checkWorkflowCompletion } from "./workflow-checker.js";
import { select, insert, update, rawRun } from "../db/repository.js";
import { MessageStatus } from "../db/types.js";
import { checkAndUnblockDependencies } from "./dependency-checker.js";
/** Sleep helper */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Engine running flag — set to false to stop the main loop */
let running = false;

// ── Dispatch interrupt support ──

/** Context of a currently active dispatch (for interrupt & resume) */
export interface DispatchContext {
  role: string;
  taskId: number | null;
  sessionId: string | null;
  startedAt: string;
}

/** Current in-flight dispatch state */
let currentDispatch: DispatchContext | null = null;
let currentAbortController: AbortController | null = null;
/** Stored opencode client ref for session.abort */
let storedClient: OpencodeClient | null = null;

/**
 * Get the context of the currently in-flight dispatch, if any.
 */
export function getCurrentDispatchContext(): DispatchContext | null {
  return currentDispatch;
}

/**
 * Abort the currently in-flight dispatch and return its context.
 * Also calls session.abort on the opencode server to stop LLM processing.
 * Returns the dispatch context (for persisting interrupted state), or null if idle.
 */
export async function abortCurrentDispatch(): Promise<DispatchContext | null> {
  const ctx = currentDispatch;
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  // Tell opencode server to stop the in-flight LLM call
  if (ctx?.sessionId && storedClient) {
    try {
      await storedClient.session.abort({ path: { id: ctx.sessionId } });
    } catch {
      // Session may already be idle — non-fatal
    }
  }
  return ctx;
}

/**
 * PM cooldown: after PM finishes a dispatch, wait this many ms before
 * dispatching role messages to PM again. This gives user messages
 * (arriving via opencode web UI) priority over queued role messages.
 */
const PM_COOLDOWN_MS = 3000;
let pmLastDispatchEnd = 0;

/**
 * PM starvation protection: after N consecutive PM-only dispatches,
 * skip PM for one tick to let DEV get scheduled.
 */
const PM_MAX_CONSECUTIVE = 3;
let pmConsecutiveCount = 0;

/**
 * Start the scheduler main loop.
 *
 * V1 serial strategy:
 * - Each cycle iterates through ALL_ROLES
 * - PM has priority (checked first)
 * - Only one role is dispatched per cycle
 * - After dispatch, check auto-triggers and workflow completion
 * - Sleep 1s between cycles to avoid tight polling
 */
export async function startSchedulerLoop(
  client: OpencodeClient,
  sessionManager: SessionManager
): Promise<void> {
  running = true;
  storedClient = client;
  pmConsecutiveCount = 0;
  resetTriggers();
  const roleManager = new RoleManager();

  console.log("   🔄 调度器主循环已启动");

  while (running) {
    try {
      await schedulerTick(client, sessionManager, roleManager);
    } catch (err) {
      // AbortError means graceful shutdown — exit loop silently
      if (err instanceof AbortError) {
        console.log(`   ⏹ 调度被中断: ${err.message}`);
        break;
      }
      console.error(`   ❌ 调度器异常: ${err}`);
      // Log to database for diagnostics
      try {
        insert("logs", {
          role: "system",
          action: "scheduler_error",
          content: `调度器异常: ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch {
        // DB write failed too — nothing more we can do
      }
      // Continue running — one bad tick shouldn't kill the engine
    }

    if (!running) break;
    await sleep(1000);
  }

  console.log("   🛑 调度器主循环已停止");
}

/**
 * Stop the scheduler loop gracefully.
 */
export function stopSchedulerLoop(): void {
  running = false;
}

/**
 * Single tick of the scheduler.
 *
 * 1. Check blocked tasks for dependency resolution (auto-unblock)
 * 2. Priority: user messages → PM first (skip cooldown)
 * 3. Iterate roles (PM first), find one with unread messages
 * 4. Dispatch messages to that role
 * 5. Check session rotation
 * 6. Check auto-triggers and workflow completion
 */
async function schedulerTick(
  client: OpencodeClient,
  sessionManager: SessionManager,
  roleManager: RoleManager
): Promise<void> {
  // 0. Auto-unblock tasks whose dependencies are now satisfied
  checkAndUnblockDependencies();

  // 0.5 Promote deferred trigger messages when PM is idle and has no pending unread messages.
  // This ensures auto-trigger messages are dispatched in their own batch, not mixed with role messages.
  if (!roleManager.isBusy("PM")) {
    const pmUnread = select<MessageRow>("messages", { to_role: "PM", status: MessageStatus.Unread });
    if (pmUnread.length === 0) {
      rawRun(
        `UPDATE messages SET status = '${MessageStatus.Unread}' WHERE status = '${MessageStatus.Deferred}' AND to_role = 'PM'`
      );
    }
  }

  // 1. User message priority: if there are unread user→PM messages,
  //    dispatch them immediately (bypass PM cooldown)
  if (!roleManager.isBusy("PM")) {
    const userMessages = select<MessageRow>(
      "messages",
      { from_role: "user", to_role: "PM", status: MessageStatus.Unread },
      { orderBy: "created_at ASC" }
    );
    if (userMessages.length > 0) {
      console.log(`   📨 调度 → PM (${userMessages.length} 条用户消息, 优先)`);
      roleManager.setBusy("PM", true);
      const abortController = new AbortController();
      currentAbortController = abortController;
      const taskId = userMessages.find((m) => m.related_task_id)?.related_task_id ?? null;
      currentDispatch = {
        role: "PM",
        taskId,
        sessionId: null, // will be filled by dispatch
        startedAt: new Date().toISOString(),
      };
      try {
        const { sessionId, inputTokens, outputTokens } = await dispatchToRole(
          client,
          sessionManager,
          "PM",
          userMessages,
          {
            signal: abortController.signal,
            onSessionResolved: (sid) => { if (currentDispatch) currentDispatch.sessionId = sid; },
          }
        );
        if (sessionId) {
          await checkAndRotate(
            sessionManager,
            "PM",
            sessionId,
            inputTokens,
            outputTokens,
            taskId ?? undefined
          );
        }
        console.log(`   ✓ PM 调度完成 (用户优先)`);
      } finally {
        currentDispatch = null;
        currentAbortController = null;
        roleManager.setBusy("PM", false);
        // Don't set pmLastDispatchEnd here: user-priority messages should not trigger cooldown
      }
      // User-priority dispatch resets consecutive count (not a "normal" PM dispatch)
      pmConsecutiveCount = 0;
      // After user message dispatch, check triggers and return
      checkAutoTriggers();
      checkWorkflowCompletion(sessionManager);
      return;
    }
  }

  // 2. Normal role dispatch: V1 serial, at most one role per tick
  for (const role of ALL_ROLES) {
    if (roleManager.isBusy(role)) continue;

    // PM cooldown: after PM finishes a dispatch, wait before injecting
    // more role messages. This gives user messages (via opencode web UI)
    // priority over queued role messages.
    if (role === "PM" && Date.now() - pmLastDispatchEnd < PM_COOLDOWN_MS) {
      continue;
    }

    // PM starvation protection: if PM has been dispatched too many times
    // consecutively, skip PM for this tick to let DEV get scheduled.
    if (role === "PM" && pmConsecutiveCount >= PM_MAX_CONSECUTIVE) {
      // Check if other roles have pending messages
      const othersPending = ALL_ROLES.some(
        (r) =>
          r !== "PM" &&
          !roleManager.isBusy(r) &&
          (select<MessageRow>("messages", { to_role: r, status: MessageStatus.Unread })).length > 0
      );
      if (othersPending) {
        continue;
      }
    }

    // Query unread messages for this role
    const messages = select<MessageRow>(
      "messages",
      { to_role: role, status: MessageStatus.Unread },
      { orderBy: "created_at ASC" }
    );

    if (messages.length === 0) continue;

    // V1 serial: dispatch to this role and break
    console.log(`   📨 调度 → ${role} (${messages.length} 条消息)`);
    roleManager.setBusy(role, true);
    const abortController = new AbortController();
    currentAbortController = abortController;
    const dispatchTaskId = messages.find((m) => m.related_task_id)?.related_task_id ?? null;
    currentDispatch = {
      role,
      taskId: dispatchTaskId,
      sessionId: null,
      startedAt: new Date().toISOString(),
    };
    try {
      // DEV: group messages by task to ensure correct session & context per task
      const dispatch = role === "DEV" ? dispatchToRoleGrouped : dispatchToRole;
      const { sessionId, inputTokens, outputTokens } = await dispatch(
        client,
        sessionManager,
        role,
        messages,
        {
          signal: abortController.signal,
          onSessionResolved: (sid) => { if (currentDispatch) currentDispatch.sessionId = sid; },
        }
      );

      // For PM: check session rotation. DEV rotation is handled per-group
      // inside dispatchToRoleGrouped to avoid cross-task token accumulation.
      if (role === "PM" && sessionId) {
        await checkAndRotate(
          sessionManager,
          role,
          sessionId,
          inputTokens,
          outputTokens,
          dispatchTaskId ?? undefined
        );
      }
      console.log(`   ✓ ${role} 调度完成`);
    } catch (err) {
      // Mark messages as read to prevent infinite retry of the same batch.
      // AbortError is rethrown for graceful shutdown handling.
      if (err instanceof AbortError) throw err;
      console.error(`   ❌ ${role} 调度失败，标记 ${messages.length} 条消息为已读防止重复: ${err}`);
      for (const msg of messages) {
        update("messages", { id: msg.id }, { status: MessageStatus.Read });
      }
      insert("logs", {
        role: "system",
        action: "dispatch_failed",
        content: `${role} dispatch failed, ${messages.length} messages marked read: ${String(err).slice(0, 200)}`,
        related_task_id: dispatchTaskId,
      });
    } finally {
      currentDispatch = null;
      currentAbortController = null;
      roleManager.setBusy(role, false);
      if (role === "PM") {
        pmLastDispatchEnd = Date.now();
        pmConsecutiveCount++;
      } else {
        pmConsecutiveCount = 0;
      }
    }

    break; // V1: only one role per tick
  }

  // Always check triggers and completion, even if nothing was dispatched
  // (tasks may have been updated by a previous dispatch's tool calls)
  checkAutoTriggers();
  checkWorkflowCompletion(sessionManager);
}
