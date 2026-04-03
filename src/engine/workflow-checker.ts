import fs from "node:fs";
import path from "node:path";
import { select, update, insert, rawQuery } from "../db/repository.js";
import type { SessionManager } from "./session-manager.js";

/**
 * Check all active workflow instances for completion conditions.
 * When a workflow's completion condition is met:
 * 1. Update workflow status to 'completed' and phase to 'done'
 * 2. Release task sessions for DEV/QA
 * 3. Send a system message to PM to trigger final reporting
 */
export function checkWorkflowCompletion(
  workspace: string,
  sessionManager?: SessionManager | null,
): void {
  const activeWorkflows = select("workflow_instances", { status: "active" });

  for (const wf of activeWorkflows) {
    // Check phase advancement for multi-phase workflows before completion
    checkPhaseAdvancement(wf);

    const completed = checkCompletion(wf, workspace);
    if (completed) {
      // Update workflow status
      update(
        "workflow_instances",
        { id: wf.id },
        { status: "completed", phase: "done" },
      );

      // Release task sessions for completed tasks
      if (sessionManager) {
        const tasks = select("tasks", { workflow_id: wf.id }) as Array<{ id: number }>;
        for (const task of tasks) {
          sessionManager.releaseTaskSession(task.id);
        }
      }

      // Send notification to PM
      insert("messages", {
        from_role: "system",
        to_role: "PM",
        type: "system",
        content: buildCompletionMessage(wf),
        status: "unread",
        related_workflow_id: wf.id,
      });

      // Send reflection trigger to all participating roles
      sendReflectionTriggers(wf);

      insert("logs", {
        role: "system",
        action: "workflow_completed",
        content: `工作流 #${wf.id} (${wf.template}) 已完成`,
      });

      console.log(`   ✅ 工作流 #${wf.id} (${wf.template}) 已完成`);
    }
  }
}

/**
 * Check if a workflow's completion condition is met.
 */
function checkCompletion(wf: any, workspace: string): boolean {
  const template = wf.template as string;

  switch (template) {
    case "new-feature":
    case "bug-fix":
      return checkAllTasksDone(wf.id);

    case "iteration-review":
      return checkIterationReviewDone(wf);

    default: {
      // Try to load template and check generic condition
      return checkTemplateCompletion(wf, workspace);
    }
  }
}

/**
 * For new-feature and bug-fix: all associated tasks must be done.
 */
function checkAllTasksDone(workflowId: number): boolean {
  const tasks = select("tasks", { workflow_id: workflowId }) as Array<{
    id: number;
    status: string;
  }>;

  // No tasks yet — workflow not complete
  if (tasks.length === 0) return false;

  return tasks.every((t) => t.status === "done");
}

/**
 * For iteration-review: check if the phase has reached 'done'
 * (PM completes archival → engine advances phase to done).
 * Since the workflow itself transitions phases via messages,
 * we check if we're already in the done phase.
 */
function checkIterationReviewDone(wf: any): boolean {
  // The workflow is completed when it reaches the "done" phase
  // and PM has archived it. Since we check active workflows,
  // and the phase is updated by message handling, we look for
  // the done phase explicitly.
  return wf.phase === "done";
}

/**
 * Check if a multi-phase workflow should advance to the next phase.
 * Phase transitions are detected by messages between roles after the last phase change.
 */
function checkPhaseAdvancement(wf: any): void {
  if (wf.template !== "iteration-review") return;

  const phase = wf.phase as string;

  // Define phase transition rules: current phase → {from, to, next}
  // When a message from `from` to `to` is found after the last phase update, advance to `next`
  const transitions: Record<string, { from: string; to: string; next: string }> = {
    metrics: { from: "OPS", to: "PM", next: "review" },
    review:  { from: "PM",  to: "OPS", next: "apply" },
    apply:   { from: "OPS", to: "PM", next: "done" },
  };

  const rule = transitions[phase];
  if (!rule) return;

  // Look for messages after the workflow's last update that match the transition pattern
  const triggerMessages = rawQuery(
    `SELECT id FROM messages
     WHERE related_workflow_id = ?
       AND from_role = ? AND to_role = ?
       AND created_at > ?
     LIMIT 1`,
    [wf.id, rule.from, rule.to, wf.updated_at],
  );

  if (triggerMessages.length === 0) return;

  // Advance phase
  update("workflow_instances", { id: wf.id }, { phase: rule.next });

  // Update the in-memory wf object so completion check sees the new phase
  wf.phase = rule.next;

  insert("logs", {
    role: "system",
    action: "phase_advanced",
    content: `工作流 #${wf.id} (${wf.template}) 阶段推进: ${phase} → ${rule.next}`,
  });

  console.log(
    `   ➡️  工作流 #${wf.id} (${wf.template}) 阶段: ${phase} → ${rule.next}`,
  );

  // Notify the role responsible for the next phase
  const phaseNotify: Record<string, { role: string; guidance: string }> = {
    review: {
      role: "PM",
      guidance: "OPS 已提交迭代回顾报告和优化方案，请审核并逐条批准或驳回，然后发消息给 OPS。",
    },
    apply: {
      role: "OPS",
      guidance: "PM 已完成审核，请执行已批准的优化（更新角色 prompt、知识库、流程模板），完成后发消息给 PM 确认。注意：修改文件前先备份到 .win-agent/backups/。",
    },
    done: {
      role: "PM",
      guidance: "OPS 已完成优化执行，请归档本轮迭代并通知用户回顾完成。",
    },
  };

  const notify = phaseNotify[rule.next];
  if (notify) {
    insert("messages", {
      from_role: "system",
      to_role: notify.role,
      type: "system",
      content: `工作流 #${wf.id} (iteration-review) 进入「${rule.next}」阶段。${notify.guidance}`,
      status: "unread",
      related_workflow_id: wf.id,
    });
  }
}

/**
 * Generic template-based completion check.
 * Loads the template JSON and evaluates its completion condition.
 */
function checkTemplateCompletion(wf: any, workspace: string): boolean {
  const templatePath = path.join(
    workspace,
    ".win-agent",
    "workflows",
    `${wf.template}.json`,
  );
  if (!fs.existsSync(templatePath)) return false;

  try {
    const template = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
    const condition = template.completion?.condition as string | undefined;

    if (!condition) return false;

    // If the condition mentions "tasks 状态均为 done" or similar,
    // check all associated tasks
    if (condition.includes("done") && condition.includes("task")) {
      return checkAllTasksDone(wf.id);
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Send self-reflection trigger messages to all roles that participated in a workflow.
 * Participating roles are determined by who sent/received messages related to the workflow.
 */
function sendReflectionTriggers(wf: any): void {
  // Find all roles that participated in this workflow via messages
  const messages = select("messages", { related_workflow_id: wf.id }) as Array<{
    from_role: string;
    to_role: string;
  }>;

  // Also check tasks assigned to roles
  const tasks = select("tasks", { workflow_id: wf.id }) as Array<{
    assigned_to: string | null;
  }>;

  const participatingRoles = new Set<string>();
  for (const msg of messages) {
    if (msg.from_role !== "system") participatingRoles.add(msg.from_role);
    if (msg.to_role !== "system") participatingRoles.add(msg.to_role);
  }
  for (const task of tasks) {
    if (task.assigned_to) participatingRoles.add(task.assigned_to);
  }

  // Always include PM (owns all workflows) and exclude "user"
  participatingRoles.add("PM");
  participatingRoles.delete("user");

  for (const role of participatingRoles) {
    insert("messages", {
      from_role: "system",
      to_role: role,
      type: "system",
      content: buildReflectionPrompt(role, wf),
      status: "unread",
      related_workflow_id: wf.id,
    });
  }

  insert("logs", {
    role: "system",
    action: "reflection_triggered",
    content: `工作流 #${wf.id} 完成，已向 ${[...participatingRoles].join(",")} 发送反思触发`,
  });
}

/**
 * Build a reflection prompt tailored to each role.
 */
function buildReflectionPrompt(role: string, wf: any): string {
  const base = `【自我反思】工作流 #${wf.id}（${wf.template}）已完成，请进行自我反思。`;

  const roleGuidance: Record<string, string> = {
    PM: "请回顾：需求理解是否准确？沟通效率如何？信息流转是否及时？有无可改进的协作方式？",
    SA: "请回顾：技术方案可行性如何？任务拆分粒度是否合理？验收标准是否清晰足够？",
    DEV: "请回顾：代码质量如何？自测是否充分？有无被打回？被打回的根因是什么？",
    QA: "请回顾：验收标准是否适用？缺陷描述质量如何？是否有遗漏的测试场景？",
    OPS: "请回顾：上轮优化建议是否生效？指标变化趋势如何？有无新的系统性问题？",
  };

  const guidance = roleGuidance[role] ?? "请回顾本次工作中的经验教训。";

  return [
    base,
    "",
    guidance,
    "",
    "反思产出：",
    "1. 将经验教训写入 memory 表（必须）",
    "2. 如发现需要用户决策的系统性问题，写入 proposals 表（可选，有则写，无则不写）",
  ].join("\n");
}

/**
 * Build a completion notification message for PM.
 */
function buildCompletionMessage(wf: any): string {
  switch (wf.template) {
    case "new-feature":
      return `🎉 工作流 #${wf.id}（新功能开发）所有任务已完成。请汇总验收报告，向用户汇报完成情况。`;

    case "bug-fix":
      return `🐛 工作流 #${wf.id}（Bug 修复）修复任务已完成。请向用户反馈修复结果和验证报告。`;

    case "iteration-review":
      return `📊 工作流 #${wf.id}（迭代回顾）已完成。请归档本轮迭代并通知用户。`;

    default:
      return `工作流 #${wf.id}（${wf.template}）已完成。`;
  }
}
