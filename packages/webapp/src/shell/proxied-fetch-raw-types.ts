import type { RawFetchErrorCode, RawFetchResponseHead, RawHeaderList } from '@slicc/shared-ts';
import { getChromeExtensionRealm, getExtensionDelegateId } from '../base/api-endpoint.js';

export type { RawFetchErrorCode, RawHeaderList } from '@slicc/shared-ts';

export interface RawFetchInit {
  method?: string;

  headers?: RawHeaderList;
  body?: Uint8Array | Blob | ReadableStream<Uint8Array>;

  bodyLength?: number;
  signal?: AbortSignal;
}

export interface RawFetchResponse extends RawFetchResponseHead {
  body: ReadableStream<Uint8Array> | null;
}

export type RawProxiedFetch = (url: string, init?: RawFetchInit) => Promise<RawFetchResponse>;

export interface RawFetchCapabilities {
  supported: boolean;

  requestBodyStreaming: boolean;

  maxRequestBodyBytes: number;
}

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

export function usesFetchProxyEndpoint(): boolean {
  if (getChromeExtensionRealm()) return false;
  if (!getExtensionDelegateId()) return true;
  if (typeof chrome === 'undefined') return false;
  return typeof chrome?.runtime?.connect !== 'function';
}
