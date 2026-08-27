// Universal Uint8Array ↔ base64 codec.
//
// One implementation shared across the browser, the extension service
// worker, and Node 22+ — same correctness, same chunk size, same Node
// fast-path. Replaces 13+ hand-rolled copies that had drifted on chunk
// size (8192 vs 0x8000) and on whether they used `Buffer` at all; see
// the inventory in issue #1087.
//
// Conforms to `packages/shared-ts/CLAUDE.md` "universal globals" rule:
// `atob` / `btoa` are global in every runtime we target; the Node
// `Buffer` fast-path is feature-detected via `globalThis` and the
// structural type is declared locally so this package keeps building
// without `@types/node` (the same pattern `sign-and-forward.ts` uses).

// `0x8000` (32 KiB) matches the chunk size in
// `kernel/transport-binary-codec.ts` and the rationale comment there:
// the naive `String.fromCharCode(...bytes)` overflows the call stack on
// inputs larger than ~64 KiB; chunking keeps the worst case bounded.
const CHUNK_SIZE = 0x8000;

// Structural view of the bits of Node's `Buffer` constructor we use.
// Declared locally so this package never depends on `@types/node` and
// the global is reached via `globalThis` so a bare `Buffer` reference
// never has to resolve at compile time. `Buffer.from(string, 'base64')`
// returns a `Buffer` (Uint8Array subclass); the decode path copies it
// into a plain `Uint8Array` before returning — see `base64ToUint8`.
interface NodeBufferCtor {
  from(input: string, encoding: 'base64'): Uint8Array;
  from(input: Uint8Array): { toString(encoding: 'base64'): string };
}

function nodeBuffer(): NodeBufferCtor | undefined {
  return (globalThis as { Buffer?: NodeBufferCtor }).Buffer;
}

// `atob`-compatible base64 grammar: padding OPTIONAL, a trailing group of
// 2 or 3 alphabet characters accepted unpadded, a remainder of 1 rejected.
// No URL-safe variants — `atob` does not accept them either.
//
// Used to gate Node's lenient `Buffer.from('base64')` so a malformed input
// throws here instead of being silently stripped: the signed-fetch transport
// surfaces a malformed reply as a clean "decode failed" EIO and relies on the
// decoder rejecting it.
//
// Alphabet alone is not enough — `Buffer.from('abcde', 'base64')` and
// `Buffer.from('abcd=', 'base64')` both decode successfully (and silently
// drop or pad the trailing junk), while `atob` throws. So the full shape is
// enforced: a run of 4-char groups, optionally followed by a final group of
// 2 (+`==`), 3 (+`=`), or 4 alphabet characters. Empty string is valid.
//
// The grammar describes what `atob` ACCEPTS rather than the padded form,
// because the two paths must agree: `atob` infers missing padding, so a
// stricter Node path would make the same string decode in the browser and
// throw under Node.
const ATOB_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

// The whitespace `atob` ignores, and that base64 producers insert to wrap
// long payloads at a column limit (`base64`(1) wraps at 76 by default).
const BASE64_WHITESPACE_RE = /[\t\n\f\r ]/g;

/**
 * Strip the whitespace out of `b64` and confirm the rest is decodable
 * base64, returning the compacted string — or `null` if it is not base64.
 *
 * The single place that answers "is this string a base64 payload?". The
 * `<img:data:…>` marker classifier and the transcript's base64 preview both
 * gate on it, so a payload one of them decodes is a payload the other
 * recognizes. The result is safe to hand to {@link base64ToUint8} in any
 * runtime; padding is left exactly as the caller wrote it, since restoring
 * it would rewrite payloads that are round-tripped back into `data:` URLs.
 *
 * URL-safe base64 (`-` / `_`) is not accepted, matching `atob`.
 */
export function normalizeBase64(b64: string): string | null {
  const compact = b64.replace(BASE64_WHITESPACE_RE, '');
  return ATOB_BASE64_RE.test(compact) ? compact : null;
}

/** Restore the padding `atob` would have inferred, for decoders that will not. */
function padded(b64: string): string {
  const remainder = b64.length % 4;
  return remainder === 0 ? b64 : b64 + '='.repeat(4 - remainder);
}

/**
 * Decode a base64 string to `Uint8Array`.
 *
 * Prefers Node's `Buffer.from(b64, 'base64')` when available — measurably
 * faster than the per-byte `atob` loop for the multi-MB S3 mount and
 * federated-VFS payloads the CLI float moves. The browser / extension
 * service-worker fallback round-trips through `atob`, which is a
 * universal global.
 *
 * Two normalizations bridge the platform gap so both paths are
 * observationally identical:
 *   - the Node path copies the `Buffer` into a fresh `Uint8Array` so the
 *     caller gets a plain prototype backed by a standalone `ArrayBuffer`
 *     (not Node's slab pool, which `Buffer.from` draws from for small
 *     inputs) — callers that read `.buffer` downstream and tests that
 *     deep-equal the bytes both need this;
 *   - the Node path validates against the same grammar `atob` implements
 *     ({@link normalizeBase64}) and throws on invalid input, then restores
 *     the padding `atob` would have inferred. `atob` already throws;
 *     `Buffer.from` silently strips invalid characters and silently refuses
 *     an unpadded tail, either of which would make the same payload behave
 *     differently depending on the runtime it landed in.
 */
export function base64ToUint8(b64: string): Uint8Array<ArrayBuffer> {
  const B = nodeBuffer();
  if (B) {
    const normalized = normalizeBase64(b64);
    if (normalized === null) throw new Error('Invalid base64 string');
    // `Buffer.from` will not infer the padding `atob` infers, so it is
    // restored here rather than being demanded of the caller — otherwise the
    // same unpadded payload decodes in the browser and throws under Node.
    return new Uint8Array(B.from(padded(normalized), 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode a `Uint8Array` to a base64 string.
 *
 * Prefers Node's `Buffer.from(bytes).toString('base64')` when available.
 * Otherwise builds the binary string in {@link CHUNK_SIZE}-byte chunks
 * through `String.fromCharCode.apply` — the unchunked spread overflows
 * the call stack on inputs larger than ~64 KiB.
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  const B = nodeBuffer();
  if (B) {
    return B.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.byteLength));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}
