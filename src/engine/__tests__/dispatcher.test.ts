import { beforeEach, describe, expect, it, vi } from 'vitest';
import { select, insert } from '../../db/repository.js';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { MessageStatus } from '../../db/types.js';
import { dispatchToRole, type MessageRow } from '../dispatcher.js';
import { Role } from '../role-manager.js';

beforeEach(() => {
  setupTestDb();
});

function makeMessage(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: 0,
    from_role: Role.PM,
    to_role: Role.DEV,
    type: 'directive',
    content: 'work',
    status: MessageStatus.Unread,
    related_task_id: null,
    related_iteration_id: null,
    attachments: null,
    created_at: '',
    retry_count: 0,
    last_retry_at: null,
    ...overrides,
  };
}

describe('dispatchToRole DEV session routing', () => {
  it('skips task-bound DEV messages without related_task_id instead of using fallback session', async () => {
    const { lastInsertRowid } = insert('messages', {
      from_role: Role.PM,
      to_role: Role.DEV,
      type: 'directive',
      content: 'build this',
      status: MessageStatus.Unread,
    });
    const msgId = Number(lastInsertRowid);

    const client = {
      session: {
        prompt: vi.fn(),
      },
    };
    const sessionManager = {
      getTaskSession: vi.fn(),
    };

    const result = await dispatchToRole(client as never, sessionManager as never, Role.DEV, [
      makeMessage({ id: msgId, content: 'build this' }),
    ]);

    expect(result.sessionId).toBeNull();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(sessionManager.getTaskSession).not.toHaveBeenCalled();
    expect(select<{ status: string }>('messages', { id: msgId })[0].status).toBe(
      MessageStatus.Read
    );

    const pmMessages = select<{ content: string }>('messages', {
      from_role: Role.SYS,
      to_role: Role.PM,
      status: MessageStatus.Unread,
    });
    expect(pmMessages[0].content).toContain(`msg#${msgId} 缺少 related_task_id`);
  });

  it('skips non-global DEV messages without related_task_id instead of using fallback session', async () => {
    const { lastInsertRowid } = insert('messages', {
      from_role: Role.SYS,
      to_role: Role.DEV,
      type: 'reflection',
      content: 'reflect',
      status: MessageStatus.Unread,
    });
    const msgId = Number(lastInsertRowid);

    const client = {
      session: {
        prompt: vi.fn(),
      },
    };
    const sessionManager = {
      getTaskSession: vi.fn(),
    };

    const result = await dispatchToRole(client as never, sessionManager as never, Role.DEV, [
      makeMessage({ id: msgId, type: 'reflection', content: 'reflect', from_role: Role.SYS }),
    ]);

    expect(result.sessionId).toBeNull();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(sessionManager.getTaskSession).not.toHaveBeenCalled();
    expect(select<{ status: string }>('messages', { id: msgId })[0].status).toBe(
      MessageStatus.Read
    );
  });

  it('allows global DEV reflection messages with related_iteration_id to use the fallback session', async () => {
    const { lastInsertRowid: iterationRowid } = insert('iterations', {
      status: 'reviewed',
    });
    const iterationId = Number(iterationRowid);
    const { lastInsertRowid } = insert('messages', {
      from_role: Role.SYS,
      to_role: Role.DEV,
      type: 'reflection',
      content: 'reflect',
      status: MessageStatus.Unread,
      related_iteration_id: iterationId,
    });
    const msgId = Number(lastInsertRowid);

    const client = {
      session: {
        prompt: vi.fn().mockResolvedValue({
          data: {
            parts: [{ type: 'text', text: 'ok' }],
            info: { tokens: { input: 1, output: 1 } },
          },
        }),
      },
    };
    const sessionManager = {
      getTaskSession: vi.fn().mockResolvedValue('fallback-session'),
      getWorkspace: vi.fn().mockReturnValue(process.cwd()),
      consumePendingContext: vi.fn().mockReturnValue(''),
    };

    const result = await dispatchToRole(client as never, sessionManager as never, Role.DEV, [
      makeMessage({
        id: msgId,
        type: 'reflection',
        content: 'reflect',
        from_role: Role.SYS,
        related_iteration_id: iterationId,
      }),
    ]);

    expect(result.sessionId).toBe('fallback-session');
    expect(sessionManager.getTaskSession).toHaveBeenCalledWith(-1, Role.DEV);
    expect(client.session.prompt).toHaveBeenCalledTimes(1);

    const outputs = select<{ trace_id: string | null }>('role_outputs', {});
    expect(outputs[0].trace_id).toMatch(/^dispatch_/);

    const logs = select<{ trace_id: string | null }>('logs', { action: 'dispatch' });
    expect(logs[0].trace_id).toBe(outputs[0].trace_id);
  });

  it('uses caller-provided dispatch trace id in role_outputs and logs', async () => {
    const { lastInsertRowid: iterationRowid } = insert('iterations', {
      status: 'reviewed',
    });
    const iterationId = Number(iterationRowid);
    const { lastInsertRowid } = insert('messages', {
      from_role: Role.SYS,
      to_role: Role.DEV,
      type: 'reflection',
      content: 'reflect',
      status: MessageStatus.Unread,
      related_iteration_id: iterationId,
    });
    const msgId = Number(lastInsertRowid);

    const client = {
      session: {
        prompt: vi.fn().mockResolvedValue({
          data: {
            parts: [{ type: 'text', text: 'ok' }],
            info: { tokens: { input: 1, output: 1 } },
          },
        }),
      },
    };
    const sessionManager = {
      getTaskSession: vi.fn().mockResolvedValue('fallback-session'),
      getWorkspace: vi.fn().mockReturnValue(process.cwd()),
      consumePendingContext: vi.fn().mockReturnValue(''),
    };

    await dispatchToRole(
      client as never,
      sessionManager as never,
      Role.DEV,
      [
        makeMessage({
          id: msgId,
          type: 'reflection',
          content: 'reflect',
          from_role: Role.SYS,
          related_iteration_id: iterationId,
        }),
      ],
      { traceId: 'dispatch_test_123' }
    );

    expect(select<{ trace_id: string | null }>('role_outputs', {})[0].trace_id).toBe(
      'dispatch_test_123'
    );
    expect(select<{ trace_id: string | null }>('logs', { action: 'dispatch' })[0].trace_id).toBe(
      'dispatch_test_123'
    );
  });
});
