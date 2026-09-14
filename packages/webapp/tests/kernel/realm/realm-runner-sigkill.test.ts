import type { CommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { ProcessManager } from '../../../src/kernel/process-manager.js';
import { createInProcessJsRealmFactory } from '../../../src/kernel/realm/realm-inprocess.js';
import { runInRealm } from '../../../src/kernel/realm/realm-runner.js';

const ctx = {} as CommandContext;

describe('runInRealm SIGKILL', () => {
  it('node -e while(true){} + SIGKILL → exit 137 within 50 ms (in-process)', async () => {
    const pm = new ProcessManager();

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

    await new Promise((r) => setTimeout(r, 10));
    const proc = pm.list()[0];
    expect(proc).toBeDefined();
    pm.signal(proc.pid, 'SIGKILL');
    const result = await promise;
    const elapsed = Date.now() - start;
    expect(result.exitCode).toBe(137);

    expect(elapsed).toBeLessThan(500);
    expect(proc.terminatedBy).toBe('SIGKILL');
    expect(proc.exitCode).toBe(137);
    expect(proc.status).toBe('killed');
  });
});
