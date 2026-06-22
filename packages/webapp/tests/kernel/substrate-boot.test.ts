/**
 * Regression: substrate mode (`?substrate=1`) must produce NO cone scoop
 * — the "two-brains" guarantee. The substrate float lends its single
 * `BrowserAPI` to a remote leader, so a local cone (a second CDP
 * authority) must never be bootstrapped.
 *
 * This file pins the guarantee at two layers:
 *
 *  1. Host-level gate (`createKernelHost full boot — cone gate`): boots
 *     a real `createKernelHost(...)` against an in-memory VFS
 *     (`fake-indexeddb`) and a stub CDP transport.
 *       - `skipConeBootstrap: true`  → `getScoops().filter(isCone)` is empty.
 *       - default (flag omitted)     → exactly one cone IS created.
 *     The default case is the negative control: it proves the suite would
 *     FAIL if the `host.ts` `if (!skipConeBootstrap)` guard were removed
 *     or negated (verified manually — see task-3 report RED evidence).
 *
 *  2. Boot wiring (`substrate boot wiring — init message`): the page-side
 *     `bootstrapKernelWorker` must thread `substrate: true` into the
 *     `kernel-worker-init` message, and leave it falsy when the URL flag
 *     is absent. The worker maps that field to `skipConeBootstrap`. The
 *     `substrate: true` assertion was RED before the wiring landed
 *     (`KernelWorkerBootstrapOptions` had no `substrate` field, so the
 *     posted init message never carried it).
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OffscreenBridge } from '../../../chrome-extension/src/offscreen-bridge.js';
import { BrowserAPI } from '../../src/cdp/browser-api.js';
import type { CDPTransport } from '../../src/cdp/transport.js';
import { createKernelHost } from '../../src/kernel/host.js';
import { bootstrapKernelWorker, type WorkerLike } from '../../src/kernel/spawn.js';
import { createBridgeMessageChannelTransport } from '../../src/kernel/transport-message-channel.js';
import type { OffscreenClientCallbacks } from '../../src/ui/offscreen-client.js';

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

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

function makeStubCallbacks(): OffscreenClientCallbacks {
  return {
    onStatusChange: vi.fn(),
    onScoopCreated: vi.fn(),
    onScoopListUpdate: vi.fn(),
    onIncomingMessage: vi.fn(),
  };
}

interface MockWorker extends WorkerLike {
  posted: Array<{ message: unknown; transfer?: Transferable[] }>;
  terminateCalls: number;
}

function makeMockWorker(): MockWorker {
  const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  let terminateCalls = 0;
  const worker: MockWorker = {
    posted,
    terminateCalls,
    postMessage(message, transfer) {
      posted.push({ message, transfer });
    },
    terminate() {
      (worker as unknown as { terminateCalls: number }).terminateCalls = ++terminateCalls;
    },
  };
  return worker;
}

/**
 * Boot a real kernel host with stub transports. Returns the host plus a
 * teardown that disposes the host and closes the bridge channel.
 */
async function bootHost(opts: {
  skipConeBootstrap?: boolean;
}): Promise<{ cones: number; teardown: () => Promise<void> }> {
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
    skipConeBootstrap: opts.skipConeBootstrap,
  });
  const cones = host.orchestrator.getScoops().filter((s) => s.isCone).length;
  return {
    cones,
    teardown: async () => {
      await host.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Host-level gate — the actual two-brains regression
// ---------------------------------------------------------------------------

describe('createKernelHost full boot — cone gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates NO cone scoop when skipConeBootstrap is true (substrate mode)', async () => {
    const { cones, teardown } = await bootHost({ skipConeBootstrap: true });
    try {
      expect(cones).toBe(0);
    } finally {
      await teardown();
    }
  });

  it('creates exactly one cone scoop by default (negative control)', async () => {
    // If the `host.ts` `if (!skipConeBootstrap)` guard were removed, the
    // substrate test above would also bootstrap a cone — this default
    // case proves a cone is created on the normal path, so the guard is
    // load-bearing.
    const { cones, teardown } = await bootHost({ skipConeBootstrap: false });
    try {
      expect(cones).toBe(1);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Boot wiring — page reads ?substrate=1 → init message → skipConeBootstrap
// ---------------------------------------------------------------------------

describe('substrate boot wiring — init message', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('threads substrate:true into the kernel-worker-init message', () => {
    // RED before the wiring: `KernelWorkerBootstrapOptions` had no
    // `substrate` field, so the posted init never carried `substrate: true`.
    const worker = makeMockWorker();
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      substrate: true,
    });

    expect(worker.posted).toHaveLength(1);
    const init = worker.posted[0].message as Record<string, unknown>;
    expect(init.type).toBe('kernel-worker-init');
    // The worker maps this field → `createKernelHost({ skipConeBootstrap })`.
    expect(init.substrate).toBe(true);

    host.dispose();
  });

  it('leaves substrate falsy when not in substrate mode', () => {
    const worker = makeMockWorker();
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      // substrate not set
    });

    expect(worker.posted).toHaveLength(1);
    const init = worker.posted[0].message as Record<string, unknown>;
    expect(init.substrate).toBeFalsy();

    host.dispose();
  });
});
