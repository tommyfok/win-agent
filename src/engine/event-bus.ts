import { EventEmitter } from 'node:events';

/** Payload emitted with DISPATCH_COMPLETE. */
export interface DispatchCompletePayload {
  role: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Central event bus for the engine.
 * Used to decouple scheduler from trigger and review checks.
 */
export const engineBus = new EventEmitter();

/**
 * Engine event name constants.
 * - DISPATCH_COMPLETE: emitted after every successful role dispatch.
 * - TASK_STATUS_CHANGED: emitted when a task transitions to a new status.
 * - ITERATION_COMPLETED: emitted when an iteration is marked completed.
 */
export const EngineEvents = {
  DISPATCH_COMPLETE: 'dispatch:complete',
  TASK_STATUS_CHANGED: 'task:statusChanged',
  ITERATION_COMPLETED: 'iteration:completed',
} as const;
