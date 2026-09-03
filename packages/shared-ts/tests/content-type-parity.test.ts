import { describe, expect, it } from 'vitest';
import { isTextContentType } from '../src/content-type.js';

/**
 * Pinned response-body text/binary classification table.
 *
 * The same table is pinned in
 * `packages/swift-server/Tests/CrossImplementationTests.swift`
 * (`testIsTextContentTypeMatchesPinnedTable`). `/api/fetch-proxy` scrubs real
 * secret values out of an upstream body only when the body is UTF-8 text, so
 * when the two floats disagree an `application/xml` reply hands the agent a
 * real secret on Sliccstart that the Node CLI masks (#2822).
 *
 * The `charset=` rows matter: swift-server used to treat any `charset=`
 * parameter as proof of text, which forced binary bodies through a lossy
 * `String` round-trip Node never performs.
 */
const RESPONSE_CONTENT_TYPE_TABLE: [contentType: string, isText: boolean][] = [
  ['text/plain', true],
  ['text/html', true],
  ['text/html; charset=utf-8', true],
  ['text/css', true],
  ['text/event-stream', true],
  ['application/json', true],
  ['application/json; charset=utf-8', true],
  ['application/xml', true],
  ['application/xhtml+xml', true],
  ['application/javascript', true],
  ['application/ecmascript', true],
  ['image/svg+xml', true],
  ['Application/JSON', true],
  ['', false],
  ['image/jpeg', false],
  ['image/png', false],
  ['application/octet-stream', false],
  ['application/octet-stream; charset=utf-8', false],
  ['application/pdf', false],
  ['application/zip', false],
  ['audio/mpeg', false],
  ['video/mp4', false],
  // Response-side only: a form body is not text here. The request hop has its
  // own predicate because form POSTs carry secrets that must unmask.
  ['application/x-www-form-urlencoded', false],
];

describe('cross-implementation response content-type table', () => {
  it.each(RESPONSE_CONTENT_TYPE_TABLE)('isTextContentType(%j) is %s', (contentType, isText) => {
    expect(isTextContentType(contentType)).toBe(isText);
  });
});
