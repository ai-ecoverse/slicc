/**
 * `realm-device-shared.ts` — the minimal RPC surface and byte/filter helpers
 * shared by the WebUSB / Web Serial / WebHID realm bridges. Extracted from
 * `js-realm-shared.ts`; no behavior change.
 */
import type { RealmRpcChannel } from './realm-types.js';

/**
 * Minimal RPC surface the device bridges need. A structural slice of
 * `RealmRpcClient` so tests can inject a recording mock without booting
 * a worker / port pair. `onEvent` is optional so existing callers that
 * predate the device-event channel still type-check; the HID device
 * surface degrades to no-op event delivery when it's missing (the
 * registration succeeds, but no host pushes can land).
 */
export interface DeviceRpc {
  call<T = unknown>(channel: RealmRpcChannel, op: string, args?: unknown[]): Promise<T>;
  onEvent?(channel: string, handler: (payload: unknown) => void): () => void;
}

/** Binary payloads cross the bridge as `Uint8Array`; coerce any view. */
export function toRealmBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('expected an ArrayBuffer or typed array');
}

/** Wrap returned bytes as a `DataView`, mirroring the browser device APIs. */
export function bytesToDataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Accept a single filter object or an array; normalize to an array. */
export function asFilterArray<T>(filters: T | T[] | undefined): T[] {
  if (filters === undefined || filters === null) return [];
  return Array.isArray(filters) ? filters : [filters];
}

/** Host-side in/out transfer result shapes (pre-DataView wrapping). */
export interface WireInResult {
  status: string;
  bytes: Uint8Array;
}
export interface WireOutResult {
  status: string;
  bytesWritten: number;
}
