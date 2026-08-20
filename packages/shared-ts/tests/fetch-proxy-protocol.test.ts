import { describe, expect, expectTypeOf, it } from 'vitest';
import type { FetchProxyRequestMsg, FetchProxyResponseMsg } from '../src/fetch-proxy-protocol.js';

// The fetch-proxy request/response shapes are the wire contract spoken across
// the `@slicc/webapp` page/SW side and the `@slicc/chrome-extension` backend.
// They live here — in the platform-agnostic layer both packages already depend
// on — so neither package reaches *up* into the other for a duplicate copy
// (the cross-package cycle removed in this change). This test pins the shape so
// a drift is a deliberate, reviewed protocol change.
describe('fetch-proxy wire protocol', () => {
  it('pins the request discriminator and fields', () => {
    const req: FetchProxyRequestMsg = {
      type: 'request',
      url: 'https://example.com/v1',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      bodyBase64: 'e30=',
      requestBodyTooLarge: false,
    };
    expect(req.type).toBe('request');
    // Optional fields really are optional.
    const minimal: FetchProxyRequestMsg = {
      type: 'request',
      url: 'https://example.com',
      method: 'GET',
      headers: {},
    };
    expect(minimal.bodyBase64).toBeUndefined();
    expect(minimal.requestBodyTooLarge).toBeUndefined();
  });

  it('pins the four terminal-or-streaming response variants', () => {
    const head: FetchProxyResponseMsg = {
      type: 'response-head',
      status: 200,
      statusText: 'OK',
      headers: { 'x-proxy-set-cookie': '[]' },
    };
    const chunk: FetchProxyResponseMsg = { type: 'response-chunk', dataBase64: 'AAA=' };
    const end: FetchProxyResponseMsg = { type: 'response-end' };
    const error: FetchProxyResponseMsg = { type: 'response-error', error: 'boom' };
    expect([head.type, chunk.type, end.type, error.type]).toEqual([
      'response-head',
      'response-chunk',
      'response-end',
      'response-error',
    ]);
  });

  it('narrows the response union exhaustively on `type`', () => {
    const summarize = (msg: FetchProxyResponseMsg): string => {
      switch (msg.type) {
        case 'response-head':
          return `head ${msg.status}`;
        case 'response-chunk':
          return `chunk ${msg.dataBase64.length}`;
        case 'response-end':
          return 'end';
        case 'response-error':
          return `error ${msg.error}`;
        default: {
          // Compile-time exhaustiveness: a new variant makes this fail to build.
          const never: never = msg;
          return never;
        }
      }
    };
    expect(summarize({ type: 'response-end' })).toBe('end');
    expect(summarize({ type: 'response-error', error: 'x' })).toBe('error x');
  });

  it('keeps the request `type` literal narrow (not a bare string)', () => {
    expectTypeOf<FetchProxyRequestMsg['type']>().toEqualTypeOf<'request'>();
  });
});
