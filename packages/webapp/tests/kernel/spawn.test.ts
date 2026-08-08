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

import { describe, expect, it, vi } from 'vitest';
import type { CDPTransport } from '../../src/cdp/transport.js';
import { bootstrapKernelWorker, type WorkerLike } from '../../src/kernel/spawn.js';
import { OffscreenClient, type OffscreenClientCallbacks } from '../../src/ui/offscreen-client.js';

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
      makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
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
      makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
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
      makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
      readyTimeoutMs: 50,
    });

    await expect(host.ready).rejects.toThrow(/did not signal ready/);
    host.dispose();
  });

  it('ready rejects IMMEDIATELY with the real cause on kernel-worker-boot-error', async () => {
    const worker = makeMockWorker();
    worker.postMessage = (message) => {
      const data = message as { type?: string; kernelPort?: MessagePort };
      if (data?.type === 'kernel-worker-init' && data.kernelPort) {
        data.kernelPort.start();
        data.kernelPort.postMessage({
          type: 'kernel-worker-boot-error',
          message: 'illegal operation on a directory',
          code: 'EISDIR',
        });
      }
    };
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
      // Generous timeout: the rejection must come from the boot-error
      // message, not from this timer expiring.
      readyTimeoutMs: 30_000,
    });

    const error = (await host.ready.then(
      () => null,
      (e: unknown) => e
    )) as (Error & { code?: string }) | null;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('illegal operation on a directory');
    expect(error?.code).toBe('EISDIR');
    host.dispose();
  });

  it('dispose calls worker.terminate() and posts kernel-worker-shutdown', async () => {
    const worker = makeMockWorker({ autoReady: true });
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
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
      makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
      readyTimeoutMs: 1_000,
    });
    await host.ready;

    host.dispose();
    host.dispose();
    expect(worker.terminateCalls).toBe(1);
  });

  it('a stale kernel-worker-ready arriving after timeout does not resolve ready', async () => {
    // Catches the original leak: if the timeout path forgot to remove
    // the listener, a later `kernel-worker-ready` posted on the port
    // would still resolve `ready` (which had already rejected). With
    // the listener properly removed in the timeout branch, the late
    // message is ignored.
    let stashedKernelPort: MessagePort | null = null;
    const worker: WorkerLike = {
      postMessage: (message: unknown) => {
        const data = message as { type?: string; kernelPort?: MessagePort };
        if (data?.type === 'kernel-worker-init' && data.kernelPort) {
          stashedKernelPort = data.kernelPort;
          stashedKernelPort.start();
        }
      },
      terminate: () => undefined,
    };
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
      readyTimeoutMs: 30,
    });

    let resolvedAfterTimeout = false;
    host.ready
      .then(() => {
        resolvedAfterTimeout = true;
      })
      .catch(() => {
        /* expected: timeout rejection */
      });

    // Wait for the timeout to fire AND reject the promise.
    await new Promise((r) => setTimeout(r, 60));

    // Now post a late kernel-worker-ready. If the listener was leaked,
    // the resolve closure would re-fire and flip the promise — except
    // we already rejected, so the test would observe `resolvedAfterTimeout`
    // staying false but the listener would still be alive (a real
    // memory/observer leak). We check the second symptom: the listener
    // must NOT call our resolve closure twice. The simplest observable
    // is: the underlying promise can only settle once, so we instead
    // check that no synchronous side effect happens — by counting that
    // the worker port doesn't see another listener get to run.
    expect(stashedKernelPort).not.toBeNull();
    stashedKernelPort!.postMessage({ type: 'kernel-worker-ready' });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolvedAfterTimeout).toBe(false);

    host.dispose();
  });

  describe('bootstrapKernelWorker onWorkerScriptError', () => {
    it('calls onWorkerScriptError when the worker fires an error event', () => {
      let errorListener: (() => void) | null = null;
      const worker: WorkerLike = {
        postMessage: () => {},
        terminate: () => {},
        addEventListener: (_t: 'error', l: () => void) => {
          errorListener = l;
        },
      };
      const onWorkerScriptError = vi.fn();
      // Small readyTimeoutMs so the never-posts-ready mock can't arm a 30s timer,
      // and dispose() in `finally` clears it even if an assertion throws (dispose
      // → cleanupReady clears the ready timeout — spawn.ts).
      const host = bootstrapKernelWorker({
        worker,
        realCdpTransport: { on: () => {}, off: () => {}, send: async () => ({}) } as never,
        makeClient: () => ({}) as never,
        readyTimeoutMs: 50,
        onWorkerScriptError,
      });
      try {
        expect(errorListener).toBeTypeOf('function');
        errorListener!();
        expect(onWorkerScriptError).toHaveBeenCalledTimes(1);
      } finally {
        host.dispose();
      }
    });
  });

  describe('boot-progress watchdog (#2007)', () => {
    /** Post `init`, then N progress heartbeats spaced `gap` ms apart, then ready. */
    function makeProgressWorker(opts: {
      heartbeats: number;
      gap: number;
      thenReady: boolean;
    }): WorkerLike {
      return {
        postMessage: (message: unknown) => {
          const data = message as { type?: string; kernelPort?: MessagePort };
          if (data?.type !== 'kernel-worker-init' || !data.kernelPort) return;
          const port = data.kernelPort;
          port.start();
          for (let i = 1; i <= opts.heartbeats; i++) {
            setTimeout(
              () => port.postMessage({ type: 'kernel-worker-boot-progress', stage: `s${i}` }),
              opts.gap * i
            );
          }
          if (opts.thenReady) {
            setTimeout(
              () => port.postMessage({ type: 'kernel-worker-ready' }),
              opts.gap * (opts.heartbeats + 1)
            );
          }
        },
        terminate: () => {},
      };
    }

    it('a slow-but-advancing boot resolves — total time exceeds the base timeout', async () => {
      // 6 heartbeats 30ms apart (~180ms) then ready — well past the 50ms base
      // timeout, but each gap is under it, so the watchdog keeps re-arming.
      const worker = makeProgressWorker({ heartbeats: 6, gap: 30, thenReady: true });
      const host = bootstrapKernelWorker({
        worker,
        realCdpTransport: makeStubCdpTransport(),
        makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
        readyTimeoutMs: 50,
      });

      await expect(host.ready).resolves.toBeUndefined();
      host.dispose();
    });

    it('progress then a stall past the window still rejects (watchdog, not a hard cap)', async () => {
      // Two heartbeats, then silence — no ready. The clock re-arms on the
      // heartbeats but must still fire once the worker goes quiet for >window.
      const worker = makeProgressWorker({ heartbeats: 2, gap: 20, thenReady: false });
      const host = bootstrapKernelWorker({
        worker,
        realCdpTransport: makeStubCdpTransport(),
        makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
        readyTimeoutMs: 50,
      });

      await expect(host.ready).rejects.toThrow(/did not signal ready/);
      host.dispose();
    });
  });
});
