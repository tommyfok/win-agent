import { describe, expect, it } from 'vitest';
import {
  buildDispatchMarker,
  createDispatchSignature,
  findDispatchHistoryMatch,
} from '../dispatch-dedupe.js';
import { MessageStatus } from '../../db/types.js';
import { Role } from '../role-manager.js';
import type { MessageRow } from '../dispatcher.js';

function makeMessage(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: 1,
    from_role: Role.PM,
    to_role: Role.DEV,
    type: 'directive',
    content: 'task#2 派发：[backend] 新增订单导出预检查接口',
    status: MessageStatus.Unread,
    related_task_id: 2,
    related_iteration_id: null,
    attachments: null,
    created_at: '',
    retry_count: 0,
    last_retry_at: null,
    ...overrides,
  };
}

describe('dispatch dedupe markers', () => {
  it('finds a prior dispatch by message id', () => {
    const message = makeMessage({ id: 42 });
    const signature = createDispatchSignature([message]);
    const marker = buildDispatchMarker(signature, 'dispatch_test');

    const match = findDispatchHistoryMatch(
      [
        {
          parts: [{ type: 'text', text: `${marker}\n\n## 本次派发消息\n...` }],
        },
      ],
      signature
    );

    expect(match.exactMessageIds).toEqual([42]);
    expect(match.sameFingerprint).toBe(false);
  });

  it('reports same content fingerprint without treating new message ids as exact duplicates', () => {
    const first = makeMessage({ id: 1 });
    const second = makeMessage({ id: 2 });
    const firstMarker = buildDispatchMarker(createDispatchSignature([first]), 'dispatch_old');

    const match = findDispatchHistoryMatch(
      [{ parts: [{ type: 'text', text: firstMarker }] }],
      createDispatchSignature([second])
    );

    expect(match.exactMessageIds).toEqual([]);
    expect(match.sameFingerprint).toBe(true);
  });
});
