import { describe, expect, it } from 'vitest';
import { handleSprinkleOpResponse } from '../../src/scoops/sprinkle-manager-proxy.js';

/**
 * `handleSprinkleOpResponse` resolves the pending request matching a
 * `sprinkle-op-response` payload's ID. Since the chrome.runtime proxy
 * that used to register those pending requests was removed (the
 * BroadcastChannel bridge in `sprinkle-bridge-channel.ts` superseded it),
 * there is no public way to seed the private `pendingRequests` map — so
 * every payload the kernel bridge routes here is an inert no-op. These
 * tests pin that contract: the handler never throws regardless of the
 * payload shape.
 */
describe('handleSprinkleOpResponse', () => {
  it('is a no-op for an unknown request id', () => {
    expect(() => handleSprinkleOpResponse({ id: 'sp-unknown' })).not.toThrow();
  });

  it('ignores a result payload for an unknown id', () => {
    expect(() =>
      handleSprinkleOpResponse({ id: 'sp-missing', result: { leader: true, followers: [] } })
    ).not.toThrow();
  });

  it('ignores an error payload for an unknown id', () => {
    expect(() => handleSprinkleOpResponse({ id: 'sp-missing', error: 'boom' })).not.toThrow();
  });
});
