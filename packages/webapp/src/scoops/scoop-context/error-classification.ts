/**
 * Error classification for the turn-retry loop.
 *
 * Owns: the regex predicates that decide whether an LLM/tool failure is fatal,
 * worth retrying, or an image-payload problem, plus the cooperative sleep the
 * backoff between attempts uses.
 *
 * Changes when a provider starts phrasing a failure differently (a new
 * decommissioned-model wording, a new rate-limit shape) — a reason entirely
 * independent of how a turn is driven, which is why it does not live in
 * `turn-runner.ts`.
 */

/** Detect API errors caused by invalid/oversized images. */
export function isImageProcessingError(msg: string): boolean {
  return (
    /image exceeds.*maximum/i.test(msg) ||
    /Could not process image/i.test(msg) ||
    /invalid.*image/i.test(msg) ||
    /image.*too (large|big)/i.test(msg)
  );
}

/**
 * Detect errors that are unlikely to succeed on retry.
 * These include authentication failures, invalid model IDs, and permanent API errors.
 */
export function isNonRetryableError(msg: string): boolean {
  return (
    // HTTP 4xx errors (except 429 rate limit which is retryable)
    /\b(401|403|404|405|410|422)\b/.test(msg) ||
    // Authentication / authorization failures
    /unauthorized|forbidden|authentication.*failed|invalid.*api.?key/i.test(msg) ||
    // Expired session that needs interactive re-auth (won't succeed on retry)
    /session expired|log in again|re-?authenticate/i.test(msg) ||
    // Invalid model errors
    /model.*not.*found|invalid.*model|unknown.*model|does.*not.*exist/i.test(msg) ||
    // Decommissioned / deprecated / retired models (permanent provider-side 400s)
    /decommissioned|no longer supported|deprecated.*model|model.*deprecated|model.*retired/i.test(
      msg
    ) ||
    // Account/billing issues
    /insufficient.*quota|billing|payment.*required|account.*suspended/i.test(msg) ||
    // Malformed request (won't succeed on retry)
    /invalid.*request|malformed|bad.*request/i.test(msg)
  );
}

/**
 * Detect transient errors that may succeed on retry.
 * Includes rate limits, server errors, and network issues.
 */
export function isRetryableError(msg: string): boolean {
  return (
    // Rate limiting
    /\b429\b|rate.*limit|too.*many.*requests|quota.*exceeded/i.test(msg) ||
    // Server errors (5xx)
    /\b(500|502|503|504)\b|internal.*server|bad.*gateway|service.*unavailable|gateway.*timeout/i.test(
      msg
    ) ||
    // Network issues
    /network.*error|failed to fetch|connection.*refused|timeout|econnreset|socket.*hang.*up/i.test(
      msg
    ) ||
    // Temporary overload
    /overloaded|temporarily.*unavailable|try.*again/i.test(msg)
  );
}

/**
 * Sleep for `ms` milliseconds, resolving early when the given AbortSignal fires.
 * Returns `true` if the sleep was aborted, `false` if it completed normally.
 * Exposed for testing the retry loop's cooperative cancellation.
 */
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
