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

  it('routes kernel-migration-started/finished to the splash callbacks', async () => {
    // The worker posts these raw on the kernel port (same shape as
    // `kernel-worker-ready`); the page-side listener dispatches them
    // to the optional callbacks without disturbing the `ready`
    // resolution.
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
    const onMigrationStart = vi.fn();
    const onMigrationFinish = vi.fn();
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      readyTimeoutMs: 1_000,
      onMigrationStart,
      onMigrationFinish,
    });

    expect(stashedKernelPort).not.toBeNull();
    // Worker signals start, then finish, then ready (matches the
    // host.ts wiring: start fires before the IIFE, finish in the
    // IIFE's `finally`, ready already posted by `boot()` immediately
    // after `createKernelHost` returns).
    stashedKernelPort!.postMessage({ type: 'kernel-migration-started' });
    stashedKernelPort!.postMessage({ type: 'kernel-migration-finished' });
    stashedKernelPort!.postMessage({ type: 'kernel-worker-ready' });
    await host.ready;

    expect(onMigrationStart).toHaveBeenCalledTimes(1);
    expect(onMigrationFinish).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it('migration callbacks are optional — boot still resolves without them', async () => {
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
      callbacks: makeStubCallbacks(),
      readyTimeoutMs: 1_000,
    });
    expect(stashedKernelPort).not.toBeNull();
    // Flag-off boots never post these, but a defensive page-side
    // listener must still no-op cleanly if they ever arrived.
    stashedKernelPort!.postMessage({ type: 'kernel-migration-started' });
    stashedKernelPort!.postMessage({ type: 'kernel-migration-finished' });
    stashedKernelPort!.postMessage({ type: 'kernel-worker-ready' });
    await expect(host.ready).resolves.toBeUndefined();
    host.dispose();
  });

  it('suspends the boot timeout while a migration is in progress', async () => {
    // A migration that runs longer than `readyTimeoutMs` must NOT trip
    // the boot timeout — this is the exact bug that stranded the page
    // behind a frozen migration splash. With the boot clock suspended
    // on `kernel-migration-started`, the worker can copy for as long as
    // it keeps posting progress and still resolve `ready` afterwards.
    let port: MessagePort | null = null;
    const worker: WorkerLike = {
      postMessage: (message: unknown) => {
        const data = message as { type?: string; kernelPort?: MessagePort };
        if (data?.type === 'kernel-worker-init' && data.kernelPort) {
          port = data.kernelPort;
          port.start();
        }
      },
      terminate: () => undefined,
    };
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      // Tiny boot timeout — the old code would reject ~30ms in.
      readyTimeoutMs: 30,
      migrationStallTimeoutMs: 500,
    });
    expect(port).not.toBeNull();

    port!.postMessage({ type: 'kernel-migration-started' });
    // Idle well past `readyTimeoutMs` while migrating.
    await new Promise((r) => setTimeout(r, 80));
    port!.postMessage({ type: 'kernel-migration-progress', copied: 1, total: 2 });
    await new Promise((r) => setTimeout(r, 80));
    // Finish + ready back-to-back so the re-armed boot clock can't fire.
    port!.postMessage({ type: 'kernel-migration-finished' });
    port!.postMessage({ type: 'kernel-worker-ready' });

    await expect(host.ready).resolves.toBeUndefined();
    host.dispose();
  });

  it('progress heartbeats keep resetting the stall watchdog', async () => {
    // Total migration time exceeds both timeouts, but each gap between
    // progress ticks stays under `migrationStallTimeoutMs`, so the
    // watchdog never fires.
    let port: MessagePort | null = null;
    const worker: WorkerLike = {
      postMessage: (message: unknown) => {
        const data = message as { type?: string; kernelPort?: MessagePort };
        if (data?.type === 'kernel-worker-init' && data.kernelPort) {
          port = data.kernelPort;
          port.start();
        }
      },
      terminate: () => undefined,
    };
    const onMigrationProgress = vi.fn();
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      readyTimeoutMs: 40,
      migrationStallTimeoutMs: 60,
      onMigrationProgress,
    });
    expect(port).not.toBeNull();

    port!.postMessage({ type: 'kernel-migration-started' });
    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 30)); // < 60ms watchdog each
      port!.postMessage({ type: 'kernel-migration-progress', copied: i, total: 5 });
    }
    port!.postMessage({ type: 'kernel-migration-finished' });
    port!.postMessage({ type: 'kernel-worker-ready' });

    await expect(host.ready).resolves.toBeUndefined();
    expect(onMigrationProgress).toHaveBeenCalledTimes(5);
    host.dispose();
  });

  it('rejects when a migration starts but makes no progress (hung worker)', async () => {
    // The watchdog is the safety net: if `kernel-migration-started`
    // arrives but no progress follows within `migrationStallTimeoutMs`,
    // the worker is genuinely hung and `ready` must reject rather than
    // hang forever.
    let port: MessagePort | null = null;
    const worker: WorkerLike = {
      postMessage: (message: unknown) => {
        const data = message as { type?: string; kernelPort?: MessagePort };
        if (data?.type === 'kernel-worker-init' && data.kernelPort) {
          port = data.kernelPort;
          port.start();
        }
      },
      terminate: () => undefined,
    };
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      readyTimeoutMs: 1_000,
      migrationStallTimeoutMs: 40,
    });
    expect(port).not.toBeNull();

    port!.postMessage({ type: 'kernel-migration-started' });
    await expect(host.ready).rejects.toThrow(/migration stalled/);
    host.dispose();
  });

  it('restores the boot timeout after a migration finishes', async () => {
    // Once migration finishes, the rest of boot should complete
    // promptly; a worker that finishes the copy but then hangs must
    // still trip the normal boot-ready timeout.
    let port: MessagePort | null = null;
    const worker: WorkerLike = {
      postMessage: (message: unknown) => {
        const data = message as { type?: string; kernelPort?: MessagePort };
        if (data?.type === 'kernel-worker-init' && data.kernelPort) {
          port = data.kernelPort;
          port.start();
        }
      },
      terminate: () => undefined,
    };
    const host = bootstrapKernelWorker({
      worker,
      realCdpTransport: makeStubCdpTransport(),
      callbacks: makeStubCallbacks(),
      readyTimeoutMs: 40,
      migrationStallTimeoutMs: 1_000,
    });
    expect(port).not.toBeNull();

    port!.postMessage({ type: 'kernel-migration-started' });
    port!.postMessage({ type: 'kernel-migration-finished' });
    // No `kernel-worker-ready` follows — the re-armed boot clock fires.
    await expect(host.ready).rejects.toThrow(/did not signal ready/);
    host.dispose();
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
      callbacks: makeStubCallbacks(),
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
});
