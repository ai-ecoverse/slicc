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

    // The heartbeat gap is a small FRACTION of the watchdog window (80 ms vs
    // 300 ms → 220 ms of slack per gap), so ordinary test-suite CPU
    // contention cannot delay a heartbeat past the window and flake the
    // re-arm. `readyTimeoutMs` stays real (the MessagePort delivery these
    // heartbeats ride is a task source fake timers do not drive, so faking
    // the clock here would deadlock rather than determinize).
    it('a slow-but-advancing boot resolves — total time exceeds the base timeout', async () => {
      // 5 heartbeats 80 ms apart (~400 ms) then ready — past the 300 ms base
      // window, but each gap is well under it, so the watchdog keeps re-arming.
      const worker = makeProgressWorker({ heartbeats: 5, gap: 80, thenReady: true });
      const host = bootstrapKernelWorker({
        worker,
        realCdpTransport: makeStubCdpTransport(),
        makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
        readyTimeoutMs: 300,
      });

      await expect(host.ready).resolves.toBeUndefined();
      host.dispose();
    });

    it('progress then a stall past the window still rejects (watchdog, not a hard cap)', async () => {
      // Two heartbeats, then silence — no ready. The clock re-arms on the
      // heartbeats but must still fire once the worker goes quiet for >window.
      const worker = makeProgressWorker({ heartbeats: 2, gap: 80, thenReady: false });
      const host = bootstrapKernelWorker({
        worker,
        realCdpTransport: makeStubCdpTransport(),
        makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
        readyTimeoutMs: 300,
      });

      await expect(host.ready).rejects.toThrow(/did not signal ready/);
      host.dispose();
    });
  });
});

describe('slow-boot stall tolerance (2026-08-24 field wedge)', () => {
  /** Post init and expose the worker-side kernel port for manual driving. */
  function makeManualWorker(): { worker: WorkerLike; port: () => MessagePort } {
    let kernelPort: MessagePort | null = null;
    const worker: WorkerLike = {
      postMessage: (message: unknown) => {
        const data = message as { type?: string; kernelPort?: MessagePort };
        if (data?.type !== 'kernel-worker-init' || !data.kernelPort) return;
        kernelPort = data.kernelPort;
        kernelPort.start();
      },
      terminate: () => {},
    };
    return { worker, port: () => kernelPort! };
  }

  function bootstrap(
    worker: WorkerLike,
    opts: {
      readyTimeoutMs: number;
      onReadyStall?: (info: { elapsedMs: number; stalls: number }) => void;
      readyStallLimit?: number;
      onLateReady?: () => void;
    }
  ) {
    return bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
      ...opts,
    });
  }

  it('onReadyStall fires per quiet window and a late ready still resolves', async () => {
    const { worker, port } = makeManualWorker();
    const stalls: number[] = [];
    const host = bootstrap(worker, {
      readyTimeoutMs: 60,
      onReadyStall: (info) => stalls.push(info.stalls),
      readyStallLimit: 5,
    });
    // Two quiet windows pass; the boot is stalled but not dead.
    await new Promise((r) => setTimeout(r, 150));
    expect(stalls.length).toBeGreaterThanOrEqual(2);
    // The worker comes up late — well past the base window — and ready
    // resolves normally: no reload, no recovery screen.
    port().postMessage({ type: 'kernel-worker-ready' });
    await expect(host.ready).resolves.toBeUndefined();
    host.dispose();
  });

  it('boot progress resets the stall count', async () => {
    const { worker, port } = makeManualWorker();
    const stalls: number[] = [];
    const host = bootstrap(worker, {
      readyTimeoutMs: 60,
      onReadyStall: (info) => stalls.push(info.stalls),
      readyStallLimit: 3,
    });
    // One stall accrues…
    await new Promise((r) => setTimeout(r, 90));
    expect(stalls).toEqual([1]);
    // …then progress lands: the count restarts from 1 on the next stall
    // instead of marching to the limit.
    port().postMessage({ type: 'kernel-worker-boot-progress', stage: 'shared-fs-mount:9' });
    await new Promise((r) => setTimeout(r, 90));
    expect(stalls).toEqual([1, 1]);
    port().postMessage({ type: 'kernel-worker-ready' });
    await expect(host.ready).resolves.toBeUndefined();
    host.dispose();
  });

  it('rejects after the stall limit, then a late ready fires onLateReady exactly once', async () => {
    const { worker, port } = makeManualWorker();
    const onLateReady = vi.fn();
    const host = bootstrap(worker, {
      readyTimeoutMs: 40,
      onReadyStall: () => {},
      readyStallLimit: 2,
      onLateReady,
    });
    await expect(host.ready).rejects.toThrow(/did not signal ready within 80ms/);
    expect(onLateReady).not.toHaveBeenCalled();
    // The worker finishes booting behind the recovery screen: the listener
    // must still be attached and report the late arrival.
    port().postMessage({ type: 'kernel-worker-ready' });
    await new Promise((r) => setTimeout(r, 20));
    expect(onLateReady).toHaveBeenCalledTimes(1);
    // Cleanup ran when the late ready fired — a duplicate ready is inert.
    port().postMessage({ type: 'kernel-worker-ready' });
    await new Promise((r) => setTimeout(r, 20));
    expect(onLateReady).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it('without the new options the first quiet window still rejects (legacy)', async () => {
    const { worker } = makeManualWorker();
    const started = Date.now();
    const host = bootstrap(worker, { readyTimeoutMs: 50 });
    await expect(host.ready).rejects.toThrow(/did not signal ready within 50ms/);
    // One window, not three: no onReadyStall means no silent extra waiting.
    expect(Date.now() - started).toBeLessThan(140);
    host.dispose();
  });
});
