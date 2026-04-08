/**
 * RoleManager — tracks which roles are currently busy (processing messages).
 * V1: serial execution, only one role active at a time.
 */

const ALL_ROLES = ["PM", "DEV"] as const;
export type Role = (typeof ALL_ROLES)[number];
export { ALL_ROLES };

export class RoleManager {
  private busyRoles: Set<string> = new Set();

  isBusy(role: string): boolean {
    return this.busyRoles.has(role);
  }

  setBusy(role: string, busy: boolean): void {
    if (busy) {
      this.busyRoles.add(role);
    } else {
      this.busyRoles.delete(role);
    }
  }
}
