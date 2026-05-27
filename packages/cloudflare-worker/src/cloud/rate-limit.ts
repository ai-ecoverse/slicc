interface Bucket {
  tokens: number;
  lastRefill: number;
}

interface Limit {
  refillPerSec: number;
  capacity: number;
}

const LIMITS: Record<string, Limit> = {
  start: { refillPerSec: 30 / 3600, capacity: 30 },
  list: { refillPerSec: 60 / 60, capacity: 60 },
  pause: { refillPerSec: 60 / 60, capacity: 60 },
  resume: { refillPerSec: 30 / 3600, capacity: 30 },
  kill: { refillPerSec: 60 / 60, capacity: 60 },
};

const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  userId: string,
  op: string
): { ok: true } | { ok: false; retryAfterSec: number } {
  const limit = LIMITS[op];
  if (!limit) return { ok: true };
  const key = `${userId}:${op}`;
  const now = Date.now() / 1000;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: limit.capacity, lastRefill: now };
    buckets.set(key, b);
  }
  const elapsed = now - b.lastRefill;
  b.tokens = Math.min(limit.capacity, b.tokens + elapsed * limit.refillPerSec);
  b.lastRefill = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true };
  }
  return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / limit.refillPerSec) };
}

export function clearAll(): void {
  buckets.clear();
}
