/**
 * `/api/fetch-proxy` forwards the upstream `content-length` as the
 * `X-Proxy-Content-Length` hint (webapp download progress) only when it is
 * exact — i.e. upstream sent an identity-encoded body.
 */
import { describe, expect, it } from 'vitest';
import {
  FETCH_PROXY_CONTENT_LENGTH_HEADER,
  FETCH_PROXY_SKIP_RESPONSE_HEADERS,
  FETCH_PROXY_SKIP_RESPONSE_PREFIXES,
} from '../src/fetch-proxy-headers.js';

describe('fetch-proxy content-length hint', () => {
  it('names a proxy-owned header that upstream can never spoof', () => {
    const lower = FETCH_PROXY_CONTENT_LENGTH_HEADER.toLowerCase();
    expect(FETCH_PROXY_SKIP_RESPONSE_PREFIXES.some((p) => lower.startsWith(p))).toBe(true);
    // The real content-length stays stripped: the scrub transform re-chunks.
    expect(FETCH_PROXY_SKIP_RESPONSE_HEADERS.has('content-length')).toBe(true);
  });
});
