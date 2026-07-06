import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SUBPROTOCOL_PREFIX,
  BRIDGE_TOKEN_HEADER,
  BRIDGE_TOKEN_QUERY_PARAM,
  BRIDGE_WS_QUERY_PARAM,
  SLICC_HOSTED_ORIGIN,
  SLICC_STAGING_HUB_ORIGIN,
} from '../src/bridge-protocol.js';

// These values are wire contract spoken by shipped artifacts (installed CLIs,
// the extension, the Swift servers). Changing any of them is a breaking
// protocol change — this test makes that change deliberate, and reminds the
// author to update the Swift mirror (BridgeSecurity.swift).
describe('bridge protocol constants', () => {
  it('pins the launch-param contract', () => {
    expect(BRIDGE_SUBPROTOCOL_PREFIX).toBe('slicc.bridge.v1.');
    expect(BRIDGE_TOKEN_QUERY_PARAM).toBe('bridgeToken');
    expect(BRIDGE_WS_QUERY_PARAM).toBe('bridge');
    expect(BRIDGE_TOKEN_HEADER).toBe('X-Bridge-Token');
  });

  it('pins the hosted origins (no trailing slash, https)', () => {
    expect(SLICC_HOSTED_ORIGIN).toBe('https://www.sliccy.ai');
    expect(SLICC_STAGING_HUB_ORIGIN).toBe('https://slicc-tray-hub-staging.minivelos.workers.dev');
    for (const origin of [SLICC_HOSTED_ORIGIN, SLICC_STAGING_HUB_ORIGIN]) {
      expect(origin.endsWith('/')).toBe(false);
      let parsedOrigin = '<unparseable>';
      try {
        parsedOrigin = new URL(origin).origin;
      } catch {
        // fall through — the expect below fails loudly with the sentinel
      }
      expect(parsedOrigin).toBe(origin);
    }
  });
});
