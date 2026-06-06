import { createHash } from 'node:crypto';
import type { MessageRow } from './dispatch-filter.js';

const MARKER_START = '<!-- win-agent-dispatch';
const MARKER_END = '-->';
const HISTORY_MARKER_RE = /<!--\s*win-agent-dispatch\s*([\s\S]*?)-->/g;

export interface DispatchSignature {
  messageIds: number[];
  taskId: number | null;
  types: string[];
  fingerprint: string;
}

export interface SessionMessageLike {
  parts?: Array<{
    type?: string;
    text?: string;
    content?: string;
  }>;
}

interface ParsedDispatchMarker {
  messageIds: number[];
  taskId: number | null;
  fingerprint: string | null;
}

export interface DispatchHistoryMatch {
  exactMessageIds: number[];
  sameFingerprint: boolean;
}

export function createDispatchSignature(messages: MessageRow[]): DispatchSignature {
  const messageIds = messages.map((m) => m.id).sort((a, b) => a - b);
  const taskIds = new Set(messages.map((m) => m.related_task_id ?? null));
  const taskId = taskIds.size === 1 ? messages[0]?.related_task_id ?? null : null;
  const types = [...new Set(messages.map((m) => m.type))].sort();

  const canonicalMessages = messages
    .map((m) => ({
      from_role: m.from_role,
      to_role: m.to_role,
      type: m.type,
      content: normalizeContent(m.content),
      related_task_id: m.related_task_id,
      related_iteration_id: m.related_iteration_id,
      attachments: normalizeContent(m.attachments ?? ''),
    }))
    .sort((a, b) => {
      const aKey = `${a.related_task_id ?? ''}:${a.type}:${a.content}`;
      const bKey = `${b.related_task_id ?? ''}:${b.type}:${b.content}`;
      return aKey.localeCompare(bKey);
    });

  return {
    messageIds,
    taskId,
    types,
    fingerprint: `sha256:${hashJson(canonicalMessages)}`,
  };
}

export function buildDispatchMarker(signature: DispatchSignature, traceId: string): string {
  return (
    `${MARKER_START}\n` +
    `trace_id: ${traceId}\n` +
    `message_ids: ${signature.messageIds.join(',')}\n` +
    `task_id: ${signature.taskId ?? 'none'}\n` +
    `types: ${signature.types.join(',')}\n` +
    `fingerprint: ${signature.fingerprint}\n` +
    MARKER_END
  );
}

export function findDispatchHistoryMatch(
  history: SessionMessageLike[],
  signature: DispatchSignature
): DispatchHistoryMatch {
  const wantedIds = new Set(signature.messageIds);
  const exactIds = new Set<number>();
  let sameFingerprint = false;

  for (const message of history) {
    for (const marker of parseDispatchMarkers(extractTextFromSessionMessage(message))) {
      for (const id of marker.messageIds) {
        if (wantedIds.has(id)) exactIds.add(id);
      }
      if (
        marker.fingerprint === signature.fingerprint &&
        marker.taskId === signature.taskId &&
        !marker.messageIds.some((id) => wantedIds.has(id))
      ) {
        sameFingerprint = true;
      }
    }
  }

  return {
    exactMessageIds: [...exactIds].sort((a, b) => a - b),
    sameFingerprint,
  };
}

function parseDispatchMarkers(text: string): ParsedDispatchMarker[] {
  const markers: ParsedDispatchMarker[] = [];
  for (const match of text.matchAll(HISTORY_MARKER_RE)) {
    const fields = parseMarkerFields(match[1] ?? '');
    markers.push({
      messageIds: parseNumberList(fields.message_ids),
      taskId: parseNullableNumber(fields.task_id),
      fingerprint: fields.fingerprint ?? null,
    });
  }
  return markers;
}

function parseMarkerFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}

function parseNumberList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function parseNullableNumber(value: string | undefined): number | null {
  if (!value || value === 'none') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function extractTextFromSessionMessage(message: SessionMessageLike): string {
  return (message.parts ?? [])
    .map((part) => {
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeContent(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
