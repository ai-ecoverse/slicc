/**
 * One canonical answer to "what bytes does this `NetworkFetchRequest` send?"
 * (#2276 slice B).
 *
 * Shared by both ops modules because the two transports reach `fetch` by
 * different routes and would otherwise disagree. They did: the REST leg handed
 * a `text` body straight to `fetch` (UTF-8), while the extension leg handed it
 * to `prepareRequestBody` (latin1 for a binary content type). The same
 * three-byte body `0x00 0x80 0xff` therefore went out as `00 c2 80 c3 bf` on
 * one adapter and `00 80 ff` on the other, and a `base64` body was
 * latin1-decoded as if it were text.
 *
 * The rule, in one place:
 *
 *   - `bodyEncoding: 'base64'` — decode the base64. The caller said bytes;
 *     the content type is irrelevant.
 *   - `bodyEncoding: 'text'` (the default) — follow `prepareRequestBody`:
 *     latin1 for a non-textual content type (the `SecureFetch` convention for
 *     threading binary through a `string` body), UTF-8 otherwise.
 */

import { base64ToUint8, isTextContentType } from '@slicc/shared-ts';
import { getFetchBodyBytes } from '../../shell/fetch-body.js';
import type { NetworkFetchRequest } from './types.js';

/** Methods that never carry a body, whatever the caller supplied. */
const BODILESS_METHODS = new Set(['GET', 'HEAD']);

/** The bytes a request sends, or `undefined` when it sends none. */
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
