import { describe, expect, it } from 'vitest';
import { isTextContentType, isTextRequestContentType } from '../src/content-type.js';

describe('isTextContentType', () => {
  it.each([
    'text/plain',
    'application/json',
    'application/xml',
    'image/svg+xml',
    'application/javascript',
    'application/ecmascript',
    'text/html',
    'text/css',
  ])('classifies %j as text', (contentType) => {
    expect(isTextContentType(contentType)).toBe(true);
  });

  it.each(['', 'application/octet-stream', 'application/pdf', 'image/png', 'video/mp4'])(
    'classifies %s as binary',
    (contentType) => {
      expect(isTextContentType(contentType)).toBe(false);
    }
  );

  it('does not classify a form body as text (response scrub / body cache path)', () => {
    expect(isTextContentType('application/x-www-form-urlencoded')).toBe(false);
  });
});

describe('isTextRequestContentType', () => {
  it.each([
    'application/x-www-form-urlencoded',
    'application/x-www-form-urlencoded;charset=UTF-8',
    'Application/X-WWW-Form-Urlencoded',
  ])('classifies %j as text so form secrets get unmasked', (contentType) => {
    expect(isTextRequestContentType(contentType)).toBe(true);
  });

  it('still accepts everything the plain predicate accepts', () => {
    for (const contentType of ['text/plain', 'application/json', 'image/svg+xml', 'text/css']) {
      expect(isTextRequestContentType(contentType)).toBe(true);
    }
  });

  it.each(['', 'image/jpeg', 'application/octet-stream', 'multipart/form-data; boundary=x'])(
    'classifies %j as binary',
    (contentType) => {
      expect(isTextRequestContentType(contentType)).toBe(false);
    }
  );
});
