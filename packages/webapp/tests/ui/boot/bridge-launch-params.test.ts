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
      '?bridge=wss%3A%2F%2Fbridge.example%2Fcdp&bridgeToken=xyz'
    );
    expect(params?.url).toBe('wss://bridge.example/cdp');
    expect(params?.subprotocol).toBe('slicc.bridge.v1.xyz');
    expect(params?.token).toBe('xyz');
    expect(params?.apiBaseUrl).toBe('https://bridge.example');
    expect(params?.lickWsUrl).toBe('wss://bridge.example/licks-ws');
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
