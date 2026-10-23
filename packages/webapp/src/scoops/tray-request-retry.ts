import { createLogger } from '../base/logger.js';

const log = createLogger('tray-leader');

export const TRAY_REQUEST_RETRY_DEADLINE_MS = 90_000;
export const TRAY_REQUEST_RETRY_BASE_DELAY_MS = 1_000;
export const TRAY_REQUEST_RETRY_MAX_DELAY_MS = 15_000;

export interface TrayRequestRetryOptions {
  deadlineMs?: number;

  baseDelayMs?: number;

  maxDelayMs?: number;

  sleep?: (ms: number) => Promise<void>;

  now?: () => number;

  random?: () => number;
}

export interface TrayRequestFailure {
  retryable: boolean;

  retryAfterMs?: number;

  detail: string;
}

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

export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

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
  label: string;

  deadlineAt: number;
  retry: ResolvedTrayRequestRetry;

  attempt: (remainingMs: number) => Promise<T>;
  classify: (error: unknown) => TrayRequestFailure;

  cancelled?: () => boolean;
}

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
