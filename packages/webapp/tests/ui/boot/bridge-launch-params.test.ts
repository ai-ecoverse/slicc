import { describe, expect, it } from 'vitest';
import {
  BRIDGE_ROLE_QUERY_PARAM,
  BRIDGE_SUBPROTOCOL_PREFIX,
  BRIDGE_TOKEN_QUERY_PARAM,
  BRIDGE_WS_QUERY_PARAM,
  deriveBridgeApiBaseUrl,
  deriveBridgeLickWsUrl,
  parseBridgeLaunchParams,
} from '../../../src/ui/boot/bridge-launch-params.js';

describe('parseBridgeLaunchParams', () => {
  it('returns null when both params are missing', () => {
    expect(parseBridgeLaunchParams('')).toBeNull();
    expect(parseBridgeLaunchParams('?foo=bar')).toBeNull();
  });

  it('returns null when only `bridge` is present', () => {
    expect(parseBridgeLaunchParams('?bridge=ws://localhost:5710/cdp')).toBeNull();
  });

  it('returns null when only `bridgeToken` is present', () => {
    expect(parseBridgeLaunchParams('?bridgeToken=abc')).toBeNull();
  });

  it('returns null when bridge URL has a non-ws scheme', () => {
    expect(parseBridgeLaunchParams('?bridge=http://localhost:5710/cdp&bridgeToken=abc')).toBeNull();
    expect(parseBridgeLaunchParams('?bridge=javascript:alert(1)&bridgeToken=abc')).toBeNull();
  });

  it('parses a ws:// bridge URL + token into url + subprotocol + token + apiBaseUrl + lickWsUrl', () => {
    const params = parseBridgeLaunchParams('?bridge=ws://localhost:5710/cdp&bridgeToken=abc-123');
    expect(params).toEqual({
      url: 'ws://localhost:5710/cdp',
      subprotocol: 'slicc.bridge.v1.abc-123',
      token: 'abc-123',
      apiBaseUrl: 'http://localhost:5710',
      lickWsUrl: 'ws://localhost:5710/licks-ws',
      role: null,
    });
  });

  it('accepts wss:// bridge URLs (apiBaseUrl uses https://, lickWsUrl uses wss://)', () => {
    const params = parseBridgeLaunchParams(
      '?bridge=wss%3A%2F%2Flocalhost%3A5710%2Fcdp&bridgeToken=xyz'
    );
    expect(params?.url).toBe('wss://localhost:5710/cdp');
    expect(params?.subprotocol).toBe('slicc.bridge.v1.xyz');
    expect(params?.token).toBe('xyz');
    expect(params?.apiBaseUrl).toBe('https://localhost:5710');
    expect(params?.lickWsUrl).toBe('wss://localhost:5710/licks-ws');
  });

  it('rejects a bridge pointing anywhere but loopback', () => {
    // The query string is attacker-suppliable — the page is served from the
    // hosted origin, so a crafted link can name any host here. `apiBaseUrl` is
    // derived straight from it, which would aim the local /api surface (and the
    // boot-time OAuth replica push, raw access tokens included) at a remote
    // server that only has to permit the request via CORS (#2939 review).
    for (const host of [
      'attacker.example',
      'bridge.example',
      '169.254.169.254',
      '10.0.0.5',
      'localhost.attacker.example',
      '127.0.0.1.attacker.example',
    ]) {
      expect(
        parseBridgeLaunchParams(`?bridge=${encodeURIComponent(`wss://${host}/cdp`)}&bridgeToken=x`)
      ).toBeNull();
    }
  });

  it('accepts every loopback spelling a launcher may emit', () => {
    // Must match `isLoopbackHostname` — a stricter check here would break the
    // IPv6 and 127.0.0.0/8 launches the servers legitimately produce.
    for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '[::1]']) {
      const params = parseBridgeLaunchParams(
        `?bridge=${encodeURIComponent(`ws://${host}:5710/cdp`)}&bridgeToken=x`
      );
      expect(params, host).not.toBeNull();
      expect(params?.apiBaseUrl).toBe(`http://${host}:5710`);
    }
  });

  it('returns null when the bridge URL passes the scheme test but will not parse', () => {
    expect(parseBridgeLaunchParams('?bridge=ws://%5B/cdp&bridgeToken=x')).toBeNull();
  });

  it('extracts role=leader and role=follower when the launcher stamped one', () => {
    expect(
      parseBridgeLaunchParams('?bridge=ws://localhost:5710/cdp&bridgeToken=abc&role=leader')?.role
    ).toBe('leader');
    expect(
      parseBridgeLaunchParams('?bridge=ws://localhost:5710/cdp&bridgeToken=abc&role=follower')?.role
    ).toBe('follower');
  });

  it('returns role=null for unknown role values (defensive — only leader/follower honored)', () => {
    expect(
      parseBridgeLaunchParams('?bridge=ws://localhost:5710/cdp&bridgeToken=abc&role=admin')?.role
    ).toBeNull();
    expect(
      parseBridgeLaunchParams('?bridge=ws://localhost:5710/cdp&bridgeToken=abc&role=')?.role
    ).toBeNull();
  });

  it('uses the same param/prefix constants the node-server gates on', () => {
    expect(BRIDGE_WS_QUERY_PARAM).toBe('bridge');
    expect(BRIDGE_TOKEN_QUERY_PARAM).toBe('bridgeToken');
    expect(BRIDGE_ROLE_QUERY_PARAM).toBe('role');
    expect(BRIDGE_SUBPROTOCOL_PREFIX).toBe('slicc.bridge.v1.');
  });
});

describe('deriveBridgeApiBaseUrl', () => {
  it('maps ws:// → http:// preserving host:port and dropping path', () => {
    expect(deriveBridgeApiBaseUrl('ws://localhost:5710/cdp')).toBe('http://localhost:5710');
    expect(deriveBridgeApiBaseUrl('ws://127.0.0.1:5720/cdp')).toBe('http://127.0.0.1:5720');
  });

  it('maps wss:// → https://', () => {
    expect(deriveBridgeApiBaseUrl('wss://bridge.example/cdp')).toBe('https://bridge.example');
  });

  it('returns null for unparseable URLs', () => {
    expect(deriveBridgeApiBaseUrl('not a url')).toBeNull();
    expect(deriveBridgeApiBaseUrl('')).toBeNull();
  });
});

describe('deriveBridgeLickWsUrl', () => {
  it('preserves ws:// scheme and host:port, swapping path to /licks-ws', () => {
    expect(deriveBridgeLickWsUrl('ws://localhost:5710/cdp')).toBe('ws://localhost:5710/licks-ws');
    expect(deriveBridgeLickWsUrl('ws://127.0.0.1:5720/cdp')).toBe('ws://127.0.0.1:5720/licks-ws');
  });

  it('preserves wss:// scheme', () => {
    expect(deriveBridgeLickWsUrl('wss://bridge.example/cdp')).toBe('wss://bridge.example/licks-ws');
  });

  it('returns null for unparseable URLs', () => {
    expect(deriveBridgeLickWsUrl('not a url')).toBeNull();
    expect(deriveBridgeLickWsUrl('')).toBeNull();
  });
});
