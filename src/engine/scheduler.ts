import type { OpencodeClient } from "@opencode-ai/sdk";
import type { SessionManager } from "./session-manager.js";
import { RoleManager, ALL_ROLES } from "./role-manager.js";
import { dispatchToRole, type MessageRow } from "./dispatcher.js";
import { checkAndRotate } from "./memory-rotator.js";
import { checkAutoTriggers, resetTriggers } from "./auto-trigger.js";
import { checkWorkflowCompletion } from "./workflow-checker.js";
import { select } from "../db/repository.js";
import { syncAgents } from "../workspace/sync-agents.js";

/** Sleep helper */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Engine running flag — set to false to stop the main loop */
let running = false;

/** Track whether onboarding agent re-sync has been done */
let onboardingSynced = false;

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
  resetTriggers();
  const roleManager = new RoleManager();

  console.log("   🔄 调度器主循环已启动");

  while (running) {
    try {
      await schedulerTick(client, sessionManager, roleManager, workspace);
    } catch (err) {
      console.error(`   ❌ 调度器异常: ${err}`);
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
 * 1. Iterate roles (PM first), find one with unread messages
 * 2. Dispatch messages to that role
 * 3. Check session rotation
 * 4. Check auto-triggers
 * 5. Check workflow completion
 */
async function schedulerTick(
  client: OpencodeClient,
  sessionManager: SessionManager,
  roleManager: RoleManager,
  workspace: string,
): Promise<void> {
  // V1 serial: dispatch to at most one role per tick
  let dispatched = false;

  for (const role of ALL_ROLES) {
    if (roleManager.isBusy(role)) continue;

    // Query unread messages for this role
    const messages = select(
      "messages",
      { to_role: role, status: "unread" },
      { orderBy: "created_at ASC" },
    ) as MessageRow[];

    if (messages.length === 0) continue;

    // V1 serial: dispatch to this role and break
    roleManager.setBusy(role, true);
    try {
      const { sessionId, inputTokens } = await dispatchToRole(
        client,
        sessionManager,
        role,
        messages,
        workspace,
      );

      // Check if session needs rotation
      const taskId = messages.find((m) => m.related_task_id)?.related_task_id;
      await checkAndRotate(
        sessionManager,
        role,
        sessionId,
        inputTokens,
        taskId ?? undefined,
      );
    } finally {
      roleManager.setBusy(role, false);
    }

    dispatched = true;
    break; // V1: only one role per tick
  }

  // Always check triggers and completion, even if nothing was dispatched
  // (tasks may have been updated by a previous dispatch's tool calls)
  checkAutoTriggers();
  checkWorkflowCompletion(workspace, sessionManager);

  // Check if onboarding just completed — re-sync agents so updated role prompts take effect
  if (!onboardingSynced) {
    const rows = select("project_config", { key: "onboarding_completed" });
    if (rows.length > 0) {
      onboardingSynced = true;
      syncAgents(workspace);
      console.log("   ✓ Onboarding 完成，已重新同步 Agent 配置");
    }
  }
}
