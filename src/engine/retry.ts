/**
 * Retry and timeout utilities for resilient async operations.
 */

/** Options for withRetry */
export interface RetryOptions {
  /** Max number of attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in ms before first retry (default: 1000) */
  baseDelay?: number;
  /** Multiply delay by this factor each retry (default: 2) */
  backoffFactor?: number;
  /** Label for logging (default: "operation") */
  label?: string;
}

/**
 * Retry an async operation with exponential backoff.
 * Throws the last error if all attempts fail.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, baseDelay = 1000, backoffFactor = 2, label = "operation" } = opts;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;

      const delay = baseDelay * backoffFactor ** (attempt - 1);
      console.log(`   ⚠️  ${label} 失败 (尝试 ${attempt}/${maxAttempts})，${delay}ms 后重试...`);
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

/**
 * Wrap a promise with a timeout.
 * Rejects with a TimeoutError if the operation exceeds the given duration.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation"
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
