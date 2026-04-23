import type { OpencodeClient } from '@opencode-ai/sdk';
import type { RoleRuntimeState } from './session-reconciler.js';
import type { RoleManager } from './role-manager.js';
import { AGENT_ROLES, Role } from './role-manager.js';
import { select, insert, rawQuery } from '../db/repository.js';
import { MessageStatus, TaskStatus } from '../db/types.js';
import { loadConfig } from '../config/index.js';
import { getDevLastDispatchEnd, getPmLastDispatchEnd } from './scheduler-dispatch.js';
import { logger } from '../utils/logger.js';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const STUCK_CHECK_INTERVAL_MS = 60 * 1000;
const STUCK_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_THRESHOLD_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_REMINDER_INTERVAL_MS = 10 * 60 * 1000;

export interface DispatchIntent {
  role: Role;
  reason: 'unread_messages' | 'pending_work' | 'stuck_session';
  details?: unknown;
}

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

export class StallDetector {
  private lastCheckAt = 0;
  private lastReminderAt = 0;
  private lastDevReminderAt = 0;
  private lastStuckCheckAt = new Map<string, number>();

  async detect(
    states: Map<Role, RoleRuntimeState>,
    _roleManager: RoleManager,
    client?: OpencodeClient
  ): Promise<DispatchIntent[]> {
    const now = Date.now();
    const intents: DispatchIntent[] = [];

    for (const role of AGENT_ROLES) {
      const state = states.get(role);
      if (!state) continue;

      if (!state.serverBusy) {
        const cutoff = Date.now() - 30_000;
        const unread = rawQuery<MessageRow>(
          `SELECT * FROM messages
           WHERE to_role = ? AND status = ?
             AND (last_retry_at IS NULL OR last_retry_at < ?)
           ORDER BY created_at ASC`,
          [role, MessageStatus.Unread, cutoff]
        );
        if (unread.length > 0) {
          intents.push({ role, reason: 'unread_messages', details: { count: unread.length } });
        }
      }

      if (state.serverBusy && client && state.sessionId) {
        const lastCheck = this.lastStuckCheckAt.get(state.sessionId) ?? 0;
        if (now - lastCheck >= STUCK_CHECK_INTERVAL_MS) {
          this.lastStuckCheckAt.set(state.sessionId, now);
          const isStuck = await this.checkStuckSession(client, state.sessionId, now);
          if (isStuck) {
            intents.push({ role, reason: 'stuck_session', details: { sessionId: state.sessionId } });
          }
        }
      }
    }

    if (now - this.lastCheckAt >= CHECK_INTERVAL_MS) {
      this.lastCheckAt = now;
      const pmState = states.get(Role.PM);
      if (pmState && !pmState.serverBusy) {
        const idleMs = now - getPmLastDispatchEnd();
        if (idleMs >= this.getIdleThresholdMs()) {
          const devState = states.get(Role.DEV);
          const devBusy = devState?.serverBusy ?? false;
          const devIdleMs = now - getDevLastDispatchEnd();
          if (!devBusy && devIdleMs >= this.getIdleThresholdMs()) {
            const issues = detectPmAttentionNeeded();
            if (issues.length > 0) {
              if (now - this.lastReminderAt >= this.getReminderIntervalMs()) {
                this.sendIdleReminder(issues, idleMs);
                this.lastReminderAt = now;
              }
              intents.push({ role: Role.PM, reason: 'pending_work', details: { issues } });
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
          intents.push({ role: Role.DEV, reason: 'pending_work', details: devPendingWork });
        }
      }
    }

    intents.sort((a, b) => {
      const priority = { unread_messages: 0, stuck_session: 1, pending_work: 2 };
      return priority[a.reason] - priority[b.reason];
    });

    return intents;
  }

  resetReminder(): void {
    this.lastReminderAt = 0;
  }

  private async checkStuckSession(client: OpencodeClient, sessionId: string, now: number): Promise<boolean> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('stuck check timeout')), STUCK_CHECK_TIMEOUT_MS);
      });
      let msgs: Awaited<ReturnType<typeof client.session.messages>>;
      try {
        msgs = await Promise.race([
          client.session.messages({
            path: { id: sessionId },
            query: { limit: 3 },
          }),
          timeoutPromise,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const messages = msgs.data ?? [];
      let lastUpdate = 0;
      for (const m of messages) {
        const info = m.info as { time?: { completed?: number } } | undefined;
        if (info?.time?.completed && info.time.completed > lastUpdate) {
          lastUpdate = info.time.completed;
        }
        const parts = m.parts as Array<{ time?: { end?: number } }>;
        for (const p of parts) {
          if (p.time?.end && p.time.end > lastUpdate) {
            lastUpdate = p.time.end;
          }
        }
      }
      return lastUpdate > 0 && now - lastUpdate > STUCK_THRESHOLD_MS;
    } catch {
      return false;
    }
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

export interface PmIssue {
  type: 'task_not_dispatched' | 'task_blocked' | 'dev_idle_with_task' | 'task_pending_review' | 'unread_messages';
  task?: TaskRow;
  count?: number;
}

function detectPmAttentionNeeded(): PmIssue[] {
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

  const inDevTasks = select<TaskRow>('tasks', { status: TaskStatus.InDev });
  for (const task of inDevTasks) {
    issues.push({ type: 'dev_idle_with_task', task });
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
