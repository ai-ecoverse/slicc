/**
 * Single-range `Range: bytes=…` parsing shared by every preview path: the
 * local `/preview/*` service worker, the tray leader answering a live
 * `serve` request, and the tray worker (old-leader fallback and `--ttl`
 * snapshots). One parser keeps the three answers to the same header equal.
 */

/** A resolved byte range, inclusive on both ends, clamped to the entity. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range: bytes=…` header against a known entity size.
 *
 * Returns `null` when the header is absent or is anything we do not serve
 * (multi-range, a non-`bytes` unit) — the caller then answers 200 with the
 * whole entity, which is always a valid response to a Range request.
 * Returns `'unsatisfiable'` for a syntactically valid range that falls outside
 * the entity, which owes a 416.
 *
 * Media elements need this: without a 206 path a `<video>` cannot seek, and
 * Safari in particular refuses to play a source that will not honour ranges.
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // `bytes=-N` — the final N bytes. N greater than the entity means the
    // whole entity, per RFC 9110.
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
