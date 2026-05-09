/**
 * Tests for `preemptive` shell command (Phase 7.3).
 */

import { describe, it, expect, vi } from 'vitest';
import type { CommandContext } from 'just-bash';
import { createPreemptiveCommand } from '../../../src/shell/supplemental-commands/preemptive-command.js';
import { ProcessManager } from '../../../src/kernel/process-manager.js';
import type {
  PreemptiveWorkerLike,
  PreemptiveWorkerFactory,
} from '../../../src/kernel/preemptive-runner.js';
import type { PreemptiveDoneMsg } from '../../../src/kernel/preemptive-worker.js';

const mockCtx = {} as CommandContext;

function makeMockWorker(): PreemptiveWorkerLike & {
  fireMessage: (data: unknown) => void;
  terminate: ReturnType<typeof vi.fn>;
} {
  const messageHandlers = new Set<(event: MessageEvent) => void>();
  return {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener(type: 'message' | 'error', handler: unknown) {
      if (type === 'message') messageHandlers.add(handler as (e: MessageEvent) => void);
    },
    removeEventListener(type: 'message' | 'error', handler: unknown) {
      if (type === 'message') messageHandlers.delete(handler as (e: MessageEvent) => void);
    },
    fireMessage(data: unknown) {
      for (const h of [...messageHandlers]) h({ data } as MessageEvent);
    },
  };
}

describe('preemptive command', () => {
  it('--help prints usage', async () => {
    const cmd = createPreemptiveCommand({ processManager: new ProcessManager() });
    const result = await cmd.execute(['--help'], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('hard-killable');
  });

  it('with no args prints usage (no infinite empty-script run)', async () => {
    const cmd = createPreemptiveCommand({ processManager: new ProcessManager() });
    const result = await cmd.execute([], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('runs code via the runner and returns the worker result', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const factory: PreemptiveWorkerFactory = vi.fn(() => worker);
    const cmd = createPreemptiveCommand({ processManager: pm, workerFactory: factory });
    const promise = cmd.execute(['console.log("hi")', 'extra-arg'], mockCtx);
    expect(factory).toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'preemptive-init',
        code: 'console.log("hi")',
        argv: ['preemptive', 'extra-arg'],
      })
    );
    const done: PreemptiveDoneMsg = {
      type: 'preemptive-done',
      stdout: 'hi\n',
      stderr: '',
      exitCode: 0,
    };
    worker.fireMessage(done);
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi\n');
    // The process was kind:'preemptive'.
    expect(pm.list()[0].kind).toBe('preemptive');
  });

  it('errors clearly when no manager is available', async () => {
    delete (globalThis as Record<string, unknown>).__slicc_pm;
    const cmd = createPreemptiveCommand();
    const result = await cmd.execute(['code'], mockCtx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no process manager');
  });

  it('errors clearly when no worker factory is available', async () => {
    const pm = new ProcessManager();
    const cmd = createPreemptiveCommand({
      processManager: pm,
      workerFactory: undefined,
    });
    // Force the default-factory path to return null by deleting Worker.
    const originalWorker = (globalThis as Record<string, unknown>).Worker;
    delete (globalThis as Record<string, unknown>).Worker;
    try {
      const result = await cmd.execute(['code'], mockCtx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('cannot construct DedicatedWorker');
    } finally {
      if (originalWorker !== undefined) {
        (globalThis as Record<string, unknown>).Worker = originalWorker;
      }
    }
  });

  it('SIGKILL during a long-running script terminates the worker (Phase 7 contract)', async () => {
    const pm = new ProcessManager();
    const worker = makeMockWorker();
    const cmd = createPreemptiveCommand({ processManager: pm, workerFactory: () => worker });
    const promise = cmd.execute(['while(true){}'], mockCtx);
    // Wait a tick for spawn.
    await new Promise((r) => setTimeout(r, 5));
    const proc = pm.list()[0];
    pm.signal(proc.pid, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(worker.terminate).toHaveBeenCalled();
  });
});
