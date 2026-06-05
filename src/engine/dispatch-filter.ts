import { select, update } from '../db/repository.js';
import { TaskStatus, MessageStatus } from '../db/types.js';
import { transitionTaskStatus } from '../db/state-machine.js';
import { checkAndBlockUnmetDependencies } from './dependency-checker.js';
import { parseMessageProtocolAttachment } from './message-protocol.js';
import { Role } from './role-manager.js';

/** Message row from the messages table */
export interface MessageRow {
  id: number;
  from_role: Role;
  to_role: Role;
  type: string;
  content: string;
  status: string;
  related_task_id: number | null;
  related_iteration_id: number | null;
  attachments: string | null;
  created_at: string;
  retry_count: number;
  last_retry_at: number | null;
}

const DEV_SKIP_STATUSES: TaskStatus[] = [TaskStatus.Paused, TaskStatus.Cancelled, TaskStatus.Done];

/**
 * Filter messages before dispatch:
 * - DEV: skip messages for paused/blocked/cancelled tasks; also checks unmet dependencies
 * - For done tasks: only explicit structured reject feedback auto-rejects task to allow DEV to process
 * - Other roles: returns messages unchanged
 *
 * Messages for dependency-blocked tasks are deferred so they can be resumed later.
 * Messages skipped for terminal/suspended states are marked as read to prevent infinite retry.
 * cancel_task and feedback messages are always delivered so DEV can execute rollback/feedback handling.
 */
export function filterMessagesForRole(role: Role, messages: MessageRow[]): MessageRow[] {
  if (role !== Role.DEV) return messages;

  const filtered: MessageRow[] = [];
  for (const msg of messages) {
    if (msg.related_task_id && msg.type !== 'cancel_task' && msg.type !== 'feedback') {
      const tasks = select<{ id: number; status: TaskStatus }>('tasks', {
        id: msg.related_task_id,
      });
      const taskStatus = tasks[0]?.status;
      if (taskStatus === TaskStatus.Blocked) {
        update('messages', { id: msg.id }, { status: MessageStatus.Deferred });
        continue;
      }
      if (taskStatus && DEV_SKIP_STATUSES.includes(taskStatus)) {
        update('messages', { id: msg.id }, { status: MessageStatus.Read });
        continue;
      }
      if (taskStatus) {
        const blocked = checkAndBlockUnmetDependencies(msg.related_task_id, taskStatus);
        if (blocked) {
          update('messages', { id: msg.id }, { status: MessageStatus.Deferred });
          continue;
        }
      }
    }

    if (msg.related_task_id && msg.type === 'feedback') {
      const tasks = select<{ id: number; status: TaskStatus }>('tasks', {
        id: msg.related_task_id,
      });
      const taskStatus = tasks[0]?.status;
      if (taskStatus === TaskStatus.Done && hasExplicitRejectIntent(msg)) {
        const reason =
          msg.content && msg.content.trim() ? msg.content.trim() : 'PM feedback on done task';
        transitionTaskStatus(
          msg.related_task_id,
          TaskStatus.Done,
          TaskStatus.Rejected,
          Role.PM,
          reason
        );
      }
    }

    filtered.push(msg);
  }
  return filtered;
}

function hasExplicitRejectIntent(msg: MessageRow): boolean {
  const parsed = parseMessageProtocolAttachment(msg.attachments);
  if (!parsed.ok) return false;

  const payload = parsed.payload;
  if (payload.type !== 'feedback' || payload.task_id !== msg.related_task_id) return false;

  return (
    payload.intent === 'reject' || payload.result === 'rejected' || payload.action === 'reject'
  );
}
