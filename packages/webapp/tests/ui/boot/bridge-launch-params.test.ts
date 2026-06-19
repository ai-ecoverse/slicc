import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SUBPROTOCOL_PREFIX,
  BRIDGE_TOKEN_QUERY_PARAM,
  BRIDGE_WS_QUERY_PARAM,
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

  it('parses a ws:// bridge URL + token into url + subprotocol', () => {
    const params = parseBridgeLaunchParams('?bridge=ws://localhost:5710/cdp&bridgeToken=abc-123');
    expect(params).toEqual({
      url: 'ws://localhost:5710/cdp',
      subprotocol: 'slicc.bridge.v1.abc-123',
    });
  });

  it('accepts wss:// bridge URLs', () => {
    const params = parseBridgeLaunchParams(
      '?bridge=wss%3A%2F%2Fbridge.example%2Fcdp&bridgeToken=xyz'
    );
    expect(params?.url).toBe('wss://bridge.example/cdp');
    expect(params?.subprotocol).toBe('slicc.bridge.v1.xyz');
  });

  it('uses the same param/prefix constants the node-server gates on', () => {
    expect(BRIDGE_WS_QUERY_PARAM).toBe('bridge');
    expect(BRIDGE_TOKEN_QUERY_PARAM).toBe('bridgeToken');
    expect(BRIDGE_SUBPROTOCOL_PREFIX).toBe('slicc.bridge.v1.');
  });
});
