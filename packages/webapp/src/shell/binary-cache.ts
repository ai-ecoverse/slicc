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

/**
 * Store binary data keyed directly by its latin1-encoded string body.
 * Called by createProxiedFetch when a binary response is received without a
 * URL to key on. The string body is used verbatim as the cache key, so
 * lookups are exact (no hashing, no collisions).
 */
export function cacheBinaryBody(latin1Body: string, bytes: Uint8Array): void {
  cache.set(latin1Body, bytes);
  // Auto-expire after 10s to prevent memory leaks if writeFile is never called
  setTimeout(() => cache.delete(latin1Body), 10_000);
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
 * Called by VfsAdapter.writeFile to bypass string encoding. Looks the body
 * up directly (exact key match) and consumes the entry on a hit.
 * Returns the original bytes if found, null otherwise.
 */
export function consumeCachedBinary(body: string): Uint8Array | null {
  const bytes = cache.get(body);
  if (bytes) {
    cache.delete(body);
    return bytes;
  }
  return null;
}
