// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared, per-test-mutable control surface for the mocked CDP layer. Declared
// via vi.hoisted so the vi.mock factories below (hoisted above imports) can
// reference it safely.
const mockState = vi.hoisted(() => ({
  transportConfig: {
    joinUrl: null as string | null,
    connect: vi.fn(async () => {}),
  },
  browserConnect: vi.fn(async () => {}),
}));

vi.mock('../../src/cdp/cherry-host-transport.js', () => ({
  // Regular function (not arrow) so it is constructable with `new`.
  CherryHostTransport: vi.fn(function () {
    return {
      connect: () => mockState.transportConfig.connect(),
      get joinUrl() {
        return mockState.transportConfig.joinUrl;
      },
    };
  }),
}));

vi.mock('../../src/cdp/index.js', () => ({
  BrowserAPI: vi.fn(function (transport: unknown) {
    return { __transport: transport, connect: mockState.browserConnect };
  }),
}));

import { setupCherryFollower } from '../../src/ui/main-cherry.js';

describe('setupCherryFollower', () => {
  beforeEach(() => {
    mockState.transportConfig.joinUrl = null;
    mockState.transportConfig.connect.mockClear();
    mockState.browserConnect.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the handshake joinUrl and does NOT re-connect the already-connected transport (I3)', async () => {
    mockState.transportConfig.joinUrl = 'https://app/handshake';
    const result = await setupCherryFollower();
    expect(result.joinUrl).toBe('https://app/handshake');
    // BrowserAPI wraps the connected transport; the redundant browser.connect()
    // that previously always threw "state is connected" must not be called.
    expect(mockState.browserConnect).not.toHaveBeenCalled();
    expect((result.browser as unknown as { __transport: unknown }).__transport).toBe(
      result.transport
    );
  });

  it('throws when the handshake yields no joinUrl', async () => {
    await expect(setupCherryFollower()).rejects.toThrow(/no joinUrl/i);
  });
});
