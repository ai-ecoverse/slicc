import { describe, expect, it } from 'vitest';
import { isTextContentType } from '../src/content-type.js';

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
});
