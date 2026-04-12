import { select, update } from '../db/repository.js';
import { TaskStatus, MessageStatus } from '../db/types.js';
import { checkAndBlockUnmetDependencies } from './dependency-checker.js';
import type { Role } from './role-manager.js';

/** Message row from the messages table */
export interface MessageRow {
  id: number;
  from_role: string;
  to_role: string;
  type: string;
  content: string;
  status: string;
  related_task_id: number | null;
  related_iteration_id: number | null;
  attachments: string | null;
  created_at: string;
}

const DEV_SKIP_STATUSES: TaskStatus[] = [
  TaskStatus.Paused,
  TaskStatus.Cancelled,
  TaskStatus.Blocked,
];

/**
 * Filter messages before dispatch:
 * - DEV: skip messages for paused/blocked/cancelled tasks; also checks unmet dependencies
 * - For done tasks: if message is feedback/cancel_task, auto-reject task to allow DEV to process
 * - Other roles: returns messages unchanged
 *
 * Skipped messages are marked as read to prevent infinite retry.
 * cancel_task and feedback messages are always delivered so DEV can execute rollback/feedback handling.
 */
export function filterMessagesForRole(role: Role, messages: MessageRow[]): MessageRow[] {
  if (role !== 'DEV') return messages;

  const filtered: MessageRow[] = [];
  for (const msg of messages) {
    if (msg.related_task_id && msg.type !== 'cancel_task' && msg.type !== 'feedback') {
      const tasks = select<{ id: number; status: TaskStatus }>('tasks', {
        id: msg.related_task_id,
      });
      const taskStatus = tasks[0]?.status;
      if (taskStatus && DEV_SKIP_STATUSES.includes(taskStatus)) {
        update('messages', { id: msg.id }, { status: MessageStatus.Read });
        continue;
      }
      if (taskStatus) {
        const blocked = checkAndBlockUnmetDependencies(msg.related_task_id, taskStatus);
        if (blocked) {
          update('messages', { id: msg.id }, { status: MessageStatus.Read });
          continue;
        }
      }
    }

    if (msg.related_task_id && msg.type === 'feedback') {
      const tasks = select<{ id: number; status: TaskStatus }>('tasks', {
        id: msg.related_task_id,
      });
      const taskStatus = tasks[0]?.status;
      if (taskStatus === TaskStatus.Done) {
        update('tasks', { id: msg.related_task_id }, { status: TaskStatus.Rejected });
      }
    }

    filtered.push(msg);
  }
  return filtered;
}
