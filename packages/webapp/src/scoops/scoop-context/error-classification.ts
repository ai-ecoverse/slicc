import { isExhaustedBudgetError } from '../../core/error-families.js';

export function isImageProcessingError(msg: string): boolean {
  return (
    /image exceeds.*maximum/i.test(msg) ||
    /Could not process image/i.test(msg) ||
    /invalid.*image/i.test(msg) ||
    /image.*too (large|big)/i.test(msg)
  );
}

export function isNonRetryableError(msg: string): boolean {
  if (isExhaustedBudgetError(msg)) return true;
  return (
    /\b(401|403|404|405|410|422)\b/.test(msg) ||
    /unauthorized|forbidden|authentication.*failed|invalid.*api.?key/i.test(msg) ||
    /session expired|log in again|re-?authenticate/i.test(msg) ||
    /model.*not.*found|invalid.*model|unknown.*model|does.*not.*exist/i.test(msg) ||
    /decommissioned|no longer supported|deprecated.*model|model.*deprecated|model.*retired/i.test(
      msg
    ) ||
    /insufficient.*quota|billing|payment.*required|account.*suspended/i.test(msg) ||
    /invalid.*request|malformed|bad.*request/i.test(msg)
  );
}

export function isRetryableError(msg: string): boolean {
  if (isExhaustedBudgetError(msg)) return false;
  return (
    /\b429\b|rate.*limit|too.*many.*requests|quota.*exceeded/i.test(msg) ||
    /\b(500|502|503|504)\b|internal.*server|bad.*gateway|service.*unavailable|gateway.*timeout/i.test(
      msg
    ) ||
    /network.*error|failed to fetch|connection.*refused|timeout|econnreset|socket.*hang.*up/i.test(
      msg
    ) ||
    /overloaded|temporarily.*unavailable|try.*again/i.test(msg)
  );
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
