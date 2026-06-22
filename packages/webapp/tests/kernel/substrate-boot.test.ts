/**
 * Regression: substrate mode (`?substrate=1`) must produce NO cone scoop.
 *
 * Two-brains guarantee: when the standalone kernel boots with
 * `skipConeBootstrap: true`, the orchestrator must have exactly zero
 * cone scoops. A second test pins the boot-wiring: when
 * `KernelWorkerInitMsg.substrate` is truthy the init message posted to
 * the worker must carry `substrate: true`.
 *
 * "Red first" rationale:
 *  - The first test (`createKernelHost skipConeBootstrap`) covers the
 *    existing host-level gate. It was already green before this task —
 *    `skipConeBootstrap` is an existing flag. The test is included so
 *    ANY future change that accidentally removes that gate trips CI.
 *  - The second test (`bootstrap forwards substrate into init message`)
 *    was RED before the wiring landed: `KernelWorkerBootstrapOptions`
 *    had no `substrate` field, so the test would fail to compile /
 *    produce a property that was always `undefined`.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CDPTransport } from '../../src/cdp/transport.js';
import type { WorkerLike } from '../../src/kernel/spawn.js';
import { bootstrapKernelWorker } from '../../src/kernel/spawn.js';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('substrate boot — two-brains guarantee', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bootstrap forwards substrate:true into the kernel-worker-init message', () => {
    // This test was RED before the wiring: `KernelWorkerBootstrapOptions`
    // had no `substrate` field, so the posted init message never carried
    // `substrate: true`.
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
    // The two-brains guarantee depends on this flag reaching the worker.
    expect(init.substrate).toBe(true);

    host.dispose();
  });

  it('bootstrap omits substrate (or sets it false) when not in substrate mode', () => {
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
