/**
 * Tests for `runPreemptiveJs`.
 *
 * Uses a mock `PreemptiveWorkerLike` since vitest runs in node and
 * has no DedicatedWorker. The mock lets each test simulate either
 * a clean done-message, an error, or a "running forever" worker
 * that only stops on `terminate()`.
 */

import { describe, it, expect, vi } from 'vitest';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import { runPreemptiveJs, type PreemptiveWorkerLike } from '../../src/kernel/preemptive-runner.js';
import type { PreemptiveDoneMsg, PreemptiveErrorMsg } from '../../src/kernel/preemptive-worker.js';

interface MockWorker extends PreemptiveWorkerLike {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  /** Test helper: deliver a `message` to all subscribed handlers. */
  fireMessage(data: unknown): void;
  /** Test helper: deliver an `error` to all subscribed handlers. */
  fireError(message: string): void;
  /** Test introspection: how many handlers are currently subscribed. */
  handlerCount(): { message: number; error: number };
}

function makeMockWorker(): MockWorker {
  const messageHandlers = new Set<(event: MessageEvent) => void>();
  const errorHandlers = new Set<(event: ErrorEvent) => void>();
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener(type: 'message' | 'error', handler: unknown) {
      if (type === 'message') messageHandlers.add(handler as (e: MessageEvent) => void);
      else errorHandlers.add(handler as (e: ErrorEvent) => void);
    },
    removeEventListener(type: 'message' | 'error', handler: unknown) {
      if (type === 'message') messageHandlers.delete(handler as (e: MessageEvent) => void);
      else errorHandlers.delete(handler as (e: ErrorEvent) => void);
    },
    fireMessage(data: unknown) {
      for (const h of [...messageHandlers]) {
        h({ data } as MessageEvent);
      }
    },
    fireError(message: string) {
      for (const h of [...errorHandlers]) {
        h({ message } as ErrorEvent);
      }
    },
    handlerCount() {
      return { message: messageHandlers.size, error: errorHandlers.size };
    },
  };
}

describe('runPreemptiveJs', () => {
  it('posts init then resolves on preemptive-done', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const factory = vi.fn(() => worker);

    const promise = runPreemptiveJs({
      pm,
      workerFactory: factory,
      owner: { kind: 'cone' },
      code: 'console.log("hi")',
      argv: ['preemptive', 'arg1'],
      env: { FOO: 'bar' },
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'preemptive-init',
      code: 'console.log("hi")',
      argv: ['preemptive', 'arg1'],
      env: { FOO: 'bar' },
    });

    const done: PreemptiveDoneMsg = {
      type: 'preemptive-done',
      stdout: 'hi\n',
      stderr: '',
      exitCode: 0,
    };
    worker.fireMessage(done);

    const result = await promise;
    expect(result).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 });

    const procs = pm.list();
    expect(procs).toHaveLength(1);
    expect(procs[0].kind).toBe('preemptive');
    expect(procs[0].argv).toEqual(['preemptive', 'arg1']);
    expect(procs[0].exitCode).toBe(0);
    expect(procs[0].status).toBe('exited');
  });

  it('terminates the worker on completion (idempotent cleanup)', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const promise = runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: '',
    });
    const done: PreemptiveDoneMsg = {
      type: 'preemptive-done',
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
    worker.fireMessage(done);
    await promise;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('records process.exit(N) as the kind:"preemptive" exit code', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const promise = runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: 'process.exit(7)',
    });
    const done: PreemptiveDoneMsg = {
      type: 'preemptive-done',
      stdout: '',
      stderr: '',
      exitCode: 7,
    };
    worker.fireMessage(done);
    const result = await promise;
    expect(result.exitCode).toBe(7);
    expect(pm.list()[0].exitCode).toBe(7);
  });

  it('surfaces preemptive-error as exit 1 with the error message', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const promise = runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: 'throw new Error("boom")',
    });
    const err: PreemptiveErrorMsg = { type: 'preemptive-error', message: 'boom' };
    worker.fireMessage(err);
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
  });

  it('handles worker error events as exit 1', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const promise = runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: '',
    });
    worker.fireError('uncaught syntax error');
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('uncaught syntax error');
  });

  it('SIGKILL terminates the worker and exits 137', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const promise = runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: 'while(true) {}',
    });
    // Worker is "running forever" — never fires done. SIGKILL it.
    const proc = pm.list()[0];
    pm.signal(proc.pid, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(proc.terminatedBy).toBe('SIGKILL');
    expect(proc.status).toBe('killed');
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('SIGINT alone does NOT terminate the worker (only SIGKILL is hard)', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: 'while(true) {}',
    });
    const proc = pm.list()[0];
    pm.signal(proc.pid, 'SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    // Contract: only SIGKILL is hard. SIGINT records
    // terminatedBy + aborts the controller, but the worker keeps
    // running (no `worker.terminate()`).
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(proc.terminatedBy).toBe('SIGINT');
    expect(proc.abort.signal.aborted).toBe(true);
  });

  it('SIGKILL after SIGINT escalates and terminates the worker', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const promise = runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: 'while(true) {}',
    });
    const proc = pm.list()[0];
    // Operator escalation: SIGINT first (cooperative — no
    // termination), then SIGKILL (uncatchable; worker dies).
    pm.signal(proc.pid, 'SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    expect(worker.terminate).not.toHaveBeenCalled();
    pm.signal(proc.pid, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(worker.terminate).toHaveBeenCalled();
    // SIGKILL is uncatchable — `terminatedBy` is overwritten,
    // even though SIGINT was first.
    expect(proc.terminatedBy).toBe('SIGKILL');
    expect(proc.exitCode).toBe(137);
    expect(proc.status).toBe('killed');
  });

  it('preemptive process is registered with kind:"preemptive" before the worker replies', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'system' },
      code: '',
      cwd: '/workspace',
      ppid: 5000,
    });
    // Synchronous spawn: the process is in the table even before
    // the worker posts done.
    const proc = pm.list()[0];
    expect(proc).toBeDefined();
    expect(proc.kind).toBe('preemptive');
    expect(proc.cwd).toBe('/workspace');
    expect(proc.ppid).toBe(5000);
    expect(proc.status).toBe('running');
  });

  it('cleans up listeners on normal completion (no leaks)', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const promise = runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: '',
    });
    expect(worker.handlerCount()).toEqual({ message: 1, error: 1 });
    const done: PreemptiveDoneMsg = {
      type: 'preemptive-done',
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
    worker.fireMessage(done);
    await promise;
    expect(worker.handlerCount()).toEqual({ message: 0, error: 0 });
    // Subsequent fires don't double-resolve / throw.
    worker.fireMessage(done);
    worker.fireError('phantom');
  });

  it('cleans up listeners on preemptive-error (no leaks)', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const promise = runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: '',
    });
    expect(worker.handlerCount()).toEqual({ message: 1, error: 1 });
    worker.fireMessage({ type: 'preemptive-error', message: 'boom' } as PreemptiveErrorMsg);
    await promise;
    expect(worker.handlerCount()).toEqual({ message: 0, error: 0 });
  });

  it('cleans up listeners on SIGKILL (no leaks)', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const promise = runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: 'while(true) {}',
    });
    expect(worker.handlerCount()).toEqual({ message: 1, error: 1 });
    pm.signal(pm.list()[0].pid, 'SIGKILL');
    await promise;
    expect(worker.handlerCount()).toEqual({ message: 0, error: 0 });
  });

  it('cleans up listeners on worker error event (no leaks)', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const promise = runPreemptiveJs({
      pm,
      workerFactory: () => worker,
      owner: { kind: 'cone' },
      code: '',
    });
    worker.fireError('uncaught');
    await promise;
    expect(worker.handlerCount()).toEqual({ message: 0, error: 0 });
  });
});
