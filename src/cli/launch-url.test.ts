import { describe, expect, it } from 'vitest';

import { resolveCliBrowserLaunchUrl } from './launch-url.js';

describe('resolveCliBrowserLaunchUrl', () => {
  it('uses the plain serve origin when lead mode is disabled', () => {
    expect(resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: false,
    })).toBe('http://localhost:3000');
  });

  it('builds a canonical tray URL from an explicit worker base URL', () => {
    expect(resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: true,
      leadWorkerBaseUrl: 'https://tray.example.com/base/',
    })).toBe('http://localhost:3000/?tray=https%3A%2F%2Ftray.example.com%2Fbase');
  });

  it('falls back to WORKER_BASE_URL when --lead is present without an explicit value', () => {
    expect(resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: true,
      envWorkerBaseUrl: 'https://tray.example.com',
    })).toBe('http://localhost:3000/?tray=https%3A%2F%2Ftray.example.com');
  });

  it('throws when lead mode is requested without any worker base URL source', () => {
    expect(() => resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: true,
    })).toThrow(/--lead launch flow requires a tray worker base URL/);
  });
});