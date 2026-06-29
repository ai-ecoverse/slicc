// @vitest-environment jsdom
/**
 * Regression: in cup (steering) mode there is no in-page cone, so the floatbar
 * `$` cost counter — fed by the in-page scoop cost tracker — can only ever read
 * $0.00, and the steering bridge carries no channel for the external brain's
 * spend. Leaving it wired would pin a misleading $0.00. `wireWcStats` must drop
 * the cost segment and skip the poller when `cup` is true.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OffscreenClient } from '../../../src/ui/offscreen-client.js';
import { wireWcStats } from '../../../src/ui/wc/wc-live.js';

function makeWiring(): Parameters<typeof wireWcStats>[0] {
  const floatbar = document.createElement('div');
  floatbar.setAttribute('spent', '0.00');
  return {
    refs: { floatbar, switcher: document.createElement('div') },
    fills: new Map(),
    statuses: new Map(),
  } as unknown as Parameters<typeof wireWcStats>[0];
}

describe('wireWcStats — cup gate (no $ counter without an in-page cone)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('cup=true: drops the cost segment and does not poll session stats', () => {
    const wiring = makeWiring();
    const getSessionStats = vi.fn();
    const client = { getSessionStats } as unknown as OffscreenClient;

    const refresh = wireWcStats(wiring, client, true);
    refresh(); // even if invoked by a turn-finished hook, it must be inert

    expect(wiring.refs.floatbar.hasAttribute('spent')).toBe(false);
    expect(getSessionStats).not.toHaveBeenCalled();
  });

  it('non-cup (control): keeps the poller — refresh pulls session stats', () => {
    vi.useFakeTimers();
    const wiring = makeWiring();
    const getSessionStats = vi.fn().mockResolvedValue(null);
    const client = {
      getScoops: () => [],
      getSessionStats,
    } as unknown as OffscreenClient;

    const refresh = wireWcStats(wiring, client, false);
    refresh();

    expect(getSessionStats).toHaveBeenCalledTimes(1);
    expect(wiring.refs.floatbar.getAttribute('spent')).toBe('0.00');
  });
});
