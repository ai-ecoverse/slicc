/**
 * Tests for `bootstrapKernelWorker` — the page-side spawn helper.
 *
 * Uses a mock `WorkerLike` (postMessage + terminate) instead of a real
 * `Worker`. The mock acts like a real worker for the bootstrap
 * handshake: when it receives `kernel-worker-init`, it posts a
 * `kernel-worker-ready` back over the kernel port (mimicking what
 * `kernel-worker.ts`'s `boot()` does after `createKernelHost`
 * resolves).
 *
 * Pins:
 *   - bootstrap returns a `client` immediately
 *   - posting `kernel-worker-init` includes both ports as transferables
 *   - `ready` resolves once the worker echoes `kernel-worker-ready`
 *   - `ready` rejects with a timeout if the worker never replies
 *   - `dispose()` calls `terminate()` and closes the page-side ports
 */

import { describe, it, expect, vi } from 'vitest';
import { bootstrapKernelWorker, type WorkerLike } from '../../src/kernel/spawn.js';
import type { CDPTransport } from '../../src/cdp/transport.js';
import type { OffscreenClientCallbacks } from '../../src/ui/offscreen-client.js';

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
  /** Hand-written reply: when `init` is received, post `ready` back via this port. */
  replyWith?: (init: { kernelPort: MessagePort; cdpPort: MessagePort }) => void;
}

function makeMockWorker(opts?: { autoReady?: boolean; readyDelay?: number }): MockWorker {
  const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  let terminateCalls = 0;
  const worker: MockWorker = {
    posted,
    terminateCalls,
    postMessage(message, transfer) {
      posted.push({ message, transfer });
      const data = message as { type?: string; kernelPort?: MessagePort };
      if (opts?.autoReady && data?.type === 'kernel-worker-init' && data.kernelPort) {
        const port = data.kernelPort;
        port.start();
        const send = () => port.postMessage({ type: 'kernel-worker-ready' });
        if (opts.readyDelay) setTimeout(send, opts.readyDelay);
        else queueMicrotask(send);
      }
    },
    terminate() {
      // Manually mutate the surface — easier for tests.
      (worker as unknown as { terminateCalls: number }).terminateCalls = ++terminateCalls;
    },
  };
  return worker;
}

describe('bootstrapKernelWorker', () => {
  it('returns a client immediately and posts kernel-worker-init with transferables', () => {
    const worker = makeMockWorker();
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
    });

    expect(host.client).toBeDefined();
    expect(worker.posted).toHaveLength(1);
    const initPost = worker.posted[0];
    const init = initPost.message as {
      type: string;
      kernelPort: MessagePort;
      cdpPort: MessagePort;
    };
    expect(init.type).toBe('kernel-worker-init');
    expect(init.kernelPort).toBeInstanceOf(MessagePort);
    expect(init.cdpPort).toBeInstanceOf(MessagePort);
    expect(initPost.transfer).toHaveLength(2);
    // Identity check — `toContain` does deep-equal which recurses into
    // MessagePort's internal cycles and stack-overflows.
    expect(initPost.transfer?.[0] === init.kernelPort).toBe(true);
    expect(initPost.transfer?.[1] === init.cdpPort).toBe(true);

    host.dispose();
  });

  it('ready resolves when the worker posts kernel-worker-ready', async () => {
    const worker = makeMockWorker({ autoReady: true });
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      readyTimeoutMs: 1_000,
    });

    await expect(host.ready).resolves.toBeUndefined();
    host.dispose();
  });

  it('ready rejects with a timeout if the worker never replies', async () => {
    const worker = makeMockWorker(); // no autoReady
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      readyTimeoutMs: 50,
    });

    await expect(host.ready).rejects.toThrow(/did not signal ready/);
    host.dispose();
  });

  it('dispose calls worker.terminate() and posts kernel-worker-shutdown', async () => {
    const worker = makeMockWorker({ autoReady: true });
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      readyTimeoutMs: 1_000,
    });
    await host.ready;

    expect(worker.terminateCalls).toBe(0);
    host.dispose();
    expect(worker.terminateCalls).toBe(1);

    const shutdown = worker.posted.find(
      (p) => (p.message as { type?: string })?.type === 'kernel-worker-shutdown'
    );
    expect(shutdown).toBeDefined();
  });

  it('dispose is idempotent', async () => {
    const worker = makeMockWorker({ autoReady: true });
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      readyTimeoutMs: 1_000,
    });
    await host.ready;

    host.dispose();
    host.dispose();
    expect(worker.terminateCalls).toBe(1);
  });
});
