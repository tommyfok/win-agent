export const MESSAGE_PROTOCOL = 'win-agent.message.v1' as const;

export const MESSAGE_PROTOCOL_TYPES = [
  'directive',
  'feedback',
  'review_result',
  'cancel_task',
  'system',
  'notification',
  'reflection',
] as const;

export type MessageProtocolType = (typeof MESSAGE_PROTOCOL_TYPES)[number];

export interface MessageProtocolPayload {
  protocol: typeof MESSAGE_PROTOCOL;
  type: MessageProtocolType;
  task_id?: number;
  iteration_id?: number;
  [key: string]: unknown;
}

export type MessageProtocolValidationResult =
  | { ok: true; payload: MessageProtocolPayload }
  | { ok: false; reason: string };

export type MessageProtocolParseResult =
  | { ok: true; payload: MessageProtocolPayload }
  | { ok: false; reason: string; raw: string | null };

const MESSAGE_PROTOCOL_TYPE_SET = new Set<string>(MESSAGE_PROTOCOL_TYPES);
const TASK_BOUND_TYPES = new Set<MessageProtocolType>([
  'directive',
  'feedback',
  'review_result',
  'cancel_task',
  'system',
  'notification',
]);
const GLOBAL_TYPES = new Set<MessageProtocolType>(['reflection']);

export function validateMessageProtocolPayload(value: unknown): MessageProtocolValidationResult {
  if (!isRecord(value)) {
    return { ok: false, reason: 'payload must be a JSON object' };
  }

  if (value.protocol !== MESSAGE_PROTOCOL) {
    return { ok: false, reason: `protocol must be ${MESSAGE_PROTOCOL}` };
  }

  if (typeof value.type !== 'string' || !MESSAGE_PROTOCOL_TYPE_SET.has(value.type)) {
    return { ok: false, reason: `type must be one of ${MESSAGE_PROTOCOL_TYPES.join(', ')}` };
  }

  const type = value.type as MessageProtocolType;
  if ('task_id' in value && !isPositiveInteger(value.task_id)) {
    return { ok: false, reason: 'task_id must be a positive integer when present' };
  }

  if ('iteration_id' in value && !isPositiveInteger(value.iteration_id)) {
    return { ok: false, reason: 'iteration_id must be a positive integer when present' };
  }

  if (TASK_BOUND_TYPES.has(type) && !isPositiveInteger(value.task_id)) {
    return { ok: false, reason: `${type} messages require task_id` };
  }

  if (
    GLOBAL_TYPES.has(type) &&
    !isPositiveInteger(value.task_id) &&
    !isPositiveInteger(value.iteration_id)
  ) {
    return { ok: false, reason: `${type} messages require task_id or iteration_id` };
  }

  return { ok: true, payload: value as MessageProtocolPayload };
}

export function isMessageProtocolType(value: unknown): value is MessageProtocolType {
  return typeof value === 'string' && MESSAGE_PROTOCOL_TYPE_SET.has(value);
}

export function isTaskBoundMessageProtocolType(type: MessageProtocolType): boolean {
  return TASK_BOUND_TYPES.has(type);
}

export function isGlobalMessageProtocolType(type: MessageProtocolType): boolean {
  return GLOBAL_TYPES.has(type);
}

export function parseMessageProtocolAttachment(
  attachments: string | null | undefined
): MessageProtocolParseResult {
  if (!attachments) {
    return { ok: false, reason: 'attachments is empty', raw: attachments ?? null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(attachments);
  } catch {
    return { ok: false, reason: 'attachments is not valid JSON', raw: attachments };
  }

  const validation = validateMessageProtocolPayload(parsed);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason, raw: attachments };
  }

  return validation;
}

export function formatMessageProtocolAttachment(payload: MessageProtocolPayload): string {
  const validation = validateMessageProtocolPayload(payload);
  if (!validation.ok) {
    throw new Error(`Invalid ${MESSAGE_PROTOCOL} payload: ${validation.reason}`);
  }
  return JSON.stringify(validation.payload);
}

export function formatMessageProtocolForPrompt(payload: MessageProtocolPayload): string {
  const fields = [
    `protocol=${payload.protocol}`,
    `type=${payload.type}`,
    payload.task_id ? `task_id=${payload.task_id}` : null,
    payload.iteration_id ? `iteration_id=${payload.iteration_id}` : null,
  ].filter(Boolean);

  const extraFields = Object.fromEntries(
    Object.entries(payload).filter(
      ([key]) => !['protocol', 'type', 'task_id', 'iteration_id'].includes(key)
    )
  );
  const extra =
    Object.keys(extraFields).length > 0 ? `\n  extra: ${JSON.stringify(extraFields)}` : '';

  return `结构化消息 (${fields.join(', ')})${extra}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
