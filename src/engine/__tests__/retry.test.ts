import { describe, expect, it, vi } from 'vitest';
import { withAbortableTimeout } from '../retry.js';

describe('withAbortableTimeout', () => {
  it('aborts the operation when the timeout expires', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;

    const pending = withAbortableTimeout(
      (signal) => {
        receivedSignal = signal;
        return new Promise(() => undefined);
      },
      100,
      'slow operation'
    );

    const assertion = expect(pending).rejects.toThrow('slow operation 超时 (100ms)');

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(receivedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('forwards parent aborts to the operation signal', async () => {
    const parent = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const pending = withAbortableTimeout(
      (signal) => {
        receivedSignal = signal;
        return new Promise(() => undefined);
      },
      10_000,
      'abortable operation',
      parent.signal
    );

    parent.abort();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toBeDefined();
  });
});
