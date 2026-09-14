import { describe, expect, it } from 'vitest';
import { FakeDurableObjectState } from './fake-do-state.js';

describe('FakeDurableObjectState WS hibernation modeling', () => {
  it('filters sockets by tag and round-trips attachments', () => {
    const state = new FakeDurableObjectState();
    const leader = state.makeSocket();
    const bridge = state.makeSocket();
    state.acceptWebSocket(leader, ['leader']);
    state.acceptWebSocket(bridge, ['bridge', 'conn:c1']);
    bridge.serializeAttachment({ connId: 'c1' });
    expect(state.getWebSockets('bridge')).toEqual([bridge]);
    expect(state.getTags(bridge)).toContain('conn:c1');
    expect(bridge.deserializeAttachment()).toEqual({ connId: 'c1' });
  });
});
