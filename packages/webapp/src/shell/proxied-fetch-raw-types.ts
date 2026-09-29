/**
 * The eager surface of the proxied fetch's raw mode (#3571): types, the error
 * class and the float probe. The transport (`proxied-fetch-raw.ts`) loads
 * lazily, so `proxied-fetch.ts` imports only this module and keeps raw mode
 * out of the boot graph.
 */

import type { RawFetchResponseHead, RawHeaderList } from '@slicc/shared-ts';
import { getChromeExtensionRealm, getExtensionDelegateId } from '../base/api-endpoint.js';

export type { RawHeaderList } from '@slicc/shared-ts';

/** A raw-mode request. */
export interface RawFetchInit {
  method?: string;
  /** Ordered; repeats are folded as `fetch` would (`Cookie` with `; `). */
  headers?: RawHeaderList;
  body?: Uint8Array | Blob | ReadableStream<Uint8Array>;
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

export type RawFetchErrorCode =
  /** The float has no raw mode (extension, or a bridge that predates it). */
  | 'unsupported'
  /** The request body is past {@link RawFetchCapabilities.maxRequestBodyBytes}. */
  | 'request-body-too-large'
  /** A masked secret was used against a domain it is not scoped to. */
  | 'forbidden-secret'
  /** The upstream could not be reached, or the stream broke. */
  | 'upstream'
  /** The bridge answered with something raw mode cannot read. */
  | 'bridge';

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
