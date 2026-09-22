import { describe, expect, it, vi } from 'vitest';
import {
  CDP_RECONNECT_BASE_MS,
  CDP_RECONNECT_CAP_MS,
  classifyCdpConnectFailure,
  nextCdpReconnectDelayMs,
} from '../../src/cdp/cdp-reconnect-policy.js';

describe('nextCdpReconnectDelayMs', () => {
  it('grows exponentially and stays inside the cap', () => {
    const first = nextCdpReconnectDelayMs(0, () => 0);
    const second = nextCdpReconnectDelayMs(1, () => 0);
    expect(first).toBe(CDP_RECONNECT_BASE_MS);
    expect(second).toBe(CDP_RECONNECT_BASE_MS * 2);
    expect(nextCdpReconnectDelayMs(30, () => 0)).toBe(CDP_RECONNECT_CAP_MS);
    expect(nextCdpReconnectDelayMs(30, () => 0.99)).toBe(CDP_RECONNECT_CAP_MS);
  });

  it('adds jitter without exceeding the cap', () => {
    const delay = nextCdpReconnectDelayMs(0, () => 1);
    expect(delay).toBeGreaterThan(CDP_RECONNECT_BASE_MS);
    expect(delay).toBeLessThanOrEqual(CDP_RECONNECT_CAP_MS);
  });
});

describe('classifyCdpConnectFailure', () => {
  it('treats a handshake with no bridge token as transient and does not probe', async () => {
    const fetchImpl = vi.fn();
    await expect(
      classifyCdpConnectFailure({ url: 'ws://localhost:5710/cdp' }, fetchImpl)
    ).resolves.toBe('transient');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats 403 bridge-token-required as terminal', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":"bridge-token-required"}', { status: 403 })
    );
    await expect(
      classifyCdpConnectFailure(
        { url: 'ws://localhost:5710/cdp', protocols: 'slicc.bridge.v1.stale' },
        fetchImpl
      )
    ).resolves.toBe('terminal');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:5710/api/status',
      expect.objectContaining({
        headers: { 'X-Bridge-Token': 'stale' },
      })
    );
  });

  it('treats a live bridge with a valid token as transient', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));
    await expect(
      classifyCdpConnectFailure(
        { url: 'ws://127.0.0.1:5710/cdp', protocols: 'slicc.bridge.v1.fresh' },
        fetchImpl
      )
    ).resolves.toBe('transient');
  });

  it('treats a probe that cannot reach the bridge as transient', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      classifyCdpConnectFailure(
        { url: 'ws://localhost:5710/cdp', protocols: 'slicc.bridge.v1.tok' },
        fetchImpl
      )
    ).resolves.toBe('transient');
  });
});
