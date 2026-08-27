/**
 * Tests for the base64 verification half.
 *
 * `null` is the interesting answer here, not the happy path: returning it is
 * what keeps a run of characters that merely LOOKS like base64 from being
 * elided out of somebody's message.
 */

import { uint8ToBase64 } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import { identifyBase64 } from '../../src/core/base64-payload.js';

function b64(bytes: number[]): string {
  return uint8ToBase64(Uint8Array.from(bytes));
}

function b64Text(text: string): string {
  return uint8ToBase64(new TextEncoder().encode(text));
}

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('identifyBase64', () => {
  it('identifies a payload from its magic bytes', () => {
    const payload = identifyBase64(b64([...PNG_HEADER, 1, 2, 3, 4]));
    expect(payload?.mime).toBe('image/png');
    expect(payload?.source).toBe('magic');
    expect(payload?.text).toBe(false);
    expect(payload?.name).toBe('payload.png');
  });

  it('prefers magic bytes over a data: URL that says otherwise', () => {
    // A `data:` URL is the author's claim about their own payload; the bytes
    // are proof. A mislabeled PNG must not preview as prose.
    const payload = identifyBase64(b64([...PNG_HEADER, 9, 9, 9, 9]), 'text/plain');
    expect(payload?.mime).toBe('image/png');
    expect(payload?.source).toBe('magic');
  });

  it('falls back to a declared MIME type when nothing is proven', () => {
    const payload = identifyBase64(b64Text('{"a":1}'), 'application/json');
    expect(payload?.mime).toBe('application/json');
    expect(payload?.source).toBe('declared');
    expect(payload?.text).toBe(true);
    expect(payload?.name).toBe('payload.json');
  });

  it('ignores a declared type parameter list', () => {
    const payload = identifyBase64(b64Text('hello'), 'text/plain;charset=utf-8');
    expect(payload?.mime).toBe('text/plain');
  });

  it('does not trust a declared application/octet-stream', () => {
    // That is not a claim, it is the absence of one — so the bytes still get
    // the last word.
    const payload = identifyBase64(b64Text('plain prose'), 'application/octet-stream');
    expect(payload?.mime).toBe('text/plain');
    expect(payload?.source).toBe('content');
  });

  it('identifies unlabelled readable bytes as text', () => {
    const payload = identifyBase64(b64Text('the quick brown fox'));
    expect(payload?.mime).toBe('text/plain');
    expect(payload?.source).toBe('content');
    expect(payload?.text).toBe(true);
    expect(payload?.name).toBe('payload.txt');
  });

  it('refuses bytes that are neither a known format nor readable', () => {
    // What a hex digest or a random id decodes to: no signature, nobody
    // claiming anything, and not valid UTF-8.
    expect(identifyBase64(b64([0x00, 0xff, 0xfe, 0x01, 0x80, 0x81, 0x82, 0x83]))).toBeNull();
  });

  it('refuses an empty payload', () => {
    expect(identifyBase64('')).toBeNull();
  });

  it('refuses a string that is not base64 at all', () => {
    expect(identifyBase64('not base64 !!')).toBeNull();
  });

  it('names a payload whose type has no known extension without one', () => {
    const payload = identifyBase64(b64([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]));
    expect(payload?.mime).toBe('application/zip');
    expect(payload?.name).toBe('payload');
  });
});
