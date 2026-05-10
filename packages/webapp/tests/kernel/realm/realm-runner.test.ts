/**
 * Tests for `runInRealm`.
 *
 * Mock realm: a fake `Realm` whose `controlPort` is an in-memory
 * event emitter. Tests fire `realm-done` / `realm-error` messages
 * directly to drive the runner without booting a real
 * DedicatedWorker / iframe (vitest runs in node and has neither).
 */

import { describe, it, expect, vi } from 'vitest';
import type { CommandContext } from 'just-bash';
import { ProcessManager } from '../../../src/kernel/process-manager.js';
import { runInRealm } from '../../../src/kernel/realm/realm-runner.js';
import type { Realm } from '../../../src/kernel/realm/realm-runner.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import type { RealmDoneMsg, RealmErrorMsg } from '../../../src/kernel/realm/realm-types.js';

interface MockRealm extends Realm {
  /** Test helper: deliver a `message` to subscribers. */
  fireMessage(data: unknown): void;
  /** Test helper: deliver an `error`. */
  fireError(message: string): void;
  /** Was `terminate()` called? */
  terminate: ReturnType<typeof vi.fn>;
  /** Most recent posted message. */
  lastPosted(): unknown;
  /** All posted messages. */
  posted: unknown[];
  /** Listener counts for leak assertions. */
  handlerCount(): { message: number; error: number };
}

function makeMockRealm(): MockRealm {
  const messageHandlers = new Set<(event: MessageEvent) => void>();
  const errorHandlers = new Set<(event: ErrorEvent) => void>();
  const posted: unknown[] = [];
  const port: RealmPortLike = {
    postMessage: (msg) => {
      posted.push(msg);
    },
    addEventListener: (_type, handler) => {
      messageHandlers.add(handler as (e: MessageEvent) => void);
    },
    removeEventListener: (_type, handler) => {
      messageHandlers.delete(handler as (e: MessageEvent) => void);
    },
  };
  const realm: MockRealm = {
    controlPort: port,
    terminate: vi.fn(),
    addEventListener: (_type, handler) => {
      errorHandlers.add(handler as (e: ErrorEvent) => void);
    },
    removeEventListener: (_type, handler) => {
      errorHandlers.delete(handler as (e: ErrorEvent) => void);
    },
    fireMessage(data: unknown): void {
      for (const h of [...messageHandlers]) h({ data } as MessageEvent);
    },
    fireError(message: string): void {
      for (const h of [...errorHandlers]) h({ message } as ErrorEvent);
    },
    lastPosted: () => posted[posted.length - 1],
    posted,
    handlerCount: () => ({ message: messageHandlers.size, error: errorHandlers.size }),
  };
  return realm;
}

const ctx = {} as CommandContext;

describe('runInRealm', () => {
  it('posts realm-init and resolves on realm-done', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const factory = vi.fn(async () => realm);
    const promise = runInRealm({
      pm,
      realmFactory: factory,
      owner: { kind: 'cone' },
      kind: 'js',
      code: 'console.log("hi")',
      argv: ['node', '-e', 'code'],
      env: { FOO: 'bar' },
      cwd: '/workspace',
      filename: '<eval>',
      ctx,
    });
    // Allow the factory promise + init-post to flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(realm.lastPosted()).toMatchObject({
      type: 'realm-init',
      kind: 'js',
      code: 'console.log("hi")',
      cwd: '/workspace',
    });
    const done: RealmDoneMsg = {
      type: 'realm-done',
      stdout: 'hi\n',
      stderr: '',
      exitCode: 0,
    };
    realm.fireMessage(done);
    const result = await promise;
    expect(result).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    const procs = pm.list();
    expect(procs).toHaveLength(1);
    expect(procs[0].kind).toBe('jsh');
    expect(procs[0].argv).toEqual(['node', '-e', 'code']);
    expect(procs[0].exitCode).toBe(0);
    expect(procs[0].status).toBe('exited');
  });

  it('terminates the realm on completion (idempotent cleanup)', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const promise = runInRealm({
      pm,
      realmFactory: async () => realm,
      owner: { kind: 'cone' },
      kind: 'js',
      code: '',
      argv: ['node'],
      env: {},
      cwd: '/',
      filename: '<eval>',
      ctx,
    });
    await Promise.resolve();
    await Promise.resolve();
    realm.fireMessage({
      type: 'realm-done',
      stdout: '',
      stderr: '',
      exitCode: 0,
    } satisfies RealmDoneMsg);
    await promise;
    expect(realm.terminate).toHaveBeenCalledTimes(1);
  });

  it('records process.exit(N) as the realm exit code', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const promise = runInRealm({
      pm,
      realmFactory: async () => realm,
      owner: { kind: 'cone' },
      kind: 'js',
      code: 'process.exit(7)',
      argv: ['node'],
      env: {},
      cwd: '/',
      filename: '<eval>',
      ctx,
    });
    await Promise.resolve();
    await Promise.resolve();
    realm.fireMessage({
      type: 'realm-done',
      stdout: '',
      stderr: '',
      exitCode: 7,
    } satisfies RealmDoneMsg);
    const result = await promise;
    expect(result.exitCode).toBe(7);
    expect(pm.list()[0].exitCode).toBe(7);
  });

  it('surfaces realm-error as exit 1 with the message in stderr', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const promise = runInRealm({
      pm,
      realmFactory: async () => realm,
      owner: { kind: 'cone' },
      kind: 'js',
      code: 'throw new Error("boom")',
      argv: ['node'],
      env: {},
      cwd: '/',
      filename: '<eval>',
      ctx,
    });
    await Promise.resolve();
    await Promise.resolve();
    realm.fireMessage({ type: 'realm-error', message: 'boom' } satisfies RealmErrorMsg);
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
  });

  it('surfaces realm error events as exit 1', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const promise = runInRealm({
      pm,
      realmFactory: async () => realm,
      owner: { kind: 'cone' },
      kind: 'js',
      code: '',
      argv: ['node'],
      env: {},
      cwd: '/',
      filename: '<eval>',
      ctx,
    });
    await Promise.resolve();
    await Promise.resolve();
    realm.fireError('uncaught syntax error');
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('uncaught syntax error');
  });

  it('SIGKILL terminates the realm and exits 137', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const promise = runInRealm({
      pm,
      realmFactory: async () => realm,
      owner: { kind: 'cone' },
      kind: 'js',
      code: 'while(true){}',
      argv: ['node'],
      env: {},
      cwd: '/',
      filename: '<eval>',
      ctx,
    });
    await Promise.resolve();
    await Promise.resolve();
    const proc = pm.list()[0];
    pm.signal(proc.pid, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(realm.terminate).toHaveBeenCalled();
    expect(proc.terminatedBy).toBe('SIGKILL');
    expect(proc.status).toBe('killed');
  });

  it('SIGINT alone does NOT terminate the realm (only SIGKILL is hard)', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    runInRealm({
      pm,
      realmFactory: async () => realm,
      owner: { kind: 'cone' },
      kind: 'js',
      code: 'while(true){}',
      argv: ['node'],
      env: {},
      cwd: '/',
      filename: '<eval>',
      ctx,
    });
    await Promise.resolve();
    await Promise.resolve();
    const proc = pm.list()[0];
    pm.signal(proc.pid, 'SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    expect(realm.terminate).not.toHaveBeenCalled();
    expect(proc.terminatedBy).toBe('SIGINT');
    expect(proc.abort.signal.aborted).toBe(true);
  });

  it('SIGKILL after SIGINT escalates and terminates the realm', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const promise = runInRealm({
      pm,
      realmFactory: async () => realm,
      owner: { kind: 'cone' },
      kind: 'js',
      code: 'while(true){}',
      argv: ['node'],
      env: {},
      cwd: '/',
      filename: '<eval>',
      ctx,
    });
    await Promise.resolve();
    await Promise.resolve();
    const proc = pm.list()[0];
    pm.signal(proc.pid, 'SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    expect(realm.terminate).not.toHaveBeenCalled();
    pm.signal(proc.pid, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(realm.terminate).toHaveBeenCalled();
    expect(proc.terminatedBy).toBe('SIGKILL');
    expect(proc.status).toBe('killed');
  });

  it('fails fast when the realm factory throws', async () => {
    const pm = new ProcessManager();
    const result = await runInRealm({
      pm,
      realmFactory: async () => {
        throw new Error('factory boom');
      },
      owner: { kind: 'cone' },
      kind: 'js',
      code: '',
      argv: ['node'],
      env: {},
      cwd: '/',
      filename: '<eval>',
      ctx,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('factory boom');
    expect(pm.list()[0].exitCode).toBe(1);
  });

  it('cleans up listeners on normal completion (no leaks)', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const promise = runInRealm({
      pm,
      realmFactory: async () => realm,
      owner: { kind: 'cone' },
      kind: 'js',
      code: '',
      argv: ['node'],
      env: {},
      cwd: '/',
      filename: '<eval>',
      ctx,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(realm.handlerCount().message).toBeGreaterThan(0);
    realm.fireMessage({
      type: 'realm-done',
      stdout: '',
      stderr: '',
      exitCode: 0,
    } satisfies RealmDoneMsg);
    await promise;
    // The realm-host listener and the runner's message listener should
    // both be detached. Two listeners (host + runner) → expect 0 after.
    expect(realm.handlerCount()).toEqual({ message: 0, error: 0 });
  });

  it('process is registered with kind:"jsh" before the realm replies', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    runInRealm({
      pm,
      realmFactory: async () => realm,
      owner: { kind: 'system' },
      kind: 'js',
      code: '',
      argv: ['node'],
      env: {},
      cwd: '/workspace',
      filename: '<eval>',
      ctx,
      ppid: 5000,
    });
    await Promise.resolve();
    await Promise.resolve();
    const proc = pm.list()[0];
    expect(proc).toBeDefined();
    expect(proc.kind).toBe('jsh');
    expect(proc.cwd).toBe('/workspace');
    expect(proc.ppid).toBe(5000);
    expect(proc.status).toBe('running');
  });

  it('honors procKind override (e.g. for a future kind:py)', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const promise = runInRealm({
      pm,
      realmFactory: async () => realm,
      owner: { kind: 'cone' },
      kind: 'js',
      code: '',
      argv: ['node'],
      env: {},
      cwd: '/',
      filename: '<eval>',
      ctx,
      // Use an existing ProcessKind value to keep this test stable
      // across the Phase-8 union widening.
      procKind: 'tool',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(pm.list()[0].kind).toBe('tool');
    realm.fireMessage({
      type: 'realm-done',
      stdout: '',
      stderr: '',
      exitCode: 0,
    } satisfies RealmDoneMsg);
    await promise;
  });
});
