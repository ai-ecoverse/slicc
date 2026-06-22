import { describe, expect, it } from 'vitest';

import { resolveCliBrowserLaunchUrl } from '../src/launch-url.js';

describe('resolveCliBrowserLaunchUrl', () => {
  it('uses the plain serve origin when lead mode is disabled', () => {
    expect(
      resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: false,
        join: false,
      })
    ).toBe('http://localhost:3000');
  });

  it('builds a canonical tray URL from an explicit worker base URL', () => {
    expect(
      resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: true,
        leadWorkerBaseUrl: 'https://tray.example.com/base/',
        join: false,
      })
    ).toBe('http://localhost:3000/?tray=https%3A%2F%2Ftray.example.com%2Fbase');
  });

  it('falls back to WORKER_BASE_URL when --lead is present without an explicit value', () => {
    expect(
      resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: true,
        envWorkerBaseUrl: 'https://tray.example.com',
        join: false,
      })
    ).toBe('http://localhost:3000/?tray=https%3A%2F%2Ftray.example.com');
  });

  it('builds a canonical join launch URL from a tray join URL', () => {
    expect(
      resolveCliBrowserLaunchUrl({
        serveOrigin:
          'http://localhost:3000/?scoop=cone&lead=https://old.example.com&trayWorkerUrl=https://older.example.com',
        lead: false,
        join: true,
        joinUrl: 'https://tray.example.com/base/join/tray-123.secret?foo=bar#hash',
      })
    ).toBe(
      'http://localhost:3000/?scoop=cone&tray=https%3A%2F%2Ftray.example.com%2Fbase%2Fjoin%2Ftray-123.secret'
    );
  });

  it('throws when join mode is requested without a join URL', () => {
    expect(() =>
      resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: false,
        join: true,
      })
    ).toThrow(/--join launch flow requires a tray join URL/);
  });

  it('throws when join mode is given an invalid tray join URL', () => {
    expect(() =>
      resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: false,
        join: true,
        joinUrl: 'https://tray.example.com/base/tray/tray-123',
      })
    ).toThrow(/Invalid tray join URL/);
  });

  it('throws when lead and join mode are both requested', () => {
    expect(() =>
      resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: true,
        leadWorkerBaseUrl: 'https://tray.example.com/base',
        join: true,
        joinUrl: 'https://tray.example.com/base/join/tray-123.secret',
      })
    ).toThrow(/mutually exclusive/);
  });

  it('throws when lead mode is requested without any worker base URL source', () => {
    expect(() =>
      resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: true,
        join: false,
      })
    ).toThrow(/--lead launch flow requires a tray worker base URL/);
  });

  describe('thin-bridge query params', () => {
    it('appends bridge + bridgeToken to the plain serve origin', () => {
      const url = resolveCliBrowserLaunchUrl({
        serveOrigin: 'https://www.sliccy.ai/?runtime=hosted-leader',
        lead: false,
        join: false,
        bridgeWsUrl: 'ws://localhost:5710/cdp',
        bridgeToken: 'tok-123',
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get('bridge')).toBe('ws://localhost:5710/cdp');
      expect(parsed.searchParams.get('bridgeToken')).toBe('tok-123');
      expect(parsed.searchParams.get('runtime')).toBe('hosted-leader');
    });

    it('appends bridge params alongside the tray param in lead mode', () => {
      const url = resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: true,
        leadWorkerBaseUrl: 'https://tray.example.com/base',
        join: false,
        bridgeWsUrl: 'ws://localhost:3000/cdp',
        bridgeToken: 'tok-abc',
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get('tray')).toBe('https://tray.example.com/base');
      expect(parsed.searchParams.get('bridge')).toBe('ws://localhost:3000/cdp');
      expect(parsed.searchParams.get('bridgeToken')).toBe('tok-abc');
    });

    it('appends bridge params alongside the tray param in join mode', () => {
      const url = resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: false,
        join: true,
        joinUrl: 'https://tray.example.com/base/join/tray-123.secret',
        bridgeWsUrl: 'ws://localhost:3000/cdp',
        bridgeToken: 'tok-xyz',
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get('tray')).toBeTruthy();
      expect(parsed.searchParams.get('bridge')).toBe('ws://localhost:3000/cdp');
      expect(parsed.searchParams.get('bridgeToken')).toBe('tok-xyz');
    });

    it('omits bridge params when only one of bridgeWsUrl/bridgeToken is set', () => {
      const noToken = resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: false,
        join: false,
        bridgeWsUrl: 'ws://localhost:3000/cdp',
      });
      expect(new URL(noToken).searchParams.get('bridge')).toBeNull();

      const noUrl = resolveCliBrowserLaunchUrl({
        serveOrigin: 'http://localhost:3000',
        lead: false,
        join: false,
        bridgeToken: 'tok-xyz',
      });
      expect(new URL(noUrl).searchParams.get('bridgeToken')).toBeNull();
    });
  });

  describe('substrate query param', () => {
    it('appends substrate=1 only when enabled', () => {
      expect(
        resolveCliBrowserLaunchUrl({
          serveOrigin: 'http://localhost:5710/',
          lead: false,
          join: false,
          substrate: true,
        })
      ).toBe('http://localhost:5710/?substrate=1');

      expect(
        resolveCliBrowserLaunchUrl({
          serveOrigin: 'http://localhost:5710/?x=1',
          lead: false,
          join: false,
          substrate: true,
        })
      ).toBe('http://localhost:5710/?x=1&substrate=1');

      expect(
        resolveCliBrowserLaunchUrl({
          serveOrigin: 'http://localhost:5710/',
          lead: false,
          join: false,
          substrate: false,
        })
      ).toBe('http://localhost:5710/');
    });
  });
});
