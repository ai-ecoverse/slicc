import { describe, expect, it } from 'vitest';
import {
  decodeForbiddenRequestHeaders,
  decodeForbiddenResponseHeaders,
  encodeForbiddenRequestHeaders,
  headersToRecord,
  normalizeHeadersInit,
} from '../src/proxy-headers.js';

describe('encodeForbiddenRequestHeaders', () => {
  it('encodes cookie, origin, referer, and proxy-* to X-Proxy-* names', () => {
    expect(
      encodeForbiddenRequestHeaders({
        Cookie: 'a=1',
        Origin: 'https://example.com',
        Referer: 'https://example.com/page',
        'Proxy-Authorization': 'Basic xyz',
        'X-Other': 'kept',
      })
    ).toEqual({
      'X-Proxy-Cookie': 'a=1',
      'X-Proxy-Origin': 'https://example.com',
      'X-Proxy-Referer': 'https://example.com/page',
      'X-Proxy-Proxy-Authorization': 'Basic xyz',
      'X-Other': 'kept',
    });
  });

  it('is case-insensitive on the source header name', () => {
    expect(encodeForbiddenRequestHeaders({ cOOkie: 'v' })).toEqual({ 'X-Proxy-Cookie': 'v' });
  });

  it('returns {} for undefined input', () => {
    expect(encodeForbiddenRequestHeaders(undefined)).toEqual({});
  });
});

describe('decodeForbiddenRequestHeaders', () => {
  it('decodes X-Proxy-* transport names back to real lowercase names', () => {
    expect(
      decodeForbiddenRequestHeaders({
        'X-Proxy-Cookie': 'a=1',
        'X-Proxy-Origin': 'https://example.com',
        'X-Proxy-Referer': 'https://example.com/page',
        'X-Proxy-Proxy-Authorization': 'Basic xyz',
        'X-Other': 'kept',
      })
    ).toEqual({
      cookie: 'a=1',
      origin: 'https://example.com',
      referer: 'https://example.com/page',
      'proxy-authorization': 'Basic xyz',
      'X-Other': 'kept',
    });
  });

  it('is case-insensitive on the X-Proxy- prefix', () => {
    expect(decodeForbiddenRequestHeaders({ 'x-proxy-cookie': 'v' })).toEqual({ cookie: 'v' });
  });

  it('round-trips through encode', () => {
    const original = { Cookie: 'a=1', 'Proxy-Foo': 'bar' };
    const decoded = decodeForbiddenRequestHeaders(encodeForbiddenRequestHeaders(original));
    expect(decoded).toEqual({ cookie: 'a=1', 'proxy-foo': 'bar' });
  });
});

describe('decodeForbiddenResponseHeaders', () => {
  it('decodes X-Proxy-Set-Cookie to set-cookie', () => {
    expect(
      decodeForbiddenResponseHeaders({
        'X-Proxy-Set-Cookie': '["a=1","b=2"]',
        'Content-Type': 'text/html',
      })
    ).toEqual({
      'set-cookie': '["a=1","b=2"]',
      'Content-Type': 'text/html',
    });
  });

  it('leaves unrelated headers untouched', () => {
    expect(decodeForbiddenResponseHeaders({ 'Content-Type': 'text/html' })).toEqual({
      'Content-Type': 'text/html',
    });
  });
});

describe('headersToRecord', () => {
  it('converts a Headers instance to a plain record', () => {
    const h = new Headers();
    h.set('X-A', '1');
    h.set('X-B', '2');
    expect(headersToRecord(h)).toEqual({ 'x-a': '1', 'x-b': '2' });
  });

  it('passes a plain record through unchanged', () => {
    expect(headersToRecord({ 'X-A': '1' })).toEqual({ 'X-A': '1' });
  });

  it('returns undefined for undefined input', () => {
    expect(headersToRecord(undefined)).toBeUndefined();
  });
});

describe('normalizeHeadersInit', () => {
  it('converts a Headers instance to a plain record', () => {
    const h = new Headers();
    h.set('X-A', '1');
    expect(normalizeHeadersInit(h)).toEqual({ 'x-a': '1' });
  });

  it('converts an array of tuples to a plain record', () => {
    expect(
      normalizeHeadersInit([
        ['X-A', '1'],
        ['X-B', '2'],
      ])
    ).toEqual({ 'X-A': '1', 'X-B': '2' });
  });

  it('passes a plain record through as a shallow copy', () => {
    const input = { 'X-A': '1' };
    const result = normalizeHeadersInit(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it('returns undefined for undefined input', () => {
    expect(normalizeHeadersInit(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty Headers instance (no empty-object leak)', () => {
    expect(normalizeHeadersInit(new Headers())).toBeUndefined();
  });

  it('returns undefined for an empty array', () => {
    expect(normalizeHeadersInit([])).toBeUndefined();
  });

  it('returns undefined for an empty record', () => {
    expect(normalizeHeadersInit({})).toBeUndefined();
  });
});
