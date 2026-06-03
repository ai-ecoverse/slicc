/**
 * Tests for `runInPooledRealm` — the warm-reuse runner.
 *
 * A fake pool hands out a lease wrapping an in-memory mock realm and
 * records `release()` vs `evict()`. Pins: clean exit RELEASES the
 * lease, errors / SIGKILL EVICT it (137 on kill), and the realm host
 * is re-attached to the CURRENT checkout's `CommandContext` (the
 * previous run's host is disposed on return).
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { ProcessManager } from '../../../src/kernel/process-manager.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import type { Realm, RealmLease, RealmPool } from '../../../src/kernel/realm/realm-runner.js';
import { runInPooledRealm } from '../../../src/kernel/realm/realm-runner.js';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface MockRealm extends Realm {
  fireMessage(data: unknown): void;
  posted: unknown[];
  lastPosted(): unknown;
}

function makeMockRealm(): MockRealm {
  const handlers = new Set<(e: MessageEvent) => void>();
  const posted: unknown[] = [];
  const port: RealmPortLike = {
    postMessage: (msg) => posted.push(msg),
    addEventListener: (_t, h) => handlers.add(h),
    removeEventListener: (_t, h) => handlers.delete(h),
  };
  return {
    controlPort: port,
    terminate: vi.fn(),
    posted,
    fireMessage: (data) => {
      for (const h of [...handlers]) h({ data } as MessageEvent);
    },
    lastPosted: () => posted[posted.length - 1],
  };
}

function makeReusingPool(realm: Realm): {
  pool: RealmPool;
  events: { releases: number; evicts: number; checkouts: CommandContext[] };
} {
  const events = { releases: 0, evicts: 0, checkouts: [] as CommandContext[] };
  const pool: RealmPool = {
    checkout: async (ctx) => {
      events.checkouts.push(ctx);
      let done = false;
      const lease: RealmLease = {
        realm,
        release: () => {
          if (done) return;
          done = true;
          events.releases++;
        },
        evict: () => {
          if (done) return;
          done = true;
          events.evicts++;
        },
      };
      return lease;
    },
    dispose: () => {},
  };
  return { pool, events };
}

const baseOpts = {
  owner: { kind: 'cone' as const },
  code: '',
  argv: ['python3'],
  env: {},
  cwd: '/workspace',
  filename: '-c',
  ctx: {} as CommandContext,
};

describe('runInPooledRealm', () => {
  it('posts realm-init, resolves on realm-done, and RELEASES the lease', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const { pool, events } = makeReusingPool(realm);
    const promise = runInPooledRealm({ pm, pool, ...baseOpts, code: 'print(1)' });
    await flush();
    expect(realm.lastPosted()).toMatchObject({ type: 'realm-init', kind: 'py', code: 'print(1)' });
    realm.fireMessage({ type: 'realm-done', stdout: '1\n', stderr: '', exitCode: 0 });
    const result = await promise;
    expect(result).toEqual({ stdout: '1\n', stderr: '', exitCode: 0 });
    expect(events).toMatchObject({ releases: 1, evicts: 0 });
    const proc = pm.list()[0];
    expect(proc.kind).toBe('py');
    expect(proc.exitCode).toBe(0);
  });

  it('EVICTS the lease on realm-error (exit 1)', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const { pool, events } = makeReusingPool(realm);
    const promise = runInPooledRealm({ pm, pool, ...baseOpts });
    await flush();
    realm.fireMessage({ type: 'realm-error', message: 'boom' });
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
    expect(events).toMatchObject({ releases: 0, evicts: 1 });
  });

  it('SIGKILL exits 137 and EVICTS the lease', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const { pool, events } = makeReusingPool(realm);
    const promise = runInPooledRealm({ pm, pool, ...baseOpts, code: 'while True: pass' });
    await flush();
    const proc = pm.list()[0];
    pm.signal(proc.pid, 'SIGKILL');
    const result = await promise;
    expect(result.exitCode).toBe(137);
    expect(events).toMatchObject({ releases: 0, evicts: 1 });
    expect(proc.status).toBe('killed');
  });

  it('fails fast (exit 1) when checkout rejects', async () => {
    const pm = new ProcessManager();
    const pool: RealmPool = {
      checkout: async () => Promise.reject(new Error('no capacity')),
      dispose: () => {},
    };
    const result = await runInPooledRealm({ pm, pool, ...baseOpts });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no capacity');
    expect(pm.list()[0].exitCode).toBe(1);
  });

  it('re-attaches the host to the current ctx on each checkout (old host disposed)', async () => {
    const pm = new ProcessManager();
    const realm = makeMockRealm();
    const { pool } = makeReusingPool(realm);
    const makeFsCtx = (marker: string): CommandContext =>
      ({
        cwd: '/workspace',
        fs: { resolvePath: (b: string, p: string) => `${b}/${p}`, readFile: async () => marker },
      }) as unknown as CommandContext;

    const p1 = runInPooledRealm({ pm, pool, ...baseOpts, ctx: makeFsCtx('A') });
    await flush();
    realm.fireMessage({ type: 'realm-done', stdout: '', stderr: '', exitCode: 0 });
    await p1;

    const p2 = runInPooledRealm({ pm, pool, ...baseOpts, ctx: makeFsCtx('B') });
    await flush();
    realm.posted.length = 0;
    realm.fireMessage({
      type: 'realm-rpc-req',
      id: 99,
      channel: 'vfs',
      op: 'readFile',
      args: ['x.txt'],
    });
    await flush();
    const results = realm.posted
      .filter((m): m is { type: string; id: number; result: unknown } => {
        const x = m as { type?: string; id?: number };
        return x?.type === 'realm-rpc-res' && x.id === 99;
      })
      .map((m) => m.result);
    expect(results).toEqual(['B']); // exactly one response, from ctxB → host A disposed
    realm.fireMessage({ type: 'realm-done', stdout: '', stderr: '', exitCode: 0 });
    await p2;
  });
});
