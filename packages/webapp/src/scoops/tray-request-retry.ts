/**
 * Bounded retry for the leader's tray-hub HTTP calls (#4112).
 *
 * `POST /tray` answers 503 when the tray Durable Object or the webhook-home
 * bind is briefly unavailable. Both responses say "retry with the same
 * createAttemptId", and the hub replays a repeated attempt to the same tray,
 * so retrying is safe. A single attempt left a hosted leader idle until
 * start-leader's boot timeout; this retries 5xx, 429 and transport failures
 * with jittered exponential backoff until a deadline, and never retries any
 * other 4xx.
 */

import { createLogger } from '../base/logger.js';

const log = createLogger('tray-leader');

export const TRAY_REQUEST_RETRY_DEADLINE_MS = 90_000;
export const TRAY_REQUEST_RETRY_BASE_DELAY_MS = 1_000;
export const TRAY_REQUEST_RETRY_MAX_DELAY_MS = 15_000;

export interface TrayRequestRetryOptions {
  /** Total budget across attempts and waits, in ms. Default: 90000. */
  deadlineMs?: number;
  /** Backoff before the second attempt, in ms. Doubles per attempt. Default: 1000. */
  baseDelayMs?: number;
  /** Cap on one backoff wait (before `Retry-After`), in ms. Default: 15000. */
  maxDelayMs?: number;
  /** Sleep implementation for testing. Default: setTimeout-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for testing. Default: `Date.now`. */
  now?: () => number;
  /** Jitter source in [0, 1) for testing. Default: `Math.random`. */
  random?: () => number;
}

/** What a failed attempt tells the retry loop. */
export interface TrayRequestFailure {
  retryable: boolean;
  /** Server-requested wait from `Retry-After`, if any. */
  retryAfterMs?: number;
  /** Short description for logs and the final error, e.g. `503 WEBHOOK_HOME_BIND_FAILED`. */
  detail: string;
}

/** The final failure after the budget is spent. Carries the last attempt's error. */
export class TrayRequestRetryExhaustedError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastError: unknown
  ) {
    super(message);
    this.name = 'TrayRequestRetryExhaustedError';
  }
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) into ms; null when absent or unusable. */
export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/** Equal-jitter exponential backoff: half fixed, half random, capped. */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export interface ResolvedTrayRequestRetry {
  deadlineMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
}

export function resolveTrayRequestRetry(
  options: TrayRequestRetryOptions | undefined
): ResolvedTrayRequestRetry {
  return {
    deadlineMs: options?.deadlineMs ?? TRAY_REQUEST_RETRY_DEADLINE_MS,
    baseDelayMs: options?.baseDelayMs ?? TRAY_REQUEST_RETRY_BASE_DELAY_MS,
    maxDelayMs: options?.maxDelayMs ?? TRAY_REQUEST_RETRY_MAX_DELAY_MS,
    sleep: options?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: options?.now ?? (() => Date.now()),
    random: options?.random ?? Math.random,
  };
}

export interface RetryTrayRequestArgs<T> {
  /** Log and error label, e.g. `POST /tray`. */
  label: string;
  /** Absolute deadline (`now()` scale). Shared by calls that make up one step. */
  deadlineAt: number;
  retry: ResolvedTrayRequestRetry;
  /** One attempt; receives the ms left so it can bound its own timeout. */
  attempt: (remainingMs: number) => Promise<T>;
  classify: (error: unknown) => TrayRequestFailure;
  /** Checked before every wait and attempt; a true result abandons the loop. */
  cancelled?: () => boolean;
}

/**
 * Run `attempt` until it succeeds, fails with a non-retryable error (rethrown
 * as is), or the deadline leaves no room for the next wait. Every attempt is
 * logged; the final failure names the attempt count and the last cause.
 */
export async function retryTrayRequest<T>(args: RetryTrayRequestArgs<T>): Promise<T> {
  const { label, deadlineAt, retry } = args;
  const startedAt = retry.now();
  for (let attempt = 1; ; attempt++) {
    if (args.cancelled?.()) throw new Error(`${label} cancelled: tray leader stopped`);
    log.info('Tray request attempt', { label, attempt });
    try {
      return await args.attempt(Math.max(1, deadlineAt - retry.now()));
    } catch (error) {
      const failure = args.classify(error);
      if (!failure.retryable) throw error;
      const backoff = backoffDelayMs(attempt, retry.baseDelayMs, retry.maxDelayMs, retry.random);
      const waitMs = Math.max(backoff, failure.retryAfterMs ?? 0);
      const remainingMs = deadlineAt - retry.now();
      if (waitMs >= remainingMs) {
        const elapsedS = Math.round((retry.now() - startedAt) / 1000);
        const message = `${label} failed after ${attempt} attempt${attempt === 1 ? '' : 's'} in ${elapsedS}s: ${failure.detail}`;
        log.error('Tray request retries exhausted', { label, attempt, detail: failure.detail });
        throw new TrayRequestRetryExhaustedError(message, attempt, error);
      }
      log.warn('Tray request failed; retrying', {
        label,
        attempt,
        detail: failure.detail,
        waitMs,
      });
      await retry.sleep(waitMs);
    }
  }
}
