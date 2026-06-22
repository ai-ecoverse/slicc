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
  it('appends to a bounded tail (keeps LATEST bytes on overflow)', async () => {
    // Build a string that exceeds 64KB
    const bigChunk = 'x'.repeat(32 * 1024); // 32KB per call
    const shell = makeStubShell({ stdout: bigChunk });
    registry = createSubstrateSessionRegistry({ shellFactory: makeFactory(shell) });

    // Three calls: 3 × 32KB stdout = 96KB > 64KB cap
    await registry.runExec('sess-3', 'a');
    await registry.runExec('sess-3', 'b');
    await registry.runExec('sess-3', 'c');

    const status = registry.sessionStatus('sess-3');
    expect(status.alive).toBe(true);
    expect(status.bufferedTail.length).toBeLessThanOrEqual(64 * 1024);

    // The tail must contain the LAST appended content (not the first)
    // The last chunk was from call 'c' which produced bigChunk
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
});
