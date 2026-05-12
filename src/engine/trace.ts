import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { select, upsertProjectConfig } from '../db/repository.js';

export type TraceKind = 'dispatch' | 'trigger';

export const CURRENT_DISPATCH_TRACE_KEY = 'engine.currentDispatchTraceId';

const traceStore = new AsyncLocalStorage<string>();

export function createTraceId(kind: TraceKind): string {
  return `${kind}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function withTrace<T>(traceId: string, fn: () => T): T {
  return traceStore.run(traceId, fn);
}

export function getActiveTraceId(): string | null {
  return traceStore.getStore() ?? null;
}

export function setCurrentDispatchTrace(traceId: string | null): void {
  upsertProjectConfig(CURRENT_DISPATCH_TRACE_KEY, traceId ?? '');
}

export function getCurrentDispatchTrace(): string | null {
  const rows = select<{ value: string }>('project_config', { key: CURRENT_DISPATCH_TRACE_KEY });
  const value = rows[0]?.value;
  return value ? value : null;
}

export function getAmbientTraceId(): string | null {
  return getActiveTraceId() ?? getCurrentDispatchTrace();
}

export interface TriggerTraceAttachment {
  trace_id: string;
  trace: {
    id: string;
    kind: 'trigger';
    source: 'auto-trigger';
    trigger: string;
    iteration_id?: number;
    task_id?: number;
  };
}

export function buildTriggerTraceAttachment(input: {
  traceId: string;
  trigger: string;
  iterationId?: number;
  taskId?: number;
}): string {
  const attachment: TriggerTraceAttachment = {
    trace_id: input.traceId,
    trace: {
      id: input.traceId,
      kind: 'trigger',
      source: 'auto-trigger',
      trigger: input.trigger,
      iteration_id: input.iterationId,
      task_id: input.taskId,
    },
  };
  return JSON.stringify(attachment);
}
