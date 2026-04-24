import { describe, expect, it, vi } from 'vitest';
import { SessionStateReconciler } from '../session-reconciler.js';
import { Role, RoleManager } from '../role-manager.js';

describe('SessionStateReconciler', () => {
  it('keeps local mappings when sessions are missing from status but still exist', async () => {
    const invalidateSessionId = vi.fn();
    const sessionManager = {
      getAllRoleSessionIds: (role: Role) => (role === Role.PM ? ['pm-stale'] : ['dev-stale']),
      getRoleSessionId: () => null,
      invalidateSessionId,
    };
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        get: vi.fn().mockResolvedValue({ data: { id: 'session' } }),
      },
    };

    const reconciler = new SessionStateReconciler();
    const result = await reconciler.reconcile(
      client as never,
      sessionManager as never,
      new RoleManager()
    );

    expect(result.healthy).toBe(true);
    expect(invalidateSessionId).not.toHaveBeenCalled();
    expect(result.states.get(Role.PM)?.serverStatus).toEqual({ type: 'idle' });
    expect(result.states.get(Role.DEV)?.serverStatus).toEqual({ type: 'idle' });
  });

  it('invalidates local mappings only after session.get confirms they are gone', async () => {
    const invalidateSessionId = vi.fn();
    const sessionManager = {
      getAllRoleSessionIds: (role: Role) => (role === Role.PM ? ['pm-stale'] : ['dev-stale']),
      getRoleSessionId: () => null,
      invalidateSessionId,
    };
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        get: vi.fn().mockRejectedValue(new Error('missing')),
      },
    };

    const reconciler = new SessionStateReconciler();
    const result = await reconciler.reconcile(
      client as never,
      sessionManager as never,
      new RoleManager()
    );

    expect(result.healthy).toBe(true);
    expect(invalidateSessionId).toHaveBeenCalledWith('pm-stale');
    expect(invalidateSessionId).toHaveBeenCalledWith('dev-stale');
    expect(result.states.get(Role.PM)?.serverStatus).toBe('no-session');
    expect(result.states.get(Role.DEV)?.serverStatus).toBe('no-session');
  });
});
