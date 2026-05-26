/**
 * just-bash v3 boundary helpers.
 *
 * v3 typed `CommandContext.stdin` as `ByteString` (an opaque branded
 * latin1 byte buffer) instead of plain `string`. These adapters keep
 * 2.14.x behavior at every existing call site — text consumers UTF-8
 * decode on read and UTF-8 encode on write; binary-fidelity consumers
 * use the latin1 passthrough.
 *
 * The runtime helpers live in `just-bash/dist/encoding.js` but are NOT
 * re-exported from the package's `browser` entry (`dist/bundle/browser.js`
 * only ships the legacy 2.14.x surface). The brand is purely a TypeScript
 * marker — at runtime `ByteString` is a plain JS string whose chars are
 * latin1 bytes (`s.charCodeAt(i)` = byte 0–255), so we reimplement the
 * codec here using `TextEncoder` / `TextDecoder` and cast through
 * `unknown` to satisfy the brand.
 */

import type { ByteString } from 'just-bash';

export type { ByteString } from 'just-bash';

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const utf8Encoder = new TextEncoder();

/** Read a `CommandContext.stdin` as UTF-8 text. */
export function stdinAsText(b: ByteString): string {
  const raw = b as unknown as string;
  if (raw.length === 0) return '';
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
  return utf8Decoder.decode(bytes);
}

/**
 * Read a `CommandContext.stdin` as a latin1 string (1 char per byte).
 *
 * Use this when downstream code needs byte-for-byte fidelity for
 * arbitrary binary input — e.g. forwarding piped bytes into a `.jsh`
 * realm where user code may inspect raw byte values via `charCodeAt`.
 * At runtime `ByteString` already IS a latin1 string, so this is a cast.
 */
export function stdinAsLatin1(b: ByteString): string {
  return b as unknown as string;
}

/** Build a `CommandContext.stdin` `ByteString` from UTF-8 text. */
export function textAsStdin(s: string): ByteString {
  if (s.length === 0) return EMPTY_BYTES;
  const bytes = utf8Encoder.encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out as unknown as ByteString;
}

/** The empty `ByteString` (no-stdin sentinel for `CommandContext`). */
export const EMPTY_BYTES: ByteString = '' as unknown as ByteString;
