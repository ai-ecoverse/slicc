/**
 * Regression: cup mode (`createKernelHost({ cup: true })`) must
 * wire a working `shellBridge` into the `/licks-ws` bridge. Without it, every
 * cup route (`shell-exec`, `targets`, `vfs-*`, `lick-emit`,
 * `shell-session-status`) falls through the lick-ws-bridge default case and
 * returns `Unknown request type: <type>` — i.e. the entire steering API is
 * dead even though the browser is connected.
 *
 * This is the integration seam the existing `cup-boot.test.ts` does NOT
 * cover: `bootHost` there only exercises the cone gate (`skipConeBootstrap`)
 * and never passes `cup`, so the host → `shellBridge` wiring shipped
 * untested.
 *
 * We mock ONLY `startLickWsBridge` (to capture the options it is handed);
 * `buildShellBridgeForCup` runs for real, so a missing/throwing build
 * surfaces as `options.shellBridge === undefined`.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OffscreenBridge } from '../../../chrome-extension/src/offscreen-bridge.js';
import { BrowserAPI } from '../../src/cdp/browser-api.js';
import type { CDPTransport } from '../../src/cdp/transport.js';
import { createKernelHost } from '../../src/kernel/host.js';
import { createBridgeMessageChannelTransport } from '../../src/kernel/transport-message-channel.js';
import type { LickWsBridgeOptions } from '../../src/scoops/lick-ws-bridge.js';

// Capture the options handed to startLickWsBridge while preserving every other
// real export of the module (the bridge runtime sets `rt.shellBridge =
// options.shellBridge`, so the captured option IS what the dispatcher uses).
const startCalls: LickWsBridgeOptions[] = [];
vi.mock('../../src/scoops/lick-ws-bridge.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/scoops/lick-ws-bridge.js')>();
  return {
    ...actual,
    startLickWsBridge: vi.fn((_lickManager: unknown, options: LickWsBridgeOptions) => {
      startCalls.push(options);
      return { stop: vi.fn() };
    }),
  };
});

function makeStubCdpTransport(): CDPTransport {
  return {
    state: 'connected',
    connect: async () => {},
    disconnect: () => {},
    send: async () => ({}),
    on: () => {},
    off: () => {},
    once: async () => ({}),
  };
}

async function bootHost(opts: { cup?: boolean }): Promise<{ teardown: () => Promise<void> }> {
  const channel = new MessageChannel();
  const browser = new BrowserAPI(makeStubCdpTransport());
  const bridge = new OffscreenBridge(createBridgeMessageChannelTransport(channel.port2));
  const callbacks = OffscreenBridge.createCallbacks(bridge);
  const host = await createKernelHost({
    container: {} as unknown as HTMLElement,
    browser,
    bridge,
    callbacks,
    logger: console,
    cup: opts.cup,
  });
  return {
    teardown: async () => {
      await host.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('cup boot — shellBridge wiring', () => {
  beforeEach(() => {
    // host.ts opens the lick-ws bridge with `self.location.href`. In the kernel
    // worker `self` is the worker global; Node/vitest has none. Polyfill the
    // single property the boot path reads so the real wiring is exercised.
    vi.stubGlobal('self', { location: { href: 'http://localhost:5710/?cup=1' } });
  });

  afterEach(() => {
    startCalls.length = 0;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('wires a shellBridge that handles shell-exec when cup:true', async () => {
    const { teardown } = await bootHost({ cup: true });
    try {
      expect(startCalls).toHaveLength(1);
      const opts = startCalls[0];
      expect(opts.shellBridge).toBeDefined();
      expect(opts.shellBridge?.canHandle('shell-exec')).toBe(true);
      expect(opts.shellBridge?.canHandle('targets')).toBe(true);
    } finally {
      await teardown();
    }
  });

  it('leaves shellBridge undefined on the normal (non-cup) path', async () => {
    const { teardown } = await bootHost({ cup: false });
    try {
      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].shellBridge).toBeUndefined();
    } finally {
      await teardown();
    }
  });
});
