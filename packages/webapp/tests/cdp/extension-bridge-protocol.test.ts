import { describe, expect, it } from 'vitest';
import {
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  isExtensionBridgeEnvelope,
} from '../../src/cdp/extension-bridge-protocol.js';

describe('extension-bridge-protocol', () => {
  it('exposes a stable port name and protocol version', () => {
    expect(EXTENSION_BRIDGE_PORT_NAME).toBe('slicc.cdp-bridge');
    expect(EXTENSION_BRIDGE_PROTOCOL_VERSION).toBe(1);
  });

  it('accepts all valid envelope kinds', () => {
    const ch = 'bridge-abc';
    const kinds = [
      { bridge: 1, channelId: ch, kind: 'handshake.hello' },
      { bridge: 1, channelId: ch, kind: 'handshake.welcome' },
      { bridge: 1, channelId: ch, kind: 'handshake.rejected', reason: 'x' },
      { bridge: 1, channelId: ch, kind: 'cdp.request', id: 1, method: 'X' },
      { bridge: 1, channelId: ch, kind: 'cdp.response', id: 1 },
      { bridge: 1, channelId: ch, kind: 'cdp.event', method: 'X' },
      {
        bridge: 1,
        channelId: ch,
        kind: 'extension.lick',
        verb: 'handoff',
        target: 'sliccy.ai',
        url: 'https://www.sliccy.ai/handoff?handoff=do%20a%20thing',
      },
      {
        bridge: 1,
        channelId: ch,
        kind: 'extension.lick',
        verb: 'upskill',
        target: 'github.com/owner/repo',
        url: 'https://www.sliccy.ai/handoff?upskill=https://github.com/owner/repo',
        instruction: 'install this skill',
        branch: 'main',
        path: 'skills/foo',
        title: 'Foo skill',
      },
    ];
    for (const env of kinds) {
      expect(isExtensionBridgeEnvelope(env)).toBe(true);
    }
  });

  it('rejects malformed envelopes', () => {
    expect(isExtensionBridgeEnvelope(null)).toBe(false);
    expect(isExtensionBridgeEnvelope('not-an-object')).toBe(false);
    expect(isExtensionBridgeEnvelope({})).toBe(false);
    // Wrong protocol version.
    expect(isExtensionBridgeEnvelope({ bridge: 99, channelId: 'x', kind: 'handshake.hello' })).toBe(
      false
    );
    // Missing channelId.
    expect(isExtensionBridgeEnvelope({ bridge: 1, kind: 'handshake.hello' })).toBe(false);
    // Unknown kind.
    expect(isExtensionBridgeEnvelope({ bridge: 1, channelId: 'x', kind: 'pizza' })).toBe(false);
    // channelId not a string.
    expect(isExtensionBridgeEnvelope({ bridge: 1, channelId: 42, kind: 'handshake.hello' })).toBe(
      false
    );
    // Lick with wrong protocol version.
    expect(
      isExtensionBridgeEnvelope({
        bridge: 99,
        channelId: 'x',
        kind: 'extension.lick',
        verb: 'handoff',
        target: 't',
        url: 'u',
      })
    ).toBe(false);
    // Lick missing channelId.
    expect(
      isExtensionBridgeEnvelope({
        bridge: 1,
        kind: 'extension.lick',
        verb: 'handoff',
        target: 't',
        url: 'u',
      })
    ).toBe(false);
  });

  it('rejects envelopes that look almost right (Cherry envelopes)', () => {
    // The Cherry protocol uses `cherry: 1`, not `bridge: 1` — even though
    // some kinds overlap, the validator must reject Cherry envelopes so the
    // two transports stay separate at the wire level.
    expect(isExtensionBridgeEnvelope({ cherry: 1, channelId: 'x', kind: 'handshake.hello' })).toBe(
      false
    );
  });
});
