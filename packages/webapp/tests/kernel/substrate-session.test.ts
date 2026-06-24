/**
 * Unit tests for `SubstrateSessionRegistry`.
 *
 * Uses a stub shell factory (returns canned {stdout,stderr,exitCode})
 * and an injectable clock for the sweepIdle GC tests.
 *
 * Tests follow the TDD red→green cycle.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import type {
  ExecFrame,
  ExecResult,
  SubstrateSessionRegistry,
} from '../../src/kernel/substrate-session.js';
import {
  createSubstrateSessionRegistry,
  IDLE_RETAIN_MS,
  SUBSTRATE_SWEEP_INTERVAL_MS,
  startSubstrateSweep,
  TAIL_CAP_CHARS,
} from '../../src/kernel/substrate-session.js';

// ---------------------------------------------------------------------------
// Stub shell factory
// ---------------------------------------------------------------------------

interface StubShell {
  executeCommand: ReturnType<typeof vi.fn>;
  getCwd: () => string;
  dispose: ReturnType<typeof vi.fn>;
}

function makeStubShell(opts?: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
}): StubShell {
  const stdout = opts?.stdout ?? 'hello';
  const stderr = opts?.stderr ?? '';
  const exitCode = opts?.exitCode ?? 0;
  const delayMs = opts?.delayMs;
  return {
    executeCommand: vi.fn(async (_cmd: string, signal?: AbortSignal) => {
      if (delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delayMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        }).catch(() => undefined);
      }
      return { stdout, stderr, exitCode };
    }),
    getCwd: () => '/workspace',
    dispose: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFactory(
  shell: StubShell
): (_sid: string, opts: { cwd?: string; env?: Record<string, string> }) => StubShell {
  return vi.fn(() => shell);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubstrateSessionRegistry', () => {
  let registry: SubstrateSessionRegistry;

  afterEach(() => {
    registry?.dispose();
  });

  // -------------------------------------------------------------------------
  it('creates a session on first exec and reuses it on subsequent calls', async () => {
    const shell = makeStubShell();
    const factory = makeFactory(shell);

    registry = createSubstrateSessionRegistry({ shellFactory: factory });

    await registry.runExec('sess-1', 'echo hi');
    await registry.runExec('sess-1', 'echo world');

    // Factory must be called only once for the same sessionId
    expect(factory).toHaveBeenCalledTimes(1);
    // Shell.executeCommand should be called twice
    expect(shell.executeCommand).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  it('returns correct stdout / stderr / exitCode from runExec', async () => {
    const shell = makeStubShell({ stdout: 'out', stderr: 'err', exitCode: 42 });
    registry = createSubstrateSessionRegistry({ shellFactory: makeFactory(shell) });

    const result: ExecResult = await registry.runExec('sess-2', 'cmd');

    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.exitCode).toBe(42);
  });

  // -------------------------------------------------------------------------
  it('appends to a bounded tail (keeps LATEST chars on overflow)', async () => {
    // Build a string that exceeds the 64K-char cap.
    const bigChunk = 'x'.repeat(32 * 1024); // 32K chars per call
    const shell = makeStubShell({ stdout: bigChunk });
    registry = createSubstrateSessionRegistry({ shellFactory: makeFactory(shell) });

    // Three calls: 3 × 32K chars stdout = 96K chars > 64K cap.
    await registry.runExec('sess-3', 'a');
    await registry.runExec('sess-3', 'b');
    await registry.runExec('sess-3', 'c');

    const status = registry.sessionStatus('sess-3');
    expect(status.alive).toBe(true);
    expect(status.bufferedTail.length).toBeLessThanOrEqual(TAIL_CAP_CHARS);

    // The tail must contain the LAST appended content (not the first).
    // The last chunk was from call 'c' which produced bigChunk.
    expect(status.bufferedTail).toContain(bigChunk.slice(-100));
  });

  // -------------------------------------------------------------------------
  it('streamExec emits stdout frame, stderr frame, then exit frame', async () => {
    const shell = makeStubShell({ stdout: 'stdout-data', stderr: 'stderr-data', exitCode: 7 });
    registry = createSubstrateSessionRegistry({ shellFactory: makeFactory(shell) });

    const frames: ExecFrame[] = [];
    await registry.streamExec('sess-4', 'cmd', (f) => frames.push(f));

    // Must have at least one stdout frame, one stderr frame, and one exit frame
    const stdoutFrames = frames.filter(
      (f): f is { t: 'stdout' | 'stderr'; d: string } => f.t === 'stdout'
    );
    const stderrFrames = frames.filter(
      (f): f is { t: 'stdout' | 'stderr'; d: string } => f.t === 'stderr'
    );
    const exitFrames = frames.filter(
      (f): f is { t: 'exit'; code: number; pid: number | null } => f.t === 'exit'
    );

    expect(stdoutFrames.length).toBeGreaterThan(0);
    expect(stdoutFrames.map((f) => f.d).join('')).toBe('stdout-data');

    expect(stderrFrames.length).toBeGreaterThan(0);
    expect(stderrFrames.map((f) => f.d).join('')).toBe('stderr-data');

    expect(exitFrames.length).toBe(1);
    expect(exitFrames[0].code).toBe(7);

    // Frames order: all stdout/stderr must come before exit
    const exitIdx = frames.findIndex((f) => f.t === 'exit');
    const outputAfterExit = frames.slice(exitIdx + 1).filter((f) => f.t !== 'exit');
    expect(outputAfterExit).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it('streamExec emits no stdout/stderr frames when both are empty', async () => {
    const shell = makeStubShell({ stdout: '', stderr: '', exitCode: 0 });
    registry = createSubstrateSessionRegistry({ shellFactory: makeFactory(shell) });

    const frames: ExecFrame[] = [];
    await registry.streamExec('sess-empty', 'cmd', (f) => frames.push(f));

    const nonExit = frames.filter((f) => f.t !== 'exit');
    expect(nonExit).toHaveLength(0);

    const exitFrames = frames.filter((f) => f.t === 'exit');
    expect(exitFrames).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  it('sweepIdle disposes sessions idle past the retain window', async () => {
    const shell = makeStubShell();
    const factory = makeFactory(shell);
    const now = vi.fn(() => 0);

    registry = createSubstrateSessionRegistry({ shellFactory: factory, now });

    // Run a command at t=0; lastActiveAt is set
    await registry.runExec('sess-gc', 'cmd');

    // Verify session is alive
    expect(registry.sessionStatus('sess-gc').alive).toBe(true);

    // Advance clock just under the retain window — should NOT dispose
    now.mockReturnValue(IDLE_RETAIN_MS - 1);
    registry.sweepIdle(IDLE_RETAIN_MS - 1);
    expect(registry.sessionStatus('sess-gc').alive).toBe(true);

    // Advance clock past the retain window — should dispose
    now.mockReturnValue(IDLE_RETAIN_MS + 1);
    registry.sweepIdle(IDLE_RETAIN_MS + 1);

    expect(shell.dispose).toHaveBeenCalledTimes(1);
    expect(registry.sessionStatus('sess-gc').alive).toBe(false);
  });

  // -------------------------------------------------------------------------
  it('sessionStatus returns alive:false and empty tail for unknown session', () => {
    registry = createSubstrateSessionRegistry({
      shellFactory: makeFactory(makeStubShell()),
    });

    const status = registry.sessionStatus('non-existent');
    expect(status.alive).toBe(false);
    expect(status.bufferedTail).toBe('');
    expect(status.runningPids).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it('registers a kind:shell process in ProcessManager during exec', async () => {
    const pm = new ProcessManager();
    const shell = makeStubShell({ stdout: 'hi' });
    registry = createSubstrateSessionRegistry({
      shellFactory: makeFactory(shell),
      processManager: pm,
      processOwner: { kind: 'system' },
    });

    const spawnSpy = vi.spyOn(pm, 'spawn');
    const exitSpy = vi.spyOn(pm, 'exit');

    await registry.runExec('sess-pm', 'echo hi');

    expect(spawnSpy).toHaveBeenCalledOnce();
    const spawnCall = spawnSpy.mock.calls[0][0];
    expect(spawnCall.kind).toBe('shell');
    expect(spawnCall.argv[0]).toBe('echo hi');

    expect(exitSpy).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  it('dispose tears down all sessions', async () => {
    const shell = makeStubShell();
    registry = createSubstrateSessionRegistry({ shellFactory: makeFactory(shell) });

    await registry.runExec('sess-a', 'cmd');
    await registry.runExec('sess-b', 'cmd');

    registry.dispose();

    expect(shell.dispose).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  it('different sessionIds get independent sessions', async () => {
    const shell1 = makeStubShell({ stdout: 'from-a' });
    const shell2 = makeStubShell({ stdout: 'from-b' });
    let callCount = 0;
    const factory = vi.fn(() => {
      callCount++;
      return callCount === 1 ? shell1 : shell2;
    });

    registry = createSubstrateSessionRegistry({
      shellFactory: factory as unknown as Parameters<
        typeof createSubstrateSessionRegistry
      >[0]['shellFactory'],
    });

    const r1 = await registry.runExec('sess-x', 'cmd');
    const r2 = await registry.runExec('sess-y', 'cmd');

    expect(factory).toHaveBeenCalledTimes(2);
    expect(r1.stdout).toBe('from-a');
    expect(r2.stdout).toBe('from-b');
  });

  // -------------------------------------------------------------------------
  // Concurrency guard (Important 2): a second overlapping exec on the SAME
  // session is rejected — the headless shell isn't concurrency-safe, and
  // runningPids must not be corrupted by an interleaved push/filter.
  // -------------------------------------------------------------------------

  /** Stub shell whose single in-flight exec resolves only when released. */
  function makeDeferredShell(): {
    shell: StubShell;
    release: (out: { stdout: string; stderr: string; exitCode: number }) => void;
    started: () => boolean;
    executeCommand: ReturnType<typeof vi.fn>;
  } {
    let resolveFn: ((v: { stdout: string; stderr: string; exitCode: number }) => void) | null =
      null;
    let didStart = false;
    const executeCommand = vi.fn(
      (_cmd: string, _signal?: AbortSignal) =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          didStart = true;
          resolveFn = resolve;
        })
    );
    const shell: StubShell = {
      executeCommand,
      getCwd: () => '/workspace',
      dispose: vi.fn(),
    };
    return {
      shell,
      release: (out) => resolveFn?.(out),
      started: () => didStart,
      executeCommand,
    };
  }

  it('rejects a concurrent exec on a busy session (runExec) without corrupting pids', async () => {
    const pm = new ProcessManager();
    const deferred = makeDeferredShell();
    registry = createSubstrateSessionRegistry({
      shellFactory: makeFactory(deferred.shell),
      processManager: pm,
      processOwner: { kind: 'system' },
    });

    // Start the first exec but DON'T await it — it hangs until released.
    const first = registry.runExec('sess-busy', 'slow-cmd');
    // Let the microtask reach `executeCommand`.
    await Promise.resolve();
    expect(deferred.started()).toBe(true);

    // While the first is in flight, a second exec on the SAME session is
    // rejected synchronously with the busy exit code.
    const second = await registry.runExec('sess-busy', 'other-cmd');
    expect(second.exitCode).toBe(130);
    expect(second.stderr).toMatch(/busy/i);
    expect(second.pid).toBeNull();
    // executeCommand was only entered once (the second never reached it).
    expect(deferred.executeCommand).toHaveBeenCalledTimes(1);

    // Exactly one running pid while busy (no double-push corruption).
    expect(registry.sessionStatus('sess-busy').runningPids).toHaveLength(1);

    // Release the first exec; it completes cleanly and clears the pid.
    deferred.release({ stdout: 'done', stderr: '', exitCode: 0 });
    const firstResult = await first;
    expect(firstResult.stdout).toBe('done');
    expect(firstResult.exitCode).toBe(0);
    expect(registry.sessionStatus('sess-busy').runningPids).toHaveLength(0);

    // After the first finished, the session is reusable again.
    deferred.executeCommand.mockResolvedValueOnce({ stdout: 'again', stderr: '', exitCode: 0 });
    const third = await registry.runExec('sess-busy', 'cmd');
    expect(third.exitCode).toBe(0);
  });

  it('rejects a concurrent exec on a busy session (streamExec) with a busy exit frame', async () => {
    const deferred = makeDeferredShell();
    registry = createSubstrateSessionRegistry({
      shellFactory: makeFactory(deferred.shell),
    });

    const firstFrames: ExecFrame[] = [];
    const first = registry.streamExec('sess-busy2', 'slow-cmd', (f) => firstFrames.push(f));
    await Promise.resolve();
    expect(deferred.started()).toBe(true);

    // Concurrent streamExec → busy exit frame, no stdout frames.
    const secondFrames: ExecFrame[] = [];
    await registry.streamExec('sess-busy2', 'other', (f) => secondFrames.push(f));

    const exitFrame = secondFrames.find((f) => f.t === 'exit');
    expect(exitFrame).toEqual({ t: 'exit', code: 130, pid: null });
    expect(secondFrames.some((f) => f.t === 'stdout')).toBe(false);
    const busyStderr = secondFrames.find((f) => f.t === 'stderr');
    expect(busyStderr && busyStderr.t === 'stderr' && busyStderr.d).toMatch(/busy/i);

    // Release the first; it emits its real frames.
    deferred.release({ stdout: 'real', stderr: '', exitCode: 0 });
    await first;
    expect(firstFrames.some((f) => f.t === 'stdout' && f.d === 'real')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// startSubstrateSweep
// ---------------------------------------------------------------------------

describe('startSubstrateSweep', () => {
  it('exports a positive SUBSTRATE_SWEEP_INTERVAL_MS constant', () => {
    expect(typeof SUBSTRATE_SWEEP_INTERVAL_MS).toBe('number');
    expect(SUBSTRATE_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('calls setInterval with the provided interval', () => {
    const fakeTimers = {
      setInterval: vi.fn().mockReturnValue(42),
      clearInterval: vi.fn(),
    };
    const sweepIdle = vi.fn();
    const stop = startSubstrateSweep({ sweepIdle }, 5000, fakeTimers);

    expect(fakeTimers.setInterval).toHaveBeenCalledOnce();
    const [, interval] = fakeTimers.setInterval.mock.calls[0];
    expect(interval).toBe(5000);

    // Clean up (don't actually test clearInterval here — that's the next test)
    stop();
  });

  it('calls registry.sweepIdle when the interval callback fires', () => {
    const fakeTimers = {
      setInterval: vi.fn().mockReturnValue(99),
      clearInterval: vi.fn(),
    };
    const sweepIdle = vi.fn();
    const fixedNow = () => 12345;
    startSubstrateSweep({ sweepIdle }, 1000, fakeTimers, fixedNow);

    // Extract and invoke the callback manually
    const [callback] = fakeTimers.setInterval.mock.calls[0];
    callback();

    expect(sweepIdle).toHaveBeenCalledOnce();
    expect(sweepIdle).toHaveBeenCalledWith(12345);
  });

  it('returned stop function calls clearInterval with the interval id', () => {
    const intervalId = 77;
    const fakeTimers = {
      setInterval: vi.fn().mockReturnValue(intervalId),
      clearInterval: vi.fn(),
    };
    const sweepIdle = vi.fn();
    const stop = startSubstrateSweep({ sweepIdle }, 1000, fakeTimers);

    stop();

    expect(fakeTimers.clearInterval).toHaveBeenCalledOnce();
    expect(fakeTimers.clearInterval).toHaveBeenCalledWith(intervalId);
  });

  it('default timers keep the global `this` (browser Illegal-invocation regression)', () => {
    // In a browser worker, setInterval/clearInterval are WorkerGlobalScope
    // methods: invoking them with `this` set to anything but the global throws
    // "Illegal invocation". Node doesn't enforce that — so the default-timers
    // path shipped broken and only failed live. Simulate the browser's guard.
    const guard = function (this: unknown): number {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return 1234; // fake timer id; do not actually schedule
    };
    vi.stubGlobal('setInterval', guard);
    vi.stubGlobal('clearInterval', guard);
    try {
      // No injected timers → exercises the DEFAULT, which must not bind `this`
      // to the literal it lives on.
      let stop: () => void = () => {};
      expect(() => {
        stop = startSubstrateSweep({ sweepIdle: vi.fn() }, 60_000);
      }).not.toThrow();
      expect(() => stop()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
