// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared, per-test-mutable control surface for the mocked CDP layer. Declared
// via vi.hoisted so the vi.mock factories below (hoisted above imports) can
// reference it safely.
const mockState = vi.hoisted(() => ({
  transportConfig: {
    joinUrl: null as string | null,
    connect: vi.fn(async () => {}),
  },
  browserConnect: vi.fn(async () => {}),
  // Captures the opts passed to `new CherryHostTransport(...)` so origin
  // resolution can be asserted.
  lastTransportOpts: null as { allowOrigins?: string[]; targetOrigin?: string } | null,
}));

vi.mock('../../src/cdp/cherry-host-transport.js', () => ({
  // Regular function (not arrow) so it is constructable with `new`.
  CherryHostTransport: vi.fn(function (opts: { allowOrigins?: string[]; targetOrigin?: string }) {
    mockState.lastTransportOpts = opts;
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

/** Install a DOMStringList-shaped `location.ancestorOrigins`, or clear the override. */
function setAncestorOrigins(list: string[] | undefined): void {
  if (list === undefined) {
    delete (location as unknown as { ancestorOrigins?: unknown }).ancestorOrigins;
    return;
  }
  const domish: Record<string | number, unknown> = { length: list.length };
  list.forEach((o, i) => {
    domish[i] = o;
  });
  domish.item = (i: number) => list[i] ?? null;
  domish.contains = (s: string) => list.includes(s);
  Object.defineProperty(location, 'ancestorOrigins', { configurable: true, value: domish });
}

function setReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', { configurable: true, value });
}

describe('setupCherryFollower', () => {
  beforeEach(() => {
    mockState.transportConfig.joinUrl = null;
    mockState.transportConfig.connect.mockClear();
    mockState.browserConnect.mockClear();
    mockState.lastTransportOpts = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setAncestorOrigins(undefined);
    delete (document as unknown as { referrer?: unknown }).referrer;
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

  it('resolves the parent origin from location.ancestorOrigins (referrer-policy immune), not document.referrer', async () => {
    // Real failure this guards: an HTTPS host embedding an HTTP dev iframe (or
    // any host with a strict Referrer-Policy) strips document.referrer, so the
    // follower would post its handshake to its own origin and time out. The
    // browser-supplied ancestor origin must win.
    mockState.transportConfig.joinUrl = 'https://tray/join/t.s';
    setReferrer(''); // stripped referrer
    setAncestorOrigins(['https://host.example']);

    await setupCherryFollower();

    expect(mockState.lastTransportOpts?.allowOrigins).toEqual(['https://host.example']);
    expect(mockState.lastTransportOpts?.targetOrigin).toBe('https://host.example');
  });

  it('falls back to document.referrer when ancestorOrigins is unavailable', async () => {
    mockState.transportConfig.joinUrl = 'https://tray/join/t.s';
    setAncestorOrigins(undefined); // e.g. non-Chromium
    setReferrer('https://ref.example/some/page');

    await setupCherryFollower();

    expect(mockState.lastTransportOpts?.allowOrigins).toEqual(['https://ref.example']);
    expect(mockState.lastTransportOpts?.targetOrigin).toBe('https://ref.example');
  });

  it('ignores a sandboxed opaque-origin ancestor ("null") and falls back to referrer', async () => {
    mockState.transportConfig.joinUrl = 'https://tray/join/t.s';
    setAncestorOrigins(['null']); // sandboxed ancestor frame
    setReferrer('https://ref.example/page');

    await setupCherryFollower();

    expect(mockState.lastTransportOpts?.targetOrigin).toBe('https://ref.example');
  });
});
