import { describe, expect, it } from 'vitest';
import {
  MESSAGE_PROTOCOL,
  MESSAGE_PROTOCOL_TYPES,
  formatMessageProtocolAttachment,
  formatMessageProtocolForPrompt,
  parseMessageProtocolAttachment,
  validateMessageProtocolPayload,
} from '../message-protocol.js';

describe('message protocol helpers', () => {
  it('validates and formats a directive payload', () => {
    const payload = {
      protocol: MESSAGE_PROTOCOL,
      type: 'directive',
      task_id: 123,
      iteration_id: 1,
      spec_path: '.win-agent/docs/spec/demo.md',
    } as const;

    expect(validateMessageProtocolPayload(payload)).toEqual({ ok: true, payload });
    expect(formatMessageProtocolAttachment(payload)).toBe(JSON.stringify(payload));
  });

  it('parses all supported message types', () => {
    for (const type of MESSAGE_PROTOCOL_TYPES) {
      const payload = {
        protocol: MESSAGE_PROTOCOL,
        type,
        ...(type === 'reflection' ? { iteration_id: 1 } : { task_id: 1 }),
      };

      expect(parseMessageProtocolAttachment(JSON.stringify(payload))).toMatchObject({
        ok: true,
        payload,
      });
    }
  });

  it('rejects invalid protocol payloads without throwing', () => {
    expect(parseMessageProtocolAttachment('{nope')).toMatchObject({
      ok: false,
      reason: 'attachments is not valid JSON',
    });
    expect(
      validateMessageProtocolPayload({ protocol: MESSAGE_PROTOCOL, type: 'directive' })
    ).toMatchObject({
      ok: false,
      reason: 'directive messages require task_id',
    });
    expect(
      validateMessageProtocolPayload({
        protocol: MESSAGE_PROTOCOL,
        type: 'unknown',
      })
    ).toMatchObject({
      ok: false,
      reason:
        'type must be one of directive, feedback, review_result, cancel_task, system, notification, reflection',
    });
    expect(
      validateMessageProtocolPayload({
        protocol: MESSAGE_PROTOCOL,
        type: 'reflection',
      })
    ).toMatchObject({
      ok: false,
      reason: 'reflection messages require task_id or iteration_id',
    });
  });

  it('formats protocol payloads for prompt display', () => {
    const display = formatMessageProtocolForPrompt({
      protocol: MESSAGE_PROTOCOL,
      type: 'review_result',
      task_id: 42,
      result: 'accepted',
    });

    expect(display).toContain('protocol=win-agent.message.v1');
    expect(display).toContain('type=review_result');
    expect(display).toContain('task_id=42');
    expect(display).toContain('"result":"accepted"');
  });
});
