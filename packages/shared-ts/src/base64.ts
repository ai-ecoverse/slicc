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

// Strict base64 grammar (no URL-safe variants — matches `atob`). Used to
// gate Node's lenient `Buffer.from('base64')` so a malformed input throws
// here instead of being silently stripped: the signed-fetch transport
// surfaces a malformed reply as a clean "decode failed" EIO and relies
// on the decoder being strict.
//
// Alphabet alone is not enough — `Buffer.from('abcde', 'base64')` and
// `Buffer.from('abcd=', 'base64')` both decode successfully (and silently
// drop or pad the trailing junk), while `atob` throws. Enforce the full
// shape: a run of 4-char groups, optionally followed by one final group
// of 2+`==`, 3+`=`, or 4 alphabet chars. Empty string is valid.
const STRICT_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})?$/;

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
 *   - the Node path validates against {@link STRICT_BASE64_RE} first and
 *     throws on invalid input. `atob` already throws; `Buffer.from`
 *     silently strips invalid characters, which would let bad payloads
 *     through callers that rely on the decoder rejecting them.
 */
export function base64ToUint8(b64: string): Uint8Array<ArrayBuffer> {
  const B = nodeBuffer();
  if (B) {
    if (!STRICT_BASE64_RE.test(b64)) {
      throw new Error('Invalid base64 string');
    }
    return new Uint8Array(B.from(b64, 'base64'));
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
