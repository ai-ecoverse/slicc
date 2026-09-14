import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, isLoopbackOrigin } from '../src/loopback.js';

describe('isLoopbackHostname', () => {
  it('accepts localhost', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
  });

  it('accepts the full 127.0.0.0/8 block', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.0.0.2')).toBe(true);
    expect(isLoopbackHostname('127.255.255.255')).toBe(true);
  });

  it('accepts IPv6 loopback bracketed and bare', () => {
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
  });

  it('rejects empty, remote, and lookalike hosts', () => {
    expect(isLoopbackHostname('')).toBe(false);
    expect(isLoopbackHostname('www.sliccy.ai')).toBe(false);
    expect(isLoopbackHostname('localhost.evil.com')).toBe(false);
    expect(isLoopbackHostname('192.168.0.1')).toBe(false);
    expect(isLoopbackHostname('10.0.0.5')).toBe(false);
    expect(isLoopbackHostname('::2')).toBe(false);
    expect(isLoopbackHostname('0.0.0.0')).toBe(false);
  });
});

describe('isLoopbackOrigin', () => {
  it('accepts loopback origins on any port / scheme', () => {
    expect(isLoopbackOrigin('http://localhost:5710')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:5710')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.2:8787')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:5710')).toBe(true);
    expect(isLoopbackOrigin('http://localhost')).toBe(true);
    expect(isLoopbackOrigin('https://127.0.0.1')).toBe(true);
  });

  it('rejects remote / malformed / empty origins', () => {
    expect(isLoopbackOrigin(undefined)).toBe(false);
    expect(isLoopbackOrigin(null)).toBe(false);
    expect(isLoopbackOrigin('')).toBe(false);
    expect(isLoopbackOrigin('https://www.sliccy.ai')).toBe(false);
    expect(isLoopbackOrigin('https://localhost.evil.com')).toBe(false);
    expect(isLoopbackOrigin('not a url')).toBe(false);
  });
});
