/**
 * fetch wrapper that bounds each attempt with a timeout, retries on
 * transient failures up to a budget, honors `Retry-After`, and threads an
 * outer `AbortSignal` through to the in-flight fetch.
 *
 * Used by S3 and DA backends. Pure function — does not depend on any
 * backend type.
 *
 * See spec §"Timeouts" and §"Retry budgets" for the contract this file
 * implements.
 */

export interface FetchBudgetOptions {
  /** Total attempts including the first one (1-3 in practice). */
  maxAttempts: number;
  /** Per-attempt timeout in ms. Aborts that attempt only. */
  perAttemptMs: number;
  /** Total operation budget in ms. Caps cumulative retry time. */
  totalBudgetMs: number;
  /** Outer signal — abort here propagates to all attempts. */
  signal?: AbortSignal;
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function backoffMs(attemptAfterFailure: number): number {
  // Spec: attempt 2 → random(250, 1000), attempt 3 → random(750, 2500).
  // attemptAfterFailure is 1-indexed (1 = sleep before second fetch attempt).
  if (attemptAfterFailure === 1) return 250 + Math.random() * 750;
  if (attemptAfterFailure === 2) return 750 + Math.random() * 1750;
  // Beyond what we use today, clamp to the third-attempt window.
  return 750 + Math.random() * 1750;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  // Either delta-seconds (integer) or HTTP-date.
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException(signal.reason ?? 'aborted', 'AbortError'));
      return;
    }
    let onAbort: (() => void) | undefined;
    const t = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    onAbort = () => {
      clearTimeout(t);
      reject(new DOMException(signal?.reason ?? 'aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function fetchWithBudget(
  request: Request,
  opts: FetchBudgetOptions
): Promise<Response> {
  const start = Date.now();
  let attempt = 0;
  let lastErr: unknown;

  while (attempt < opts.maxAttempts) {
    attempt++;

    if (opts.signal?.aborted) {
      throw new DOMException(opts.signal.reason ?? 'aborted', 'AbortError');
    }
    const elapsed = Date.now() - start;
    if (elapsed >= opts.totalBudgetMs) {
      throw new DOMException('total budget exceeded', 'AbortError');
    }

    const attemptCtl = new AbortController();
    const onOuterAbort = (): void => attemptCtl.abort();
    opts.signal?.addEventListener('abort', onOuterAbort);
    const timeout = setTimeout(() => attemptCtl.abort(), opts.perAttemptMs);

    try {
      const res = await fetch(request, { signal: attemptCtl.signal });

      if (!RETRY_STATUS.has(res.status) || attempt >= opts.maxAttempts) {
        return res;
      }

      const ra = parseRetryAfter(res.headers.get('retry-after'));
      const sleepMs = ra ?? backoffMs(attempt);
      const remaining = opts.totalBudgetMs - (Date.now() - start);
      await sleep(Math.min(sleepMs, Math.max(0, remaining - 1)), opts.signal);
      lastErr = res;
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) {
        throw err;
      }
      if (attempt >= opts.maxAttempts) throw err;
      const sleepMs = backoffMs(attempt);
      const remaining = opts.totalBudgetMs - (Date.now() - start);
      await sleep(Math.min(sleepMs, Math.max(0, remaining - 1)), opts.signal);
    } finally {
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  if (lastErr instanceof Response) return lastErr;
  throw lastErr;
}
