/**
 * Tests for `ProcessManager` (Phase 3 step 1).
 *
 * Pins the data-structure invariants — pid allocation, lifecycle
 * transitions, signal semantics, event delivery, wait()
 * resolution. Phase 3 steps 2–5 wire the manager into the actual
 * subsystems; those have their own tests.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Gate,
  ProcessManager,
  runAsProcess,
  type Process,
} from '../../src/kernel/process-manager.js';

function makeManager(): ProcessManager {
  return new ProcessManager();
}

describe('ProcessManager — pid allocation', () => {
  it('starts pids at 1024 and increments monotonically', () => {
    const pm = makeManager();
    const a = pm.spawn({ kind: 'shell', argv: ['echo'], owner: { kind: 'cone' } });
    const b = pm.spawn({ kind: 'shell', argv: ['echo'], owner: { kind: 'cone' } });
    const c = pm.spawn({ kind: 'shell', argv: ['echo'], owner: { kind: 'cone' } });
    expect(a.pid).toBe(1024);
    expect(b.pid).toBe(1025);
    expect(c.pid).toBe(1026);
  });

  it('linear probe is bounded by table size (no uint32 scan on corrupt state)', () => {
    // Spawn a small handful and force the next allocation to start
    // on a known-occupied slot via private-field surgery. With the
    // bounded probe, allocation succeeds within `size+1` steps; an
    // unbounded probe would loop until it hit `start === pid` after
    // 2^32 steps.
    const pm = makeManager();
    const a = pm.spawn({ kind: 'shell', argv: ['a'], owner: { kind: 'cone' } });
    const b = pm.spawn({ kind: 'shell', argv: ['b'], owner: { kind: 'cone' } });
    const c = pm.spawn({ kind: 'shell', argv: ['c'], owner: { kind: 'cone' } });
    // Force `nextPid` back to a's pid so the probe collides 3 times
    // before landing in a hole.
    (pm as unknown as { nextPid: number }).nextPid = a.pid;
    const start = performance.now();
    const d = pm.spawn({ kind: 'shell', argv: ['d'], owner: { kind: 'cone' } });
    const elapsedMs = performance.now() - start;
    // d should land at the first hole after [a,b,c], regardless of
    // exact value. The key invariant is FAST allocation.
    expect(d.pid).toBe(c.pid + 1);
    expect(elapsedMs).toBeLessThan(50); // sanity: no multi-second scan
  });

  it('does not reuse a live pid (linear probe)', () => {
    const pm = makeManager();
    const a = pm.spawn({ kind: 'shell', argv: ['a'], owner: { kind: 'cone' } });
    const b = pm.spawn({ kind: 'shell', argv: ['b'], owner: { kind: 'cone' } });
    pm.exit(a.pid, 0);
    // Even though a exited, the next pid is still monotonic (we don't
    // reap until Phase 4). The probe only kicks in if `nextPid` lands
    // on a still-live entry, which we can't reproduce without
    // exhausting the space — covered structurally by the dedicated
    // wraparound test below.
    const c = pm.spawn({ kind: 'shell', argv: ['c'], owner: { kind: 'cone' } });
    expect(c.pid).toBe(1026);
    expect(c.pid).not.toBe(b.pid);
  });
});

describe('ProcessManager — lifecycle', () => {
  it('records argv / cwd / env / owner on spawn', () => {
    const pm = makeManager();
    const proc = pm.spawn({
      kind: 'tool',
      argv: ['read_file', '/tmp/x'],
      cwd: '/workspace',
      env: { FOO: 'bar' },
      owner: { kind: 'scoop', scoopJid: 's1' },
    });
    expect(proc.kind).toBe('tool');
    expect(proc.argv).toEqual(['read_file', '/tmp/x']);
    expect(proc.cwd).toBe('/workspace');
    expect(proc.env).toEqual({ FOO: 'bar' });
    expect(proc.owner).toEqual({ kind: 'scoop', scoopJid: 's1' });
    expect(proc.status).toBe('running');
    expect(proc.exitCode).toBeNull();
    expect(proc.terminatedBy).toBeNull();
  });

  it('exit(pid, 0) marks status=exited and records finishedAt', () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    expect(proc.status).toBe('running');
    pm.exit(proc.pid, 0);
    expect(proc.status).toBe('exited');
    expect(proc.exitCode).toBe(0);
    expect(proc.finishedAt).not.toBeNull();
  });

  it('exit() is idempotent', () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    pm.exit(proc.pid, 7);
    const finishedAt = proc.finishedAt;
    pm.exit(proc.pid, 99);
    expect(proc.exitCode).toBe(7);
    expect(proc.finishedAt).toBe(finishedAt);
  });

  it('exit(pid, null) on a clean process derives exitCode=0', () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    pm.exit(proc.pid, null);
    expect(proc.exitCode).toBe(0);
    expect(proc.status).toBe('exited');
  });

  it('default ppid is 1 (kernel-host anchor)', () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    expect(proc.ppid).toBe(1);
  });

  it('explicit ppid is preserved (parent-child trees)', () => {
    const pm = makeManager();
    const turn = pm.spawn({ kind: 'scoop-turn', argv: ['prompt'], owner: { kind: 'cone' } });
    const tool = pm.spawn({
      kind: 'tool',
      argv: ['bash'],
      owner: { kind: 'cone' },
      ppid: turn.pid,
    });
    expect(tool.ppid).toBe(turn.pid);
  });

  it('adoptAbort uses the caller-provided AbortController', () => {
    const pm = makeManager();
    const ctl = new AbortController();
    const proc = pm.spawn({
      kind: 'shell',
      argv: ['sleep'],
      owner: { kind: 'cone' },
      adoptAbort: ctl,
    });
    expect(proc.abort).toBe(ctl);
  });

  it('default abort is a fresh AbortController', () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    expect(proc.abort).toBeInstanceOf(AbortController);
    expect(proc.abort.signal.aborted).toBe(false);
  });
});

describe('ProcessManager — signals', () => {
  it('SIGINT records terminatedBy and aborts the controller', () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['sleep', '1'], owner: { kind: 'cone' } });
    expect(pm.signal(proc.pid, 'SIGINT')).toBe(true);
    expect(proc.terminatedBy).toBe('SIGINT');
    expect(proc.abort.signal.aborted).toBe(true);
  });

  it('signal on unknown pid returns false', () => {
    const pm = makeManager();
    expect(pm.signal(99999, 'SIGINT')).toBe(false);
  });

  it('signal on already-exited process returns false', () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    pm.exit(proc.pid, 0);
    expect(pm.signal(proc.pid, 'SIGINT')).toBe(false);
  });

  it('SIGINT/SIGTERM are first-wins, but SIGKILL always escalates (Phase 7)', () => {
    const pm = makeManager();
    // SIGINT then SIGTERM: first wins.
    const a = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(a.pid, 'SIGINT');
    pm.signal(a.pid, 'SIGTERM');
    expect(a.terminatedBy).toBe('SIGINT');

    // SIGTERM then SIGKILL: SIGKILL escalates (POSIX uncatchable).
    const b = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(b.pid, 'SIGTERM');
    pm.signal(b.pid, 'SIGKILL');
    expect(b.terminatedBy).toBe('SIGKILL');

    // SIGINT then SIGKILL: SIGKILL escalates.
    const c = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(c.pid, 'SIGINT');
    pm.signal(c.pid, 'SIGKILL');
    expect(c.terminatedBy).toBe('SIGKILL');
  });

  it('exit(pid, null) after a signal derives the conventional exit code', () => {
    const pm = makeManager();
    const sigint = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(sigint.pid, 'SIGINT');
    pm.exit(sigint.pid, null);
    expect(sigint.exitCode).toBe(130);
    expect(sigint.status).toBe('killed');

    const sigterm = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(sigterm.pid, 'SIGTERM');
    pm.exit(sigterm.pid, null);
    expect(sigterm.exitCode).toBe(143);

    const sigkill = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(sigkill.pid, 'SIGKILL');
    pm.exit(sigkill.pid, null);
    expect(sigkill.exitCode).toBe(137);
  });

  it('explicit exit code overrides the signal-derived default', () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(proc.pid, 'SIGINT');
    // The just-bash command finished with its own exit code despite
    // the abort being raised — the explicit 0 wins.
    pm.exit(proc.pid, 0);
    expect(proc.exitCode).toBe(0);
    // Status is still `killed` because terminatedBy was set.
    expect(proc.status).toBe('killed');
  });

  it('SIGSTOP and SIGCONT do not abort (Phase 6 — pause/resume only)', () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    expect(pm.signal(proc.pid, 'SIGSTOP')).toBe(true);
    expect(pm.signal(proc.pid, 'SIGCONT')).toBe(true);
    expect(proc.abort.signal.aborted).toBe(false);
    expect(proc.terminatedBy).toBeNull();
  });
});

describe('Gate (Phase 6)', () => {
  it('starts resumed — wait() returns immediately', async () => {
    const g = new Gate();
    let resolved = false;
    await g.wait().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  it('pause() blocks subsequent wait() until resume()', async () => {
    const g = new Gate();
    g.pause();
    let resolved = false;
    const p = g.wait().then(() => {
      resolved = true;
    });
    // Yield to the event loop — wait() must not have resolved yet.
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    g.resume();
    await p;
    expect(resolved).toBe(true);
  });

  it('multiple waiters all resolve on a single resume()', async () => {
    const g = new Gate();
    g.pause();
    let count = 0;
    const promises = [
      g.wait().then(() => count++),
      g.wait().then(() => count++),
      g.wait().then(() => count++),
    ];
    await new Promise((r) => setTimeout(r, 0));
    expect(count).toBe(0);
    g.resume();
    await Promise.all(promises);
    expect(count).toBe(3);
  });

  it('pause() is idempotent', async () => {
    const g = new Gate();
    g.pause();
    g.pause();
    let resolved = false;
    const p = g.wait().then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    g.resume();
    await p;
    expect(resolved).toBe(true);
  });

  it('resume() before pause() is a no-op', async () => {
    const g = new Gate();
    g.resume(); // no-op
    let resolved = false;
    await g.wait().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  it('release() wakes waiters and locks gate to "always resolved"', async () => {
    const g = new Gate();
    g.pause();
    let resolved = false;
    const p = g.wait().then(() => {
      resolved = true;
    });
    g.release();
    await p;
    expect(resolved).toBe(true);
    // Subsequent waits return immediately even if pause() is called again.
    g.pause();
    await g.wait();
  });

  it('isPaused() reflects state', () => {
    const g = new Gate();
    expect(g.isPaused()).toBe(false);
    g.pause();
    expect(g.isPaused()).toBe(true);
    g.resume();
    expect(g.isPaused()).toBe(false);
  });
});

describe('ProcessManager — Phase 6 gate integration', () => {
  it('SIGSTOP pauses the process gate', () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    expect(proc.gate.isPaused()).toBe(false);
    pm.signal(proc.pid, 'SIGSTOP');
    expect(proc.gate.isPaused()).toBe(true);
  });

  it('SIGCONT resumes the process gate', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(proc.pid, 'SIGSTOP');
    let resolved = false;
    const p = proc.gate.wait().then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    pm.signal(proc.pid, 'SIGCONT');
    await p;
    expect(resolved).toBe(true);
  });

  it('SIGINT after SIGSTOP still aborts and releases the gate', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(proc.pid, 'SIGSTOP');
    let resolved = false;
    const p = proc.gate.wait().then(() => {
      resolved = true;
    });
    pm.signal(proc.pid, 'SIGINT');
    await p;
    expect(resolved).toBe(true);
    expect(proc.abort.signal.aborted).toBe(true);
    expect(proc.terminatedBy).toBe('SIGINT');
  });

  it('exit() releases the gate so paused waiters do not leak', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(proc.pid, 'SIGSTOP');
    let resolved = false;
    const p = proc.gate.wait().then(() => {
      resolved = true;
    });
    pm.exit(proc.pid, 0);
    await p;
    expect(resolved).toBe(true);
  });
});

describe('ProcessManager — events', () => {
  it("on('spawn') fires synchronously inside spawn()", () => {
    const pm = makeManager();
    const seen: Process[] = [];
    pm.on('spawn', (p) => seen.push(p));
    const proc = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(proc);
  });

  it('onSignal fires for every signal delivery (Phase 7)', () => {
    const pm = makeManager();
    const seen: Array<{ pid: number; sig: string }> = [];
    pm.onSignal((proc, sig) => seen.push({ pid: proc.pid, sig }));
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(proc.pid, 'SIGSTOP');
    pm.signal(proc.pid, 'SIGCONT');
    pm.signal(proc.pid, 'SIGINT');
    pm.signal(proc.pid, 'SIGKILL'); // escalation — also fires
    expect(seen).toEqual([
      { pid: proc.pid, sig: 'SIGSTOP' },
      { pid: proc.pid, sig: 'SIGCONT' },
      { pid: proc.pid, sig: 'SIGINT' },
      { pid: proc.pid, sig: 'SIGKILL' },
    ]);
  });

  it('onSignal returns an unsubscribe fn', () => {
    const pm = makeManager();
    const fn = vi.fn();
    const off = pm.onSignal(fn);
    const proc = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(proc.pid, 'SIGINT');
    off();
    pm.signal(proc.pid, 'SIGKILL');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("on('exit') fires synchronously inside exit()", () => {
    const pm = makeManager();
    const seen: Process[] = [];
    pm.on('exit', (p) => seen.push(p));
    const proc = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    expect(seen).toHaveLength(0);
    pm.exit(proc.pid, 0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(proc);
  });

  it('returned unsubscribe fn removes the listener', () => {
    const pm = makeManager();
    const fn = vi.fn();
    const off = pm.on('spawn', fn);
    pm.spawn({ kind: 'shell', argv: ['a'], owner: { kind: 'cone' } });
    off();
    pm.spawn({ kind: 'shell', argv: ['b'], owner: { kind: 'cone' } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('listeners that throw do not break manager invariants', () => {
    const pm = makeManager();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    pm.on('spawn', () => {
      throw new Error('boom');
    });
    const fn = vi.fn();
    pm.on('spawn', fn);
    const proc = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    expect(fn).toHaveBeenCalledWith(proc);
    expect(pm.list()).toHaveLength(1);
    consoleSpy.mockRestore();
  });

  it('listeners that unsubscribe themselves mid-fire do not perturb iteration', () => {
    const pm = makeManager();
    const order: string[] = [];
    let off1: () => void = () => undefined;
    off1 = pm.on('spawn', () => {
      order.push('a');
      off1();
    });
    pm.on('spawn', () => order.push('b'));
    pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    expect(order).toEqual(['a', 'b']);
  });
});

describe('ProcessManager — list / get / wait', () => {
  it('list() returns a snapshot copy', () => {
    const pm = makeManager();
    pm.spawn({ kind: 'shell', argv: ['a'], owner: { kind: 'cone' } });
    pm.spawn({ kind: 'shell', argv: ['b'], owner: { kind: 'cone' } });
    const list1 = pm.list();
    pm.spawn({ kind: 'shell', argv: ['c'], owner: { kind: 'cone' } });
    expect(list1).toHaveLength(2);
    expect(pm.list()).toHaveLength(3);
  });

  it('get() returns null for unknown pids', () => {
    const pm = makeManager();
    expect(pm.get(99)).toBeNull();
  });

  it('wait() resolves immediately for already-exited processes', async () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    pm.exit(proc.pid, 7);
    const result = await pm.wait(proc.pid);
    expect(result).toBe(proc);
    expect(result.exitCode).toBe(7);
  });

  it('wait() resolves on the matching exit() call', async () => {
    const pm = makeManager();
    const proc = pm.spawn({ kind: 'shell', argv: ['sleep'], owner: { kind: 'cone' } });
    const p = pm.wait(proc.pid);
    pm.exit(proc.pid, 0);
    const result = await p;
    expect(result).toBe(proc);
  });

  it('wait() rejects synchronously for unknown pids', async () => {
    const pm = makeManager();
    await expect(pm.wait(99)).rejects.toThrow('no such process');
  });
});

describe('runAsProcess', () => {
  it('exits 0 when the block resolves cleanly', async () => {
    const pm = makeManager();
    const result = await runAsProcess(
      pm,
      { kind: 'tool', argv: ['t'], owner: { kind: 'cone' } },
      async () => 42
    );
    expect(result).toBe(42);
    const procs = pm.list();
    expect(procs).toHaveLength(1);
    expect(procs[0].exitCode).toBe(0);
    expect(procs[0].status).toBe('exited');
  });

  it('exits with the signal-derived code when the block throws after abort', async () => {
    const pm = makeManager();
    let capturedPid = 0;
    await expect(
      runAsProcess(pm, { kind: 'tool', argv: ['t'], owner: { kind: 'cone' } }, async (proc) => {
        capturedPid = proc.pid;
        pm.signal(proc.pid, 'SIGINT');
        // Caller code observes the abort and throws.
        throw new Error('aborted');
      })
    ).rejects.toThrow('aborted');
    const proc = pm.get(capturedPid)!;
    expect(proc.exitCode).toBe(130);
    expect(proc.status).toBe('killed');
  });

  it('exits 1 when the block throws without an abort', async () => {
    const pm = makeManager();
    await expect(
      runAsProcess(pm, { kind: 'tool', argv: ['t'], owner: { kind: 'cone' } }, async () => {
        throw new Error('bug');
      })
    ).rejects.toThrow('bug');
    const proc = pm.list()[0];
    expect(proc.exitCode).toBe(1);
    expect(proc.status).toBe('exited');
  });

  it('passes the process handle to the block', async () => {
    const pm = makeManager();
    let received: Process | null = null;
    await runAsProcess(pm, { kind: 'tool', argv: ['t'], owner: { kind: 'cone' } }, async (proc) => {
      received = proc;
    });
    expect(received).not.toBeNull();
    expect(received!.kind).toBe('tool');
  });
});
