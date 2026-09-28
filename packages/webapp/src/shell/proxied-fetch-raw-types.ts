/**
 * The eager surface of the proxied fetch's raw mode (#3571): types, the error
 * class and the float probe. The transports (`proxied-fetch-raw.ts`,
 * `proxied-fetch-raw-port.ts`) load lazily, so `proxied-fetch.ts` and the
 * panel-RPC handler map import only this module and keep raw mode out of the
 * boot graph.
 */

import type { RawFetchErrorCode, RawFetchResponseHead, RawHeaderList } from '@slicc/shared-ts';
import { getChromeExtensionRealm, getExtensionDelegateId } from '../base/api-endpoint.js';

export type { RawFetchErrorCode, RawHeaderList } from '@slicc/shared-ts';

/** A raw-mode request. */
export interface RawFetchInit {
  method?: string;
  /** Ordered; repeats are folded as `fetch` would (`Cookie` with `; `). */
  headers?: RawHeaderList;
  body?: Uint8Array | Blob | ReadableStream<Uint8Array>;
  /** Size of a streamed `body` when known (the client's `Content-Length`). */
  bodyLength?: number;
  signal?: AbortSignal;
}

/** A raw-mode response. `body` is `null` when the response has none. */
export interface RawFetchResponse extends RawFetchResponseHead {
  body: ReadableStream<Uint8Array> | null;
}

export type RawProxiedFetch = (url: string, init?: RawFetchInit) => Promise<RawFetchResponse>;

/** What the current float's raw mode can do, for the realm proxy to plan by. */
export interface RawFetchCapabilities {
  supported: boolean;
  /** Whether a request body is streamed rather than buffered first. */
  requestBodyStreaming: boolean;
  /** Largest request body the float accepts. */
  maxRequestBodyBytes: number;
}

/**
 * A raw-mode failure that is not an upstream HTTP response. `status` is the
 * HTTP status a proxy should answer its own client with.
 */
export class RawFetchError extends Error {
  constructor(
    readonly code: RawFetchErrorCode,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'RawFetchError';
  }
}

/**
 * Whether this realm reaches the network through the bridge's
 * `/api/fetch-proxy` endpoint rather than an extension Port. Keep in step
 * with the branch order of `createProxiedFetch`.
 */
export function usesFetchProxyEndpoint(): boolean {
  if (getChromeExtensionRealm()) return false;
  if (!getExtensionDelegateId()) return true;
  if (typeof chrome === 'undefined') return false;
  return typeof chrome?.runtime?.connect !== 'function';
}
