/**
 * Binary-safe envelope codec for serializing transports.
 *
 * `chrome.runtime.sendMessage` uses JSON-serialization (not structured
 * clone) between extension contexts in practice, so a raw `Uint8Array`
 * on a message — e.g. the `data` field of a binary `vfs-write-file` /
 * `vfs-read-file-result` — arrives at the receiver as a plain object
 * (`{0: 0x65, 1: 0xef, …, length}`) which fails the host's
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

/** Envelope tree before binary encoding (may contain `Uint8Array`). */
type TransportInput =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | TransportInput[]
  | TransportInputObject;

type TransportInputObject = { [key: string]: TransportInput };

/** Envelope tree after binary encoding (bytes replaced by sentinels). */
type TransportWire =
  | null
  | boolean
  | number
  | string
  | EncodedBinary
  | TransportWire[]
  | TransportWireObject;

type TransportWireObject = { [key: string]: TransportWire };

function isEncodedBinary(value: unknown): value is EncodedBinary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as EncodedBinary;
  return candidate[BINARY_MARKER] === BINARY_KIND_B64 && typeof candidate.data === 'string';
}

function isTransportInputObject(value: unknown): value is TransportInputObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

function isTransportWireObject(value: unknown): value is TransportWireObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !isEncodedBinary(value)
  );
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
    return value.map(encodeBinaryForTransport) as TransportWire[];
  }
  if (isTransportInputObject(value)) {
    const out: TransportWireObject = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = encodeBinaryForTransport(v) as TransportWire;
    }
    return out;
  }
  return value as TransportWire;
}

/**
 * Inverse of {@link encodeBinaryForTransport}. Restores `Uint8Array`
 * instances from the sentinel shape. Values that don't match the
 * sentinel pass through unchanged so a transport that already
 * preserves binary (MessageChannel) is a no-op.
 */
export function decodeBinaryForTransport(value: unknown): unknown {
  if (isEncodedBinary(value)) return base64ToUint8(value.data);
  if (Array.isArray(value)) return value.map(decodeBinaryForTransport) as TransportInput[];
  if (isTransportWireObject(value)) {
    const out: TransportInputObject = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = decodeBinaryForTransport(v) as TransportInput;
    }
    return out;
  }
  return value as TransportInput;
}
