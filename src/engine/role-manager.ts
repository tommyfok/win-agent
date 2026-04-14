/**
 * RoleManager — tracks which roles are currently busy (processing messages).
 * V1: serial execution, only one role active at a time.
 */
export enum Role {
  PM = 'PM',
  DEV = 'DEV',
  // lower case roles for opencode roles
  USER = 'user',
  SYS = 'system',
  ASSISTANT = 'assistant',
}

export const AGENT_ROLES: readonly Role[] = [Role.PM, Role.DEV];
export const NON_AGENT_ROLES: readonly Role[] = [Role.USER, Role.SYS];

export class RoleManager {
  private busyRoles: Set<Role> = new Set();

  isBusy(role: Role): boolean {
    return this.busyRoles.has(role);
  }

  setBusy(role: Role, busy: boolean): void {
    if (busy === true) {
      this.busyRoles.add(role);
    } else {
      this.busyRoles.delete(role);
    }
  }
}
