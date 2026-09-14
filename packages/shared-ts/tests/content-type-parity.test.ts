import { describe, expect, it } from 'vitest';
import { isTextContentType } from '../src/content-type.js';

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

  ['application/x-www-form-urlencoded', false],
];

describe('cross-implementation response content-type table', () => {
  it.each(RESPONSE_CONTENT_TYPE_TABLE)('isTextContentType(%j) is %s', (contentType, isText) => {
    expect(isTextContentType(contentType)).toBe(isText);
  });
});
