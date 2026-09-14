const cache = new Map<string, Uint8Array>();
const urlCache = new Map<string, Uint8Array>();

export function cacheBinaryBody(latin1Body: string, bytes: Uint8Array): void {
  cache.set(latin1Body, bytes);

  setTimeout(() => cache.delete(latin1Body), 10_000);
}

export function cacheBinaryByUrl(url: string, bytes: Uint8Array): void {
  urlCache.set(url, bytes);

  setTimeout(() => urlCache.delete(url), 10_000);
}

export function consumeCachedBinaryByUrl(url: string): Uint8Array | null {
  const bytes = urlCache.get(url);
  if (bytes) {
    urlCache.delete(url);
    return bytes;
  }
  return null;
}

export function consumeCachedBinary(body: string): Uint8Array | null {
  const bytes = cache.get(body);
  if (bytes) {
    cache.delete(body);
    return bytes;
  }
  return null;
}
