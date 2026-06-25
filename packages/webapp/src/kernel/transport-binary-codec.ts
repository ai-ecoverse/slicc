/**
 * Binary-safe envelope codec for serializing transports.
 *
 * `chrome.runtime.sendMessage` uses JSON-serialization (not structured
 * clone) between extension contexts in practice, so a raw `Uint8Array`
 * on a message — e.g. the `data` field of a binary `vfs-write-file` /
 * `vfs-read-file-result` — arrives at the receiver as a plain object
 * (`{0: 0x65, 1: 0x66, …, length}`) which fails the host's
 * `instanceof Uint8Array` guard, and the OPFS binary read path collapses
 * the bytes to `[object Object]`. The `MessageChannel` adapter
 * structured-clones natively (and supports zero-copy transfer), so it
 * does not need this wrapper.
 *
 * This module walks an envelope tree once on send / receive and:
 *  - replaces each `Uint8Array` with a tagged sentinel
 *    (`{ __slicc_binary__: 'b64', data: <base64> }`)
 *  - restores the original `Uint8Array` on the receiver side.
 *
 * The walk is shallow for VFS envelopes (paths are 3–4 fields deep);
 * the only hot path is the `data` field of binary reads/writes, which
 * is base64-encoded once. Callers without any `Uint8Array` payload
 * (text writes, mkdir / rm / flush, success branches) round-trip
 * unchanged.
 */

import { base64ToUint8, uint8ToBase64 } from '@slicc/shared-ts';

const BINARY_MARKER = '__slicc_binary__';
const BINARY_KIND_B64 = 'b64';

interface EncodedBinary {
  [BINARY_MARKER]: typeof BINARY_KIND_B64;
  data: string;
}

function isEncodedBinary(value: unknown): value is EncodedBinary {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj[BINARY_MARKER] === BINARY_KIND_B64 && typeof obj.data === 'string';
}

/**
 * Encode any `Uint8Array` values nested inside `value` as base64
 * sentinels so the result survives JSON serialization. Plain values
 * pass through unchanged; arrays / objects are walked recursively.
 */
export function encodeBinaryForTransport(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    const encoded: EncodedBinary = { [BINARY_MARKER]: BINARY_KIND_B64, data: uint8ToBase64(value) };
    return encoded;
  }
  if (Array.isArray(value)) {
    return value.map(encodeBinaryForTransport);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = encodeBinaryForTransport(v);
    }
    return out;
  }
  return value;
}

/**
 * Inverse of {@link encodeBinaryForTransport}. Restores `Uint8Array`
 * instances from the sentinel shape. Values that don't match the
 * sentinel pass through unchanged so a transport that already
 * preserves binary (MessageChannel) is a no-op.
 */
export function decodeBinaryForTransport(value: unknown): unknown {
  if (isEncodedBinary(value)) return base64ToUint8(value.data);
  if (Array.isArray(value)) return value.map(decodeBinaryForTransport);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = decodeBinaryForTransport(v);
    }
    return out;
  }
  return value;
}
