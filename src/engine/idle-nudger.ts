import type { RoleRuntimeState } from './session-reconciler.js';
import { Role } from './role-manager.js';
import { select, insert } from '../db/repository.js';
import { MessageStatus, TaskStatus } from '../db/types.js';
import { loadConfig } from '../config/index.js';
import { getDevLastDispatchEnd, getPmLastDispatchEnd } from './scheduler-dispatch.js';
import { logger } from '../utils/logger.js';

const DEFAULT_IDLE_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_REMINDER_INTERVAL_MS = 10 * 60 * 1000;

export interface IdleNudgerDeps {
  getPmLastDispatchEnd: () => number;
  getDevLastDispatchEnd: () => number;
}

const defaultDeps: IdleNudgerDeps = {
  getPmLastDispatchEnd,
  getDevLastDispatchEnd,
};

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
}

export interface PmIssue {
  type:
    | 'task_not_dispatched'
    | 'task_blocked'
    | 'dev_idle_with_task'
    | 'task_pending_review'
    | 'unread_messages';
  task?: TaskRow;
  count?: number;
}

export class IdleNudger {
  private lastReminderAt = 0;
  private lastDevReminderAt = 0;

  constructor(private deps: IdleNudgerDeps = defaultDeps) {}

  detect(states: ReadonlyMap<Role, RoleRuntimeState>): void {
    const now = Date.now();

    const pmState = states.get(Role.PM);
    if (pmState && !pmState.serverBusy) {
      const idleMs = now - this.deps.getPmLastDispatchEnd();
      if (idleMs >= this.getIdleThresholdMs()) {
        const devState = states.get(Role.DEV);
        const devBusy = devState?.serverBusy ?? false;
        const devIdleMs = now - this.deps.getDevLastDispatchEnd();
        if (!devBusy && devIdleMs >= this.getIdleThresholdMs()) {
          const issues = detectPmAttentionNeeded(devBusy);
          if (issues.length > 0) {
            if (now - this.lastReminderAt >= this.getReminderIntervalMs()) {
              this.sendIdleReminder(issues, idleMs);
              this.lastReminderAt = now;
            }
          }
        }
      }
    }

    const devState = states.get(Role.DEV);
    if (devState && !devState.serverBusy) {
      const devPendingWork = detectDevPendingWork();
      if (devPendingWork) {
        if (now - this.lastDevReminderAt >= this.getReminderIntervalMs()) {
          this.sendDevPendingWorkReminder(devPendingWork);
          this.lastDevReminderAt = now;
        }
      }
    }
  }

  resetReminder(): void {
    this.lastReminderAt = 0;
  }

  private getIdleThresholdMs(): number {
    return loadConfig().engine?.pmIdleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  }

  private getReminderIntervalMs(): number {
    return loadConfig().engine?.pmIdleReminderIntervalMs ?? DEFAULT_REMINDER_INTERVAL_MS;
  }

  private sendDevPendingWorkReminder(work: { taskId: number; taskTitle: string }): void {
    try {
      insert('messages', {
        from_role: Role.SYS,
        to_role: Role.DEV,
        type: 'system',
        content: `⚠️ 你在处理任务「${work.taskTitle}」(Task #${work.taskId}) 期间没有收到任何指令，请检查当前任务状态并继续工作。`,
        status: MessageStatus.Unread,
      });
      insert('logs', {
        role: Role.SYS,
        action: 'dev_pending_work_reminder',
        content: `DEV pending work reminder for task #${work.taskId}`,
      });
      logger.info({ taskId: work.taskId }, 'DEV pending work reminder sent');
    } catch (err) {
      logger.error({ err, taskId: work.taskId }, 'Failed to send DEV pending work reminder');
    }
  }

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

function detectPmAttentionNeeded(devBusy: boolean): PmIssue[] {
  const issues: PmIssue[] = [];

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

  const blockedTasks = select<TaskRow>('tasks', { status: TaskStatus.Blocked });
  for (const task of blockedTasks) {
    issues.push({ type: 'task_blocked', task });
  }

  if (!devBusy) {
    const inDevTasks = select<TaskRow>('tasks', { status: TaskStatus.InDev });
    for (const task of inDevTasks) {
      issues.push({ type: 'dev_idle_with_task', task });
    }
  }

  const pendingReview = select<TaskRow>('tasks', { status: TaskStatus.PendingReview });
  for (const task of pendingReview) {
    issues.push({ type: 'task_pending_review', task });
  }

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

function detectDevPendingWork(): { taskId: number; taskTitle: string } | null {
  const inDevTasks = select<TaskRow>('tasks', { status: TaskStatus.InDev });
  for (const task of inDevTasks) {
    const directives = select<MessageRow>('messages', {
      related_task_id: task.id,
      to_role: Role.DEV,
      type: 'directive',
    });
    if (directives.length === 0) {
      return { taskId: task.id, taskTitle: task.title };
    }
  }
  return null;
}
