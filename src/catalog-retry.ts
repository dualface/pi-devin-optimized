export const CATALOG_RETRY_ATTEMPTS = 3;
export const CATALOG_RETRY_DELAY_MS = 30_000;

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  /**
   * `true` (the default) holds the process open across the wait, which is what a
   * blocking startup fetch needs. A background refresh passes `false` so a
   * pending retry never delays quitting pi.
   */
  keepAlive?: boolean;
  sleep?: (ms: number) => Promise<void>;
  onAttemptFailed?: (error: unknown, attempt: number, attemptsLeft: number) => void;
}

function defaultSleep(ms: number, keepAlive: boolean): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!keepAlive) timer.unref?.();
  });
}

/**
 * Run `operation` until it resolves, at most `attempts` times, waiting
 * `delayMs` between tries. The last error is rethrown so the caller can say
 * why the catalog is unavailable instead of silently degrading.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? CATALOG_RETRY_ATTEMPTS);
  const delayMs = options.delayMs ?? CATALOG_RETRY_DELAY_MS;
  const keepAlive = options.keepAlive ?? true;
  const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, keepAlive));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const attemptsLeft = attempts - attempt;
      options.onAttemptFailed?.(error, attempt, attemptsLeft);
      if (attemptsLeft > 0) await sleep(delayMs);
    }
  }
  throw lastError;
}
