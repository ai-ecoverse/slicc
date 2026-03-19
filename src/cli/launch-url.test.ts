import { describe, expect, it } from 'vitest';

import { resolveCliBrowserLaunchUrl } from './launch-url.js';

describe('resolveCliBrowserLaunchUrl', () => {
  it('uses the plain serve origin when lead mode is disabled', () => {
    expect(resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: false,
      join: false,
    })).toBe('http://localhost:3000');
  });

  it('builds a canonical tray URL from an explicit worker base URL', () => {
    expect(resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: true,
      leadWorkerBaseUrl: 'https://tray.example.com/base/',
      join: false,
    })).toBe('http://localhost:3000/?tray=https%3A%2F%2Ftray.example.com%2Fbase');
  });

  it('falls back to WORKER_BASE_URL when --lead is present without an explicit value', () => {
    expect(resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: true,
      envWorkerBaseUrl: 'https://tray.example.com',
      join: false,
    })).toBe('http://localhost:3000/?tray=https%3A%2F%2Ftray.example.com');
  });

  it('builds a canonical join launch URL from a tray join URL', () => {
    expect(resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000/?scoop=cone&lead=https://old.example.com&trayWorkerUrl=https://older.example.com',
      lead: false,
      join: true,
      joinUrl: 'https://tray.example.com/base/join/tray-123.secret?foo=bar#hash',
    })).toBe('http://localhost:3000/?scoop=cone&tray=https%3A%2F%2Ftray.example.com%2Fbase%2Fjoin%2Ftray-123.secret');
  });

  it('throws when join mode is requested without a join URL', () => {
    expect(() => resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: false,
      join: true,
    })).toThrow(/--join launch flow requires a tray join URL/);
  });

  it('throws when join mode is given an invalid tray join URL', () => {
    expect(() => resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: false,
      join: true,
      joinUrl: 'https://tray.example.com/base/tray/tray-123',
    })).toThrow(/Invalid tray join URL/);
  });

  it('throws when lead and join mode are both requested', () => {
    expect(() => resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: true,
      leadWorkerBaseUrl: 'https://tray.example.com/base',
      join: true,
      joinUrl: 'https://tray.example.com/base/join/tray-123.secret',
    })).toThrow(/mutually exclusive/);
  });

  it('throws when lead mode is requested without any worker base URL source', () => {
    expect(() => resolveCliBrowserLaunchUrl({
      serveOrigin: 'http://localhost:3000',
      lead: true,
      join: false,
    })).toThrow(/--lead launch flow requires a tray worker base URL/);
  });
});