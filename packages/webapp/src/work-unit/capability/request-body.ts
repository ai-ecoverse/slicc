import { base64ToUint8, isTextContentType } from '@slicc/shared-ts';
import { getFetchBodyBytes } from '../../shell/fetch-body.js';
import type { NetworkFetchRequest } from './types.js';

const BODILESS_METHODS = new Set(['GET', 'HEAD']);

export function capabilityRequestBytes(request: NetworkFetchRequest): Uint8Array | undefined {
  const method = (request.method ?? 'GET').toUpperCase();
  if (request.body === undefined || BODILESS_METHODS.has(method)) return undefined;
  if (request.bodyEncoding === 'base64') return base64ToUint8(request.body);
  const contentType =
    Object.entries(request.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'content-type'
    )?.[1] ?? '';
  return contentType && !isTextContentType(contentType)
    ? getFetchBodyBytes(request.body)
    : new TextEncoder().encode(request.body);
}
