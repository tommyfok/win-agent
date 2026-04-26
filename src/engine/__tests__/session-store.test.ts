import { describe, expect, it, vi } from 'vitest';
import { waitForSessionsReady } from '../session-store.js';
import { Role } from '../role-manager.js';

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
