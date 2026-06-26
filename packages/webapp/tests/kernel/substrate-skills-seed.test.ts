/**
 * Substrate workspace seeding — the external brain needs `/workspace/skills`.
 *
 * Substrate mode (`?substrate=1` → `skipConeBootstrap`) runs no cone, so the
 * per-scoop `createDefaultSkills` (scoop-context.ts) that normally populates
 * `/workspace/skills` never fires. Without an explicit boot-time seed the
 * brain's `GET /api/vfs/list /workspace/skills` is empty and it can't load the
 * workspace skills to behave like the cone would. Boot must seed the bundled
 * defaults in substrate mode.
 *
 * This lives in its own file (not `substrate-boot.test.ts`) on purpose: ZenFS'
 * InMemory backend is keyed by `dbName` in a process-global Map, so a cone boot
 * elsewhere in the same file would seed `/workspace/skills` into the shared
 * store and mask a missing substrate seed. Vitest isolates files, so here the
 * substrate boot is the only thing that can populate the directory — the test
 * was RED (0 entries) before the `host.ts` seed step landed.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OffscreenBridge } from '../../../chrome-extension/src/offscreen-bridge.js';
import { BrowserAPI } from '../../src/cdp/browser-api.js';
import type { CDPTransport } from '../../src/cdp/transport.js';
import type { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createKernelHost } from '../../src/kernel/host.js';
import { createBridgeMessageChannelTransport } from '../../src/kernel/transport-message-channel.js';

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

/** Boot a real substrate kernel host (no cone) and expose its shared VFS. */
async function bootSubstrateHost(): Promise<{
  sharedFs: VirtualFS | null;
  teardown: () => Promise<void>;
}> {
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
    skipConeBootstrap: true,
    substrate: true,
  });
  return {
    sharedFs: host.sharedFs,
    teardown: async () => {
      await host.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe('createKernelHost — substrate workspace skills seed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds /workspace/skills in substrate mode so the brain can read them', async () => {
    const { sharedFs, teardown } = await bootSubstrateHost();
    try {
      expect(sharedFs).not.toBeNull();
      const entries = await sharedFs!.readDir('/workspace/skills').catch(() => []);
      expect(entries.length).toBeGreaterThan(0);
    } finally {
      await teardown();
    }
  });
});
