/**
 * Shared binary data cache for preserving byte fidelity through
 * just-bash's string-typed FetchResult.body pipeline.
 *
 * Problem: just-bash's SecureFetch returns { body: string }, and curl
 * writes that string via fs.writeFile(). Any string encoding (UTF-8,
 * latin1, etc.) can corrupt binary data.
 *
 * Solution: createProxiedFetch stores the raw Uint8Array here when it
 * detects binary content. VfsAdapter.writeFile checks this cache and
 * writes the original bytes directly, bypassing string encoding entirely.
 */

const cache = new Map<string, Uint8Array>();
const urlCache = new Map<string, Uint8Array>();

/** Generate a cache key from a string's length and a few sample bytes. */
function cacheKey(s: string): string {
  // Use length + 8 sample chars for fast (but imperfect) key generation.
  // Collisions are acceptable — the cache is short-lived and entries are
  // consumed immediately after the next writeFile call.
  const len = s.length;
  if (len === 0) return '0';
  const a = s.charCodeAt(0);
  const b = len > 1 ? s.charCodeAt(1) : 0;
  const c = len > 2 ? s.charCodeAt(2) : 0;
  const d = len > 3 ? s.charCodeAt(3) : 0;
  const e = len > 4 ? s.charCodeAt(Math.floor(len / 4)) : 0;
  const f = len > 4 ? s.charCodeAt(Math.floor(len / 2)) : 0;
  const g = len > 4 ? s.charCodeAt(Math.floor(3 * len / 4)) : 0;
  const h = s.charCodeAt(len - 1);
  return `${len}:${a}:${b}:${c}:${d}:${e}:${f}:${g}:${h}`;
}

/**
 * Store binary data associated with a latin1-encoded string body.
 * Called by createProxiedFetch when a binary response is received.
 */
export function cacheBinaryBody(latin1Body: string, bytes: Uint8Array): void {
  const key = cacheKey(latin1Body);
  cache.set(key, bytes);
  // Auto-expire after 10s to prevent memory leaks if writeFile is never called
  setTimeout(() => cache.delete(key), 10_000);
}

/**
 * Store binary data associated with a URL (for direct retrieval by URL).
 * Called by createProxiedFetch when a binary response is received.
 */
export function cacheBinaryByUrl(url: string, bytes: Uint8Array): void {
  urlCache.set(url, bytes);
  // Auto-expire after 10s
  setTimeout(() => urlCache.delete(url), 10_000);
}

/**
 * Try to retrieve cached binary data by URL.
 * Called by upskill and other commands that need raw binary data.
 * Returns the original bytes if found, null otherwise.
 */
export function consumeCachedBinaryByUrl(url: string): Uint8Array | null {
  const bytes = urlCache.get(url);
  if (bytes) {
    urlCache.delete(url);
    return bytes;
  }
  return null;
}

/**
 * Try to retrieve cached binary data for a string body.
 * Called by VfsAdapter.writeFile to bypass string encoding.
 * Returns the original bytes if found, null otherwise.
 */
export function consumeCachedBinary(body: string): Uint8Array | null {
  const key = cacheKey(body);
  const bytes = cache.get(key);
  if (bytes) {
    cache.delete(key);
    return bytes;
  }
  return null;
}
