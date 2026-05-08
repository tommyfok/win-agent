import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAndResumeInterrupted, waitForSessionsReady } from '../session-store.js';
import { Role } from '../role-manager.js';

let workspace: string | null = null;

afterEach(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

describe('waitForSessionsReady', () => {
  it('treats nested assistant messages as a ready session', async () => {
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { role: Role.ASSISTANT }, parts: [] }],
        }),
      },
    };

    await waitForSessionsReady(client as never, new Map([[Role.PM, 'session-1']]));

    expect(client.session.messages).toHaveBeenCalledTimes(1);
  });
});

describe('checkAndResumeInterrupted', () => {
  it('sends an idempotent recovery prompt when resuming a DEV session', async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'win-agent-resume-'));
    fs.mkdirSync(path.join(workspace, '.win-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.win-agent', 'interrupted.json'),
      JSON.stringify({
        role: Role.DEV,
        taskId: 42,
        sessionId: 'dev-session',
        timestamp: new Date().toISOString(),
      }),
      'utf-8'
    );

    const client = {
      session: {
        get: vi.fn().mockResolvedValue({ data: {} }),
        promptAsync: vi.fn().mockResolvedValue({ data: {} }),
      },
    };
    const taskSessions = new Map<string, string>();

    await expect(
      checkAndResumeInterrupted(
        client as never,
        workspace,
        new Map(),
        taskSessions,
        vi.fn()
      )
    ).resolves.toBe(true);

    expect(taskSessions.get(`42-${Role.DEV}`)).toBe('dev-session');
    const body = client.session.promptAsync.mock.calls[0][0].body.parts[0].text;
    expect(body).toContain('不要直接重复上一次动作');
    expect(body).toContain('查询最近 messages / role_outputs / logs');
    expect(body).toContain('避免重复提交、重复改状态、重复发送验收报告');
  });
});
