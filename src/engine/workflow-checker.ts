import fs from "node:fs";
import path from "node:path";
import { select, update, insert } from "../db/repository.js";

/**
 * Check all active workflow instances for completion conditions.
 * When a workflow's completion condition is met:
 * 1. Update workflow status to 'completed' and phase to 'done'
 * 2. Send a system message to PM to trigger final reporting
 */
export function checkWorkflowCompletion(workspace: string): void {
  const activeWorkflows = select("workflow_instances", { status: "active" });

  for (const wf of activeWorkflows) {
    const completed = checkCompletion(wf, workspace);
    if (completed) {
      // Update workflow status
      update(
        "workflow_instances",
        { id: wf.id },
        { status: "completed", phase: "done" },
      );

      // Send notification to PM
      insert("messages", {
        from_role: "system",
        to_role: "PM",
        type: "system",
        content: buildCompletionMessage(wf),
        status: "unread",
        related_workflow_id: wf.id,
      });

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
