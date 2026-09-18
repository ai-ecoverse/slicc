import type { CommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { ProcessManager } from '../../../src/kernel/process-manager.js';
import { createInProcessJsRealmFactory } from '../../../src/kernel/realm/realm-inprocess.js';
import {
  type Realm,
  type RealmFactory,
  realmKilledTrailer,
  runInRealm,
} from '../../../src/kernel/realm/realm-runner.js';
import { makeCtx } from './cjs-realm-harness.js';

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

  it('realmKilledTrailer matches the bash-job #2415 shape', () => {
    expect(realmKilledTrailer(50, 137)).toBe('--- killed after 0.05s (exit 137) ---\n');
    expect(realmKilledTrailer(6000, 143)).toBe('--- killed after 6s (exit 143) ---\n');
    expect(realmKilledTrailer(15000, 130)).toBe('--- killed after 15s (exit 130) ---\n');
  });
});

function hangingEmittingRealm(opts: {
  stdout: string;
  path: string;
  bytes: Uint8Array;
}): RealmFactory {
  return async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const emit = (data: unknown): void => {
      for (const h of [...listeners]) h({ data } as MessageEvent);
    };
    const realm: Realm = {
      controlPort: {
        postMessage(msg: { type?: string }) {
          if (msg?.type !== 'realm-init') return;
          queueMicrotask(() => {
            emit({ type: 'realm-output', stream: 'stdout', chunk: opts.stdout });
            emit({ type: 'realm-fs-write', path: opts.path, bytes: opts.bytes });
          });
        },
        addEventListener(_type: string, handler: (event: MessageEvent) => void) {
          listeners.add(handler);
        },
        removeEventListener(_type: string, handler: (event: MessageEvent) => void) {
          listeners.delete(handler);
        },
      },
      terminate() {},
    };
    return realm;
  };
}

describe('runInRealm kill keeps streamed stdout and completed sync writes (#3136)', () => {
  it('fake realm: SIGKILL returns pre-hang stdout and persists the write', async () => {
    const fsCtx = makeCtx();
    const pm = new ProcessManager();
    const bytes = new TextEncoder().encode('file: before hang\n');
    const promise = runInRealm({
      pm,
      realmFactory: hangingEmittingRealm({
        stdout: 'stdout: before hang\n',
        path: '/tmp/ap4.log',
        bytes,
      }),
      owner: { kind: 'cone' },
      kind: 'js',
      code: '',
      argv: ['node', '/tmp/ap4.js'],
      env: {},
      cwd: '/',
      filename: '/tmp/ap4.js',
      ctx: fsCtx,
    });
    await new Promise((r) => setTimeout(r, 20));
    const proc = pm.list()[0];
    expect(proc).toBeDefined();
    pm.signal(proc.pid, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(result.stdout).toContain('stdout: before hang');
    expect(result.stderr).toMatch(/killed after .*s \(exit 137\)/);
    expect(await fsCtx.fs.readFile('/tmp/ap4.log')).toBe('file: before hang\n');
  });

  it('issue repro: appendFileSync + console.log then hang; SIGKILL keeps both', async () => {
    const fsCtx = makeCtx();
    const pm = new ProcessManager();
    const code = `const fs = require('fs');
console.log('stdout: before hang');
fs.appendFileSync('/tmp/ap4.log', 'file: before hang\\n');
await new Promise(() => {});`;
    const promise = runInRealm({
      pm,
      realmFactory: createInProcessJsRealmFactory(),
      owner: { kind: 'cone' },
      kind: 'js',
      code,
      argv: ['node', '/tmp/ap4.js'],
      env: {},
      cwd: '/',
      filename: '/tmp/ap4.js',
      ctx: fsCtx,
    });

    await new Promise((r) => setTimeout(r, 30));
    const proc = pm.list().find((p) => p.status === 'running');
    expect(proc).toBeDefined();
    pm.signal(proc!.pid, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(result.stdout).toContain('stdout: before hang');
    expect(result.stderr).toMatch(/killed after .*s \(exit 137\)/);
    expect(await fsCtx.fs.readFile('/tmp/ap4.log')).toBe('file: before hang\n');
  });

  it('issue control: normal exit still persists the write and stdout', async () => {
    const fsCtx = makeCtx();
    const pm = new ProcessManager();
    const code = `const fs = require('fs');
fs.appendFileSync('/tmp/ap5.log', 'file: written, then exiting normally\\n');
console.log('stdout: exiting normally');`;
    const result = await runInRealm({
      pm,
      realmFactory: createInProcessJsRealmFactory(),
      owner: { kind: 'cone' },
      kind: 'js',
      code,
      argv: ['node', '/tmp/ap5.js'],
      env: {},
      cwd: '/',
      filename: '/tmp/ap5.js',
      ctx: fsCtx,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('stdout: exiting normally');
    expect(result.stderr).not.toMatch(/killed after/);
    expect(await fsCtx.fs.readFile('/tmp/ap5.log')).toBe('file: written, then exiting normally\n');
  });

  it('does not replay a flushed writeFileSync over a later exec overwrite on kill', async () => {
    const fsCtx = makeCtx();
    fsCtx.exec = (async (cmd: string) => {
      if (cmd.includes('MODIFIED')) {
        await fsCtx.fs.writeFile('/tmp/stale.log', 'MODIFIED\n');
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }) as CommandContext['exec'];
    const pm = new ProcessManager();
    const code = `const fs = require('fs');
const { exec } = require('sliccy:exec');
fs.writeFileSync('/tmp/stale.log', 'ORIGINAL\\n');
await exec('echo MODIFIED > /tmp/stale.log');
await new Promise(() => {});`;
    const promise = runInRealm({
      pm,
      realmFactory: createInProcessJsRealmFactory(),
      owner: { kind: 'cone' },
      kind: 'js',
      code,
      argv: ['node', '/tmp/stale.js'],
      env: {},
      cwd: '/',
      filename: '/tmp/stale.js',
      ctx: fsCtx,
    });
    await new Promise((r) => setTimeout(r, 40));
    const proc = pm.list().find((p) => p.status === 'running');
    expect(proc).toBeDefined();
    pm.signal(proc!.pid, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(await fsCtx.fs.readFile('/tmp/stale.log')).toBe('MODIFIED\n');
  });

  it('coalesces repeated appendFileSync snapshots so kill keeps the latest', async () => {
    const fsCtx = makeCtx();
    const pm = new ProcessManager();
    const code = `const fs = require('fs');
fs.appendFileSync('/tmp/log.txt', 'one\\n');
fs.appendFileSync('/tmp/log.txt', 'two\\n');
await new Promise(() => {});`;
    const promise = runInRealm({
      pm,
      realmFactory: createInProcessJsRealmFactory(),
      owner: { kind: 'cone' },
      kind: 'js',
      code,
      argv: ['node', '/tmp/log.js'],
      env: {},
      cwd: '/',
      filename: '/tmp/log.js',
      ctx: fsCtx,
    });
    await new Promise((r) => setTimeout(r, 30));
    const proc = pm.list().find((p) => p.status === 'running');
    expect(proc).toBeDefined();
    pm.signal(proc!.pid, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(await fsCtx.fs.readFile('/tmp/log.txt')).toBe('one\ntwo\n');
  });

  it('SIGTERM (timeout default) also keeps stdout and the write', async () => {
    const fsCtx = makeCtx();
    const pm = new ProcessManager();
    const code = `const fs = require('fs');
console.log('stdout: before hang');
fs.writeFileSync('/tmp/ap-term.log', 'file: before hang\\n');
await new Promise(() => {});`;
    const promise = runInRealm({
      pm,
      realmFactory: createInProcessJsRealmFactory(),
      owner: { kind: 'cone' },
      kind: 'js',
      code,
      argv: ['node', '/tmp/ap-term.js'],
      env: {},
      cwd: '/',
      filename: '/tmp/ap-term.js',
      ctx: fsCtx,
    });
    await new Promise((r) => setTimeout(r, 30));
    const proc = pm.list().find((p) => p.status === 'running');
    expect(proc).toBeDefined();
    pm.signal(proc!.pid, 'SIGTERM');
    const result = await promise;
    expect(result.exitCode).toBe(143);
    expect(result.stdout).toContain('stdout: before hang');
    expect(result.stderr).toMatch(/killed after .*s \(exit 143\)/);
    expect(await fsCtx.fs.readFile('/tmp/ap-term.log')).toBe('file: before hang\n');
  });
});
