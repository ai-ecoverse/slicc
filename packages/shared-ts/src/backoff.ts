export interface BackoffOptions {
  attempt: number;

  baseMs: number;

  capMs?: number;

  jitter?: number;

  maxShift?: number;

  random?: () => number;
}

export function nextBackoffDelayMs({
  attempt,
  baseMs,
  capMs,
  jitter = 0,
  maxShift,
  random = Math.random,
}: BackoffOptions): number {
  let shift = Math.max(0, attempt);
  if (maxShift !== undefined) shift = Math.min(shift, maxShift);
  const exp = baseMs * 2 ** shift;
  const capped = capMs === undefined ? exp : Math.min(capMs, exp);
  if (jitter <= 0) return capped;
  const withJitter = capped + Math.round(capped * jitter * random());
  return capMs === undefined ? withJitter : Math.min(capMs, withJitter);
}
