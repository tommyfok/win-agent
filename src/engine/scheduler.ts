import type { OpencodeClient } from "@opencode-ai/sdk";
import type { SessionManager } from "./session-manager.js";
import { RoleManager, ALL_ROLES } from "./role-manager.js";
import { dispatchToRole, dispatchToRoleGrouped, type MessageRow } from "./dispatcher.js";
import { checkAndRotate, detectModelContextLimit } from "./memory-rotator.js";
import { checkAutoTriggers, resetTriggers } from "./auto-trigger.js";
import { checkWorkflowCompletion } from "./workflow-checker.js";
import { select, insert } from "../db/repository.js";
import { checkAndUnblockDependencies } from "./dependency-checker.js";
import { syncAgents } from "../workspace/sync-agents.js";

/** Sleep helper */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Engine running flag — set to false to stop the main loop */
let running = false;

/** Track whether onboarding agent re-sync has been done */
let onboardingSynced = false;
/** Timestamp when onboarding_completed was first detected (for file-settle delay) */
let onboardingCompletedAt = 0;

/**
 * PM cooldown: after PM finishes a dispatch, wait this many ms before
 * dispatching role messages to PM again. This gives user messages
 * (arriving via opencode web UI) priority over queued role messages.
 */
const PM_COOLDOWN_MS = 3000;
let pmLastDispatchEnd = 0;

/**
 * PM starvation protection: after N consecutive PM-only dispatches,
 * skip PM for one tick to let DEV/QA get scheduled.
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
  sessionManager: SessionManager,
  workspace: string,
): Promise<void> {
  running = true;
  onboardingSynced = false;
  onboardingCompletedAt = 0;
  pmConsecutiveCount = 0;
  resetTriggers();
  const roleManager = new RoleManager();

  console.log("   🔄 调度器主循环已启动");

  while (running) {
    try {
      await schedulerTick(client, sessionManager, roleManager, workspace);
    } catch (err) {
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
  roleManager: RoleManager,
  workspace: string,
): Promise<void> {
  // 0. Auto-unblock tasks whose dependencies are now satisfied
  checkAndUnblockDependencies();

  // 1. User message priority: if there are unread user→PM messages,
  //    dispatch them immediately (bypass PM cooldown)
  if (!roleManager.isBusy("PM")) {
    const userMessages = select(
      "messages",
      { from_role: "user", to_role: "PM", status: "unread" },
      { orderBy: "created_at ASC" },
    ) as MessageRow[];
    if (userMessages.length > 0) {
      console.log(`   📨 调度 → PM (${userMessages.length} 条用户消息, 优先)`);
      roleManager.setBusy("PM", true);
      try {
        const { sessionId, inputTokens, outputTokens } = await dispatchToRole(
          client, sessionManager, "PM", userMessages, workspace,
        );
        const taskId = userMessages.find((m) => m.related_task_id)?.related_task_id;
        if (sessionId) {
          await checkAndRotate(sessionManager, "PM", sessionId, inputTokens, outputTokens, taskId ?? undefined);
        }
        console.log(`   ✓ PM 调度完成 (用户优先)`);
      } finally {
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
  let dispatched = false;

  for (const role of ALL_ROLES) {
    if (roleManager.isBusy(role)) continue;

    // PM cooldown: after PM finishes a dispatch, wait before injecting
    // more role messages. This gives user messages (via opencode web UI)
    // priority over queued role messages.
    if (role === "PM" && Date.now() - pmLastDispatchEnd < PM_COOLDOWN_MS) {
      continue;
    }

    // PM starvation protection: if PM has been dispatched too many times
    // consecutively, skip PM for this tick to let DEV/QA get scheduled.
    if (role === "PM" && pmConsecutiveCount >= PM_MAX_CONSECUTIVE) {
      // Check if other roles have pending messages
      const othersPending = ALL_ROLES.some(
        (r) => r !== "PM" && !roleManager.isBusy(r) &&
          (select("messages", { to_role: r, status: "unread" }) as MessageRow[]).length > 0,
      );
      if (othersPending) {
        continue;
      }
    }

    // Query unread messages for this role
    const messages = select(
      "messages",
      { to_role: role, status: "unread" },
      { orderBy: "created_at ASC" },
    ) as MessageRow[];

    if (messages.length === 0) continue;

    // V1 serial: dispatch to this role and break
    console.log(`   📨 调度 → ${role} (${messages.length} 条消息)`);
    roleManager.setBusy(role, true);
    try {
      // DEV/QA: group messages by task to ensure correct session & context per task
      const dispatch = (role === "DEV" || role === "QA") ? dispatchToRoleGrouped : dispatchToRole;
      const { sessionId, inputTokens, outputTokens } = await dispatch(
        client,
        sessionManager,
        role,
        messages,
        workspace,
      );

      // For PM: check session rotation. DEV/QA rotation is handled per-group
      // inside dispatchToRoleGrouped to avoid cross-task token accumulation.
      if (role === "PM" && sessionId) {
        const taskId = messages.find((m) => m.related_task_id)?.related_task_id;
        await checkAndRotate(
          sessionManager,
          role,
          sessionId,
          inputTokens,
          outputTokens,
          taskId ?? undefined,
        );
      }
      console.log(`   ✓ ${role} 调度完成`);
    } finally {
      roleManager.setBusy(role, false);
      if (role === "PM") {
        pmLastDispatchEnd = Date.now();
        pmConsecutiveCount++;
      } else {
        pmConsecutiveCount = 0;
      }
    }

    dispatched = true;
    break; // V1: only one role per tick
  }

  // Always check triggers and completion, even if nothing was dispatched
  // (tasks may have been updated by a previous dispatch's tool calls)
  checkAutoTriggers();
  checkWorkflowCompletion(sessionManager);

  // Check if onboarding just completed — re-sync agents so updated role prompts take effect.
  // Wait until PM is not busy AND a 2s settle delay has passed (to let file writes complete).
  if (!onboardingSynced && !roleManager.isBusy("PM")) {
    const rows = select("project_config", { key: "onboarding_completed" });
    if (rows.length > 0) {
      if (onboardingCompletedAt === 0) {
        onboardingCompletedAt = Date.now();
      } else if (Date.now() - onboardingCompletedAt >= 2000) {
        onboardingSynced = true;
        syncAgents(workspace);
        insert("logs", {
          role: "system",
          action: "onboarding_sync",
          content: "Onboarding 完成，已重新同步 Agent 配置",
        });
        console.log("   ✓ Onboarding 完成，已重新同步 Agent 配置");
      }
    }
  }
}
