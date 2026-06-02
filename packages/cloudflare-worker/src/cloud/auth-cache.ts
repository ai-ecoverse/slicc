import type { AuthResult } from './auth.js';

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { result: AuthResult; expiresAt: number }>();

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getCached(token: string): Promise<AuthResult | null> {
  const key = await hashToken(token);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

export async function setCached(
  token: string,
  result: AuthResult,
  tokenExpSec?: number
): Promise<void> {
  const key = await hashToken(token);
  const tokenTtlMs = tokenExpSec ? tokenExpSec * 1000 - Date.now() : TTL_MS;
  const ttl = Math.max(0, Math.min(TTL_MS, tokenTtlMs));
  cache.set(key, { result, expiresAt: Date.now() + ttl });
}

export async function invalidate(token: string): Promise<void> {
  cache.delete(await hashToken(token));
}

export function clearAll(): void {
  cache.clear();
}
