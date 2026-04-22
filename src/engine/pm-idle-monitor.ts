import { select, insert } from '../db/repository.js';
import { MessageStatus, TaskStatus } from '../db/types.js';
import { Role, type RoleManager } from './role-manager.js';
import { loadConfig } from '../config/index.js';
import { getDevLastDispatchEnd } from './scheduler-dispatch.js';
import { logger } from '../utils/logger.js';

const DEFAULT_IDLE_THRESHOLD_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_REMINDER_INTERVAL_MS = 10 * 60 * 1000;

interface TaskRow {
  id: number;
  title: string;
  status: string;
}

interface MessageRow {
  id: number;
  from_role: string;
  to_role: string;
  type: string;
  status: string;
  related_task_id: number | null;
  retry_count: number;
  last_retry_at: number | null;
}

export interface PmIssue {
  type: 'task_not_dispatched' | 'task_blocked' | 'dev_idle_with_task' | 'task_pending_review' | 'unread_messages';
  task?: TaskRow;
  count?: number;
}

export class PmIdleMonitor {
  private lastIdleCheckAt = 0;
  private lastReminderAt = 0;

  private getPmIdleThresholdMs(): number {
    return loadConfig().engine?.pmIdleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  }

  private getReminderIntervalMs(): number {
    return loadConfig().engine?.pmIdleReminderIntervalMs ?? DEFAULT_REMINDER_INTERVAL_MS;
  }

  /**
   * Check if PM has been idle too long and needs attention.
   * Called from scheduler tick every second, but internal check runs every minute.
   * @param pmLastDispatchEnd - timestamp of PM's last dispatch end, passed from scheduler-dispatch
   */
  check(roleManager: RoleManager, pmLastDispatchEnd: number): void {
    const now = Date.now();

    // 1. Check every minute
    if (now - this.lastIdleCheckAt < CHECK_INTERVAL_MS) return;
    this.lastIdleCheckAt = now;

    // 2. PM busy - skip
    if (roleManager.isBusy(Role.PM)) return;

    // 3. Check idle duration
    const idleMs = now - pmLastDispatchEnd;
    if (idleMs < this.getPmIdleThresholdMs()) return;

    // 4. Check reminder interval (continuous reminder mode)
    if (now - this.lastReminderAt < this.getReminderIntervalMs()) return;

    // 5. Pre-check: DEV busy OR DEV recently active → don't disturb PM
    const devBusy = roleManager.isBusy(Role.DEV);
    const devLastActive = getDevLastDispatchEnd();
    const devIdleMs = now - devLastActive;
    if (devBusy || devIdleMs < this.getPmIdleThresholdMs()) return;

    // 6. Detect issues needing PM attention
    const issues = detectPmAttentionNeeded(roleManager);

    // 7. Has issues -> send reminder
    if (issues.length > 0) {
      this.sendIdleReminder(issues, idleMs);
      this.lastReminderAt = now;
    }
  }

  /**
   * Reset reminder timer (call when PM starts working).
   */
  resetReminder(): void {
    this.lastReminderAt = 0;
  }

  /**
   * Reset all internal state (for testing).
   */
  resetAll(): void {
    this.lastIdleCheckAt = 0;
    this.lastReminderAt = 0;
  }

  /**
   * Send idle reminder message to PM.
   */
  private sendIdleReminder(issues: PmIssue[], idleMs: number): void {
    const minutes = Math.round(idleMs / 60000);
    const issueLines = issues.map((i) => {
      switch (i.type) {
        case 'task_not_dispatched':
          return `- Task #${i.task!.id}「${i.task!.title}」待派发`;
        case 'task_blocked':
          return `- Task #${i.task!.id}「${i.task!.title}」被阻塞`;
        case 'dev_idle_with_task':
          return `- Task #${i.task!.id}「${i.task!.title}」开发中但DEV空闲`;
        case 'task_pending_review':
          return `- Task #${i.task!.id}「${i.task!.title}」待验收`;
        case 'unread_messages':
          return `- ${i.count!} 条未读消息待处理`;
      }
    });

    try {
      insert('messages', {
        from_role: Role.SYS,
        to_role: Role.PM,
        type: 'system',
        content: `⏰ PM 已空闲 ${minutes} 分钟，以下事项需要关注：

${issueLines.join('\n')}

请检查并采取相应行动。`,
        status: MessageStatus.Unread,
      });

      insert('logs', {
        role: Role.SYS,
        action: 'pm_idle_reminder',
        content: `PM空闲${minutes}分钟，${issues.length}项待关注`,
      });

      logger.info({ minutes, issueCount: issues.length }, 'PM idle reminder sent');
      console.log(`   ⏰ PM空闲提醒: 空闲${minutes}分钟，${issues.length}项待关注`);
    } catch (err) {
      logger.error({ err, minutes, issueCount: issues.length }, 'Failed to send PM idle reminder');
    }
  }
}

/**
 * Detect issues that need PM attention.
 */
function detectPmAttentionNeeded(roleManager: RoleManager): PmIssue[] {
  const issues: PmIssue[] = [];

  // 1. pending_dev tasks without directive sent
  const pendingDev = select<TaskRow>('tasks', { status: TaskStatus.PendingDev });
  for (const task of pendingDev) {
    const directiveSent = select<MessageRow>('messages', {
      related_task_id: task.id,
      from_role: Role.PM,
      to_role: Role.DEV,
      type: 'directive',
    });
    if (directiveSent.length === 0) {
      issues.push({ type: 'task_not_dispatched', task });
    }
  }

  // 2. blocked tasks
  const blockedTasks = select<TaskRow>('tasks', { status: TaskStatus.Blocked });
  for (const task of blockedTasks) {
    issues.push({ type: 'task_blocked', task });
  }

  // 3. in_dev tasks but DEV idle
  const inDevTasks = select<TaskRow>('tasks', { status: TaskStatus.InDev });
  const devBusy = roleManager.isBusy(Role.DEV);
  for (const task of inDevTasks) {
    if (!devBusy) {
      issues.push({ type: 'dev_idle_with_task', task });
    }
  }

  // 4. pending_review tasks
  const pendingReview = select<TaskRow>('tasks', { status: TaskStatus.PendingReview });
  for (const task of pendingReview) {
    issues.push({ type: 'task_pending_review', task });
  }

  // 5. PM unread messages from user/DEV
  const pmUnread = select<MessageRow>('messages', {
    to_role: Role.PM,
    status: MessageStatus.Unread,
  });
  const userDevMessages = pmUnread.filter((m) => m.from_role !== Role.SYS);
  if (userDevMessages.length > 0) {
    issues.push({ type: 'unread_messages', count: userDevMessages.length });
  }

  return issues;
}