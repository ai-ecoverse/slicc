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

    expect(initPost.transfer?.[0] === init.kernelPort).toBe(true);
    expect(initPost.transfer?.[1] === init.cdpPort).toBe(true);

    host.dispose();
  });

  it("carries the page's own URL so the worker can skip the leader tab", () => {
    vi.stubGlobal('location', { href: 'https://www.sliccy.ai/?slicc=leader&ext=abc' });
    try {
      const worker = makeMockWorker();
      const host = bootstrapKernelWorker({
        worker,
        realCdpTransport: makeStubCdpTransport(),
        makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
      });
      const init = worker.posted[0].message as { appPageUrl?: string | null };
      expect(init.appPageUrl).toBe('https://www.sliccy.ai/?slicc=leader&ext=abc');
      host.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends a null page URL in a realm without a location', () => {
    const worker = makeMockWorker();
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
    });
    const init = worker.posted[0].message as { appPageUrl?: string | null };
    expect(init.appPageUrl).toBeNull();
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
    const worker = makeMockWorker();
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
      .catch(() => {});

    await new Promise((r) => setTimeout(r, 60));

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
      onBootProgress?: (stage: string) => void;
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

    await new Promise((r) => setTimeout(r, 150));
    expect(stalls.length).toBeGreaterThanOrEqual(2);

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

    await new Promise((r) => setTimeout(r, 90));
    expect(stalls).toEqual([1]);

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

    port().postMessage({ type: 'kernel-worker-ready' });
    await new Promise((r) => setTimeout(r, 20));
    expect(onLateReady).toHaveBeenCalledTimes(1);

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

    expect(Date.now() - started).toBeLessThan(140);
    host.dispose();
  });

  it('a paused deadline ignores silence, including silence after progress', async () => {
    const { worker, port } = makeManualWorker();
    const stages: string[] = [];
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      makeClient: (transport) => new OffscreenClient(makeStubCallbacks(), transport),
      readyTimeoutMs: 40,
      readyStallLimit: 1,
      onBootProgress: (stage) => stages.push(stage),
    });
    host.pauseReadyDeadline();
    port().postMessage({ type: 'kernel-worker-boot-progress', stage: 'orchestrator-ready' });

    await new Promise((r) => setTimeout(r, 120));
    let settled = false;
    host.ready.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(stages).toEqual(['orchestrator-ready']);
    host.restartReadyDeadline();
    port().postMessage({ type: 'kernel-worker-ready' });
    await expect(host.ready).resolves.toBeUndefined();
    host.dispose();
  });

  it('restart arms a fresh window that still rejects on silence', async () => {
    const { worker } = makeManualWorker();
    const host = bootstrap(worker, { readyTimeoutMs: 50, readyStallLimit: 1 });
    host.pauseReadyDeadline();
    await new Promise((r) => setTimeout(r, 80));
    host.restartReadyDeadline();
    const started = Date.now();
    await expect(host.ready).rejects.toThrow(/did not signal ready within 50ms/);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(150);
    host.dispose();
  });

  it('progress after restart extends the window', async () => {
    const { worker, port } = makeManualWorker();
    const host = bootstrap(worker, { readyTimeoutMs: 70, readyStallLimit: 1 });
    host.restartReadyDeadline();
    await new Promise((r) => setTimeout(r, 40));
    port().postMessage({ type: 'kernel-worker-boot-progress', stage: 'mounts-restored' });
    await new Promise((r) => setTimeout(r, 40));
    port().postMessage({ type: 'kernel-worker-ready' });
    await expect(host.ready).resolves.toBeUndefined();
    host.dispose();
  });

  it('ignores boot progress after the deadline rejects', async () => {
    const { worker, port } = makeManualWorker();
    const stages: string[] = [];
    const host = bootstrap(worker, {
      readyTimeoutMs: 40,
      readyStallLimit: 1,
      onLateReady: () => {},
      onBootProgress: (stage) => stages.push(stage),
    });
    await expect(host.ready).rejects.toThrow(/did not signal ready/);
    port().postMessage({ type: 'kernel-worker-boot-progress', stage: 'cone-bootstrapped' });
    await new Promise((r) => setTimeout(r, 30));
    expect(stages).toEqual([]);
    host.dispose();
  });

  it('a stall after progress names the last stage', async () => {
    const { worker, port } = makeManualWorker();
    const host = bootstrap(worker, { readyTimeoutMs: 40, readyStallLimit: 1 });
    port().postMessage({ type: 'kernel-worker-boot-progress', stage: 'lick-manager-ready' });
    await expect(host.ready).rejects.toThrow(/last progress: lick-manager-ready/);
    host.dispose();
  });
});
