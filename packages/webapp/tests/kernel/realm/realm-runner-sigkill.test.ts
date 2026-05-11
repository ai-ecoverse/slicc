/**
 * SIGKILL escalation tests for `runInRealm`. Pins that
 * `node -e 'while(true){}'` plus `kill -KILL <pid>` exits 137 in
 * a bounded time, regardless of whether the realm impl can
 * actually hard-stop the user code (the in-process realm CAN'T,
 * but the kernel runner can still settle the promise on SIGKILL
 * because the realm runner detaches its listeners + posts the
 * 137 result without waiting for the realm to acknowledge).
 *
 * This test isn't a substitute for a real-DedicatedWorker test
 * (vitest can't spawn one); it pins the kernel-side timing
 * invariant. The wire-end-to-end check ("real `kill -KILL` after
 * 50 ms") is covered by manual smoke tests on the standalone +
 * extension floats — see plan §Manual smoke tests.
 */

import { describe, it, expect } from 'vitest';
import type { CommandContext } from 'just-bash';
import { ProcessManager } from '../../../src/kernel/process-manager.js';
import { runInRealm } from '../../../src/kernel/realm/realm-runner.js';
import { createInProcessJsRealmFactory } from '../../../src/kernel/realm/realm-inprocess.js';

const ctx = {} as CommandContext;

describe('runInRealm SIGKILL', () => {
  it('node -e while(true){} + SIGKILL → exit 137 within 50 ms (in-process)', async () => {
    const pm = new ProcessManager();
    // The in-process realm can't actually hard-stop a runaway
    // loop in vitest — `runJsRealm` uses AsyncFunction in the
    // same realm. Pick a code path that does yield (an awaited
    // promise) so the kernel runner can settle on SIGKILL
    // without the test process freezing. The SIGKILL hook in the
    // runner doesn't wait for the realm to acknowledge — it
    // settles the promise immediately, so we measure the
    // kernel-side latency.
    const code = 'await new Promise((r) => setTimeout(r, 60_000));';
    const factory = createInProcessJsRealmFactory();
    const start = Date.now();
    const promise = runInRealm({
      pm,
      realmFactory: factory,
      owner: { kind: 'cone' },
      kind: 'js',
      code,
      argv: ['node', '-e', code],
      env: {},
      cwd: '/',
      filename: '[eval]',
      ctx,
    });
    // Yield once so spawn + factory + init flush.
    await new Promise((r) => setTimeout(r, 10));
    const proc = pm.list()[0];
    expect(proc).toBeDefined();
    pm.signal(proc.pid, 'SIGKILL');
    const result = await promise;
    const elapsed = Date.now() - start;
    expect(result.exitCode).toBe(137);
    // 50 ms budget for the kernel-side cleanup. In-process
    // factories settle synchronously after the SIGKILL fires.
    expect(elapsed).toBeLessThan(150);
    expect(proc.terminatedBy).toBe('SIGKILL');
    expect(proc.exitCode).toBe(137);
    expect(proc.status).toBe('killed');
  });
});
