import type { RoleRuntimeState } from './session-reconciler.js';
import { AGENT_ROLES, type Role } from './role-manager.js';
import { rawQuery } from '../db/repository.js';
import { MessageStatus } from '../db/types.js';

const DISPATCH_BACKOFF_MS = 30_000;

interface MessageRow {
  id: number;
}

export function findRolesReadyForDispatch(states: ReadonlyMap<Role, RoleRuntimeState>): Role[] {
  const roles: Role[] = [];
  const cutoff = Date.now() - DISPATCH_BACKOFF_MS;

  for (const role of AGENT_ROLES) {
    const state = states.get(role);
    if (state?.serverBusy) continue;

    const unread = rawQuery<MessageRow>(
      `SELECT id FROM messages
       WHERE to_role = ? AND status = ?
         AND (last_retry_at IS NULL OR last_retry_at < ?)
       ORDER BY created_at ASC
       LIMIT 1`,
      [role, MessageStatus.Unread, cutoff]
    );

    if (unread.length > 0) {
      roles.push(role);
    }
  }

  return roles;
}
