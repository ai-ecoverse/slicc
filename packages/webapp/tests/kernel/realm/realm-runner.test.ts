/**
 * Tests for `runInRealm`.
 *
 * Mock realm: a fake `Realm` whose `controlPort` is an in-memory
 * event emitter. Tests fire `realm-done` / `realm-error` messages
 * directly to drive the runner without booting a real
 * DedicatedWorker / iframe (vitest runs in node and has neither).
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { ProcessManager } from '../../../src/kernel/process-manager.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import type { Realm } from '../../../src/kernel/realm/realm-runner.js';
import { runInRealm } from '../../../src/kernel/realm/realm-runner.js';
import type { RealmDoneMsg, RealmErrorMsg } from '../../../src/kernel/realm/realm-types.js';

interface MockRealm extends Realm {
  /** Test helper: deliver a `message` to subscribers. */
  fireMessage(data: unknown): void;
  /** Test helper: deliver an `error`. */
  fireError(message: string): void;
  /** Test helper: deliver a `messageerror` (un-deserializable post). */
  fireMessageError(): void;
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
  const errorHandlers = new Set<(event: Event) => void>();
  const messageErrorHandlers = new Set<(event: Event) => void>();
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
  const setFor = (type: 'error' | 'messageerror'): Set<(event: Event) => void> =>
    type === 'messageerror' ? messageErrorHandlers : errorHandlers;
  const realm: MockRealm = {
    controlPort: port,
    terminate: vi.fn(),
    addEventListener: (type, handler) => {
      setFor(type).add(handler);
    },
    removeEventListener: (type, handler) => {
      setFor(type).delete(handler);
    },
    fireMessage(data: unknown): void {
      for (const h of [...messageHandlers]) h({ data } as MessageEvent);
    },
    fireError(message: string): void {
      for (const h of [...errorHandlers]) h({ message } as ErrorEvent);
    },
    fireMessageError(): void {
      for (const h of [...messageErrorHandlers]) h({} as MessageEvent);
    },
    lastPosted: () => posted[posted.length - 1],
    posted,
    // `error` folds in `messageerror` so the leak assertion covers both.
    handlerCount: () => ({
      message: messageHandlers.size,
      error: errorHandlers.size + messageErrorHandlers.size,
    }),
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

  // Regression (PR #1085 EXT5/NS2): a worker/sandbox that dies mid-post
  // surfaces as a `messageerror` (un-deserializable message), not a
  // `realm-done`. Without a handler the promise would hang or a later
  // spurious settle could land at exit 0. It must settle non-zero.
  it('surfaces realm messageerror as exit 1', async () => {
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
    realm.fireMessageError();
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('could not be deserialized');
    expect(realm.terminate).toHaveBeenCalled();
    expect(pm.list()[0].exitCode).toBe(1);
  });

  // Regression (PR #1085 NS2): after an abnormal end settles the run,
  // a later spurious `realm-done` (exit 0) must NOT overwrite it — the
  // settle is strictly first-wins so a failure can't degrade to exit 0.
  it('ignores a late realm-done exit 0 after a messageerror settled non-zero', async () => {
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
    realm.fireMessageError();
    realm.fireMessage({
      type: 'realm-done',
      stdout: '',
      stderr: '',
      exitCode: 0,
    } satisfies RealmDoneMsg);
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(pm.list()[0].exitCode).toBe(1);
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

  // Regression: PR #786 review (Codex P2 — stamp websocket
  // subscriptions with the owning scoop). `attachRealmHost` was
  // being called without `scoopJid`, so `wsObserve` always stored
  // `undefined` and `dropForScoop(jid)` matched nothing on
  // `unregisterScoop`. The runner must thread `owner.scoopJid`
  // into the realm host's options so `wsObserve` can stamp it.
  it("threads owner.scoopJid into attachRealmHost (wsObserve stamps the subscriber's scoopJid)", async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const observed: Array<{ scoopJid?: string }> = [];
    const fakeRegistry = {
      observe: async (req: { targetId: string; scoopJid?: string; forward: unknown }) => {
        observed.push({ scoopJid: req.scoopJid });
        return {
          id: 'wssub-stub',
          targetId: req.targetId,
          forward: req.forward,
          createdAt: new Date().toISOString(),
        };
      },
      update: async () => ({}),
      close: async () => true,
      list: () => [],
    };
    const g = globalThis as { __slicc_wsSubscribers?: unknown; __slicc_browser?: unknown };
    const originalReg = g.__slicc_wsSubscribers;
    const originalBrowser = g.__slicc_browser;
    g.__slicc_wsSubscribers = fakeRegistry;
    // Stub a browser so `dispatchBrowser`'s `resolveBrowser(opts)` gate
    // doesn't throw before reaching the `wsObserve` case.
    g.__slicc_browser = {};
    try {
      const localCtx = {
        fs: { resolvePath: (b: string, p: string) => `${b}/${p}` },
      } as unknown as CommandContext;
      const promise = runInRealm({
        pm,
        realmFactory: async () => realm,
        owner: { kind: 'scoop', scoopJid: 'jid-X' },
        kind: 'js',
        code: '',
        argv: ['node'],
        env: {},
        cwd: '/workspace',
        filename: '<eval>',
        ctx: localCtx,
      });
      // Wait for the factory + attachRealmHost.
      await Promise.resolve();
      await Promise.resolve();
      // Realm-side issues a wsObserve via the RPC protocol.
      realm.fireMessage({
        type: 'realm-rpc-req',
        id: 'req-1',
        channel: 'browser',
        op: 'wsObserve',
        args: [{ targetId: 't1', forward: { sink: 'log' } }],
      });
      // Allow the async respond() to settle.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      realm.fireMessage({
        type: 'realm-done',
        stdout: '',
        stderr: '',
        exitCode: 0,
      } satisfies RealmDoneMsg);
      await promise;
      expect(observed).toHaveLength(1);
      expect(observed[0].scoopJid).toBe('jid-X');
    } finally {
      if (originalReg === undefined) delete g.__slicc_wsSubscribers;
      else g.__slicc_wsSubscribers = originalReg;
      if (originalBrowser === undefined) delete g.__slicc_browser;
      else g.__slicc_browser = originalBrowser;
    }
  });
});
