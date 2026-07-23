import type {
  CreateOpts,
  RunResult,
  SandboxHandle,
  SandboxInfo,
  SandboxSubstrate,
  SandboxSummary,
} from '@slicc/cloud-core';
import { describe, expect, it } from 'vitest';
import { CloudSessionsDurableObject } from '../src/cloud/cloud-sessions-do.js';

// Substrate states only — 'reserved' is a registry-only state, never reported
// by the substrate (e2b). Mirrors SandboxSummary.state in cloud-core.
interface FakeSandbox {
  id: string;
  state: 'running' | 'paused' | 'dead';
  metadata: Record<string, string>;
  name?: string;
  createdAt: string;
  joinUrl: string;
  trayId: string;
  files: Map<string, string>;
}

class FakeSubstrate implements SandboxSubstrate {
  readonly id = 'e2b' as const;
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly createdTemplates: string[] = [];
  private nextId = 1;
  /** If set, connect() will throw this error. Used to test rollback logic. */
  connectError?: Error;

  seedSandbox(
    id: string,
    opts: {
      state?: FakeSandbox['state'];
      metadata?: Record<string, string>;
      name?: string;
      joinUrl?: string;
      trayId?: string;
    } = {}
  ): void {
    this.sandboxes.set(id, {
      id,
      state: opts.state ?? 'running',
      metadata: opts.metadata ?? {},
      name: opts.name ?? opts.metadata?.['name'],
      createdAt: new Date().toISOString(),
      joinUrl: opts.joinUrl ?? `https://w/join/${id}`,
      trayId: opts.trayId ?? `tray-${id}`,
      files: new Map(),
    });
  }

  async create(opts: CreateOpts): Promise<SandboxHandle> {
    this.createdTemplates.push(opts.template);
    const id = `sbx-${this.nextId++}`;
    this.seedSandbox(id, {
      state: 'running',
      metadata: opts.metadata ?? {},
      name: opts.name,
    });
    return this.handle(id);
  }

  async connect(sandboxId: string): Promise<SandboxHandle> {
    if (this.connectError) throw this.connectError;
    const s = this.sandboxes.get(sandboxId);
    if (!s) throw new Error(`unknown sandbox ${sandboxId}`);
    if (s.state === 'paused') s.state = 'running';
    return this.handle(sandboxId);
  }

  async list(opts?: import('@slicc/cloud-core').ListOpts): Promise<SandboxSummary[]> {
    const all = Array.from(this.sandboxes.values()).map((s) => ({
      sandboxId: s.id,
      state: s.state,
      metadata: s.metadata,
      createdAt: s.createdAt,
      name: s.name,
    }));
    // Filter by metadata if provided (mimics e2b server-side filtering)
    const meta = opts?.metadata;
    if (!meta) return all;
    return all.filter((s) => {
      if (!s.metadata) return false;
      for (const [k, v] of Object.entries(meta)) {
        if (s.metadata[k] !== v) return false;
      }
      return true;
    });
  }

  async extendTimeout(_sandboxId: string, _ttlMs: number): Promise<void> {
    // No-op for tests.
  }

  private handle(sandboxId: string): SandboxHandle {
    const sb = this.sandboxes.get(sandboxId)!;
    return {
      sandboxId,
      substrate: 'e2b',
      pause: async () => {
        sb.state = 'paused';
      },
      kill: async () => {
        sb.state = 'dead';
        this.sandboxes.delete(sandboxId);
      },
      getInfo: async (): Promise<SandboxInfo> => ({
        sandboxId,
        state: sb.state,
        metadata: sb.metadata,
        createdAt: sb.createdAt,
      }),
      writeFile: async (path: string, contents: string | Uint8Array) => {
        sb.files.set(
          path,
          typeof contents === 'string' ? contents : new TextDecoder().decode(contents)
        );
      },
      readFile: async (path: string): Promise<string> => {
        if (path === '/tmp/slicc-join.json') {
          return JSON.stringify({
            joinUrl: sb.joinUrl,
            trayId: sb.trayId,
            updatedAt: new Date().toISOString(),
          });
        }
        const f = sb.files.get(path);
        if (f !== undefined) return f;
        throw new Error(`ENOENT ${path}`);
      },
      run: async (_cmd: string): Promise<RunResult> => ({
        stdout: '200',
        stderr: '',
        exitCode: 0,
      }),
    };
  }
}

function makeFakeState() {
  const storage = new Map<string, unknown>();
  const lockQueue: Array<() => void> = [];
  let locked = false;

  const state = {
    storage: {
      get: async <T>(k: string): Promise<T | undefined> => storage.get(k) as T | undefined,
      put: async <T>(k: string, v: T): Promise<void> => {
        storage.set(k, v);
      },
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => {
      // Serialize access: wait for lock, run fn, release lock
      while (locked) {
        await new Promise<void>((resolve) => lockQueue.push(resolve));
      }
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
        const next = lockQueue.shift();
        if (next) next();
      }
    },
  };
  return { state, storage };
}

function makeDoEnv(substrate: FakeSubstrate, templateName?: string) {
  return {
    E2B_API_KEY: 'test',
    ...(templateName === undefined ? {} : { SLICC_E2B_TEMPLATE_NAME: templateName }),
    __SUBSTRATE_FACTORY__: () => substrate as SandboxSubstrate,
  };
}

async function call(
  do_: CloudSessionsDurableObject,
  path: string,
  body: unknown
): Promise<Response> {
  return do_.fetch(
    new Request(`https://do${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

/** A promise plus its externally-callable resolve, for barrier-style test coordination. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Bound any barrier wait with a timeout so a broken concurrency invariant
 * fails the test with a clear message instead of hanging until the test
 * runner's own timeout fires.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

describe('CloudSessionsDurableObject — lifecycle endpoints', () => {
  it.each([
    { label: 'production default', configured: undefined, expected: 'slicc' },
    { label: 'staging override', configured: 'slicc-staging', expected: 'slicc-staging' },
    { label: 'blank override', configured: '   ', expected: 'slicc' },
  ])('uses the $label template alias', async ({ configured, expected }) => {
    const substrate = new FakeSubstrate();
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate, configured));

    const response = await call(do_, '/start-cone', {
      bearer: 'b',
      userId: 'u1',
      workerOrigin: 'https://w',
      name: `template-${expected}`,
    });

    expect(response.status).toBe(200);
    expect(substrate.createdTemplates).toEqual([expected]);
  });

  it('start-cone creates a new cone', async () => {
    const substrate = new FakeSubstrate();
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
    const res = await call(do_, '/start-cone', {
      bearer: 'b',
      userId: 'u1',
      workerOrigin: 'https://w',
      name: 'smoke',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sandboxId: string; joinUrl: string };
    expect(body.sandboxId).toMatch(/^sbx-/);
    expect(body.joinUrl).toMatch(/^https:\/\//);
  });

  it('start-cone succeeds when another cone is already running', async () => {
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s1', {
      metadata: { userId: 'u1', name: 'existing' },
      state: 'running',
    });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));

    const res = await call(do_, '/start-cone', {
      bearer: 'b',
      userId: 'u1',
      workerOrigin: 'https://w',
      name: 'next',
    });

    expect(res.status).toBe(200);
    expect(substrate.sandboxes.size).toBe(2);
  });

  it('start-cone returns 409 NAME_TAKEN for a duplicate live name', async () => {
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s1', {
      metadata: { userId: 'u1', name: 'existing' },
      state: 'paused',
    });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
    const res = await call(do_, '/start-cone', {
      bearer: 'b',
      userId: 'u1',
      workerOrigin: 'https://w',
      name: ' existing ',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('NAME_TAKEN');
  });

  it('list-cones reconciles substrate orphans into DO state', async () => {
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s-orphan', {
      metadata: { userId: 'u1', name: 'orphan' },
      state: 'running',
    });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
    const res = await call(do_, '/list-cones', { userId: 'u1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cones: Array<{ sandboxId: string }> };
    expect(body.cones.some((c) => c.sandboxId === 's-orphan')).toBe(true);
  });

  it('list-cones filters by userId metadata (other users not visible)', async () => {
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('mine', { metadata: { userId: 'u1', name: 'mine' }, state: 'running' });
    substrate.seedSandbox('theirs', {
      metadata: { userId: 'u2', name: 'theirs' },
      state: 'running',
    });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
    const res = await call(do_, '/list-cones', { userId: 'u1' });
    const body = (await res.json()) as { cones: Array<{ sandboxId: string }> };
    expect(body.cones.some((c) => c.sandboxId === 'mine')).toBe(true);
    expect(body.cones.some((c) => c.sandboxId === 'theirs')).toBe(false);
  });

  it('kill-cone is idempotent (returns 200 even when target never existed)', async () => {
    const substrate = new FakeSubstrate();
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
    const res = await call(do_, '/kill-cone', { sandboxId: 'never-existed' });
    expect(res.status).toBe(200);
  });

  it('start-cone does not timeout even when substrate.create is slow', async () => {
    const substrate = new FakeSubstrate();
    // Override create to simulate slow substrate.create (but not so slow it actually times out the test).
    const originalCreate = substrate.create.bind(substrate);
    substrate.create = async (opts: CreateOpts) => {
      await new Promise((r) => setTimeout(r, 150)); // Simulate ~150ms delay
      return originalCreate(opts);
    };

    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));

    const res = await call(do_, '/start-cone', {
      bearer: 'b',
      userId: 'u1',
      workerOrigin: 'https://w',
      name: 'slow-start',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sandboxId: string; joinUrl: string };
    expect(body.sandboxId).toMatch(/^sbx-/);
    expect(body.joinUrl).toMatch(/^https:\/\//);
  });

  it('allows two distinct concurrent start-cone calls', async () => {
    const substrate = new FakeSubstrate();
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));

    // Barrier: neither substrate.create() call is allowed to complete until
    // BOTH have entered the slow create phase, proving they ran concurrently
    // rather than serialized behind the DO lock.
    const entered: string[] = [];
    const bothEntered = deferred<void>();
    const originalCreate = substrate.create.bind(substrate);
    substrate.create = async (opts: CreateOpts) => {
      entered.push(opts.name ?? '');
      if (entered.length === 2) bothEntered.resolve();
      await withTimeout(bothEntered.promise, 2000, 'both starts should enter create phase');
      return originalCreate(opts);
    };

    const responses = await withTimeout(
      Promise.all([
        call(do_, '/start-cone', {
          bearer: 'b1',
          userId: 'u1',
          workerOrigin: 'https://w',
          name: 'first',
        }),
        call(do_, '/start-cone', {
          bearer: 'b2',
          userId: 'u1',
          workerOrigin: 'https://w',
          name: 'second',
        }),
      ]),
      2000,
      'both start-cone calls should resolve after barrier release'
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(entered.sort()).toEqual(['first', 'second']);
    expect(
      Array.from(substrate.sandboxes.values())
        .map((sandbox) => sandbox.name)
        .sort()
    ).toEqual(['first', 'second']);
  });

  it('returns NAME_TAKEN for a concurrent same-name start while the first create is in flight', async () => {
    const substrate = new FakeSubstrate();
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));

    // Hold the first create() call open so the second start-cone call must
    // observe the reserved name while the first is still in flight.
    const entered = deferred<void>();
    const releaseCreate = deferred<void>();
    const originalCreate = substrate.create.bind(substrate);
    substrate.create = async (opts: CreateOpts) => {
      entered.resolve();
      await withTimeout(releaseCreate.promise, 2000, 'first create should be released');
      return originalCreate(opts);
    };

    const firstStart = call(do_, '/start-cone', {
      bearer: 'b1',
      userId: 'u1',
      workerOrigin: 'https://w',
      name: 'dup',
    });
    await withTimeout(
      entered.promise,
      2000,
      'first start should reserve the name and reach create before the duplicate check'
    );

    const secondStart = await call(do_, '/start-cone', {
      bearer: 'b2',
      userId: 'u1',
      workerOrigin: 'https://w',
      name: 'dup',
    });
    expect(secondStart.status).toBe(409);
    expect(((await secondStart.json()) as { error: string }).error).toBe('NAME_TAKEN');

    releaseCreate.resolve();
    const firstRes = await withTimeout(
      firstStart,
      2000,
      'first start should complete after release'
    );
    expect(firstRes.status).toBe(200);
  });

  it('allows two different paused cones to resume concurrently', async () => {
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s1', { metadata: { userId: 'u1', name: 'a' }, state: 'paused' });
    substrate.seedSandbox('s2', { metadata: { userId: 'u1', name: 'b' }, state: 'paused' });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
    await call(do_, '/list-cones', { userId: 'u1' });

    // Barrier: neither substrate.connect() call is allowed to complete until
    // BOTH have entered the slow connect phase, proving they ran concurrently
    // rather than serialized behind the DO lock.
    const entered: string[] = [];
    const bothEntered = deferred<void>();
    const originalConnect = substrate.connect.bind(substrate);
    substrate.connect = async (sandboxId: string) => {
      entered.push(sandboxId);
      if (entered.length === 2) bothEntered.resolve();
      await withTimeout(bothEntered.promise, 2000, 'both resumes should enter connect phase');
      return originalConnect(sandboxId);
    };

    const responses = await withTimeout(
      Promise.all([
        call(do_, '/resume-cone', {
          bearer: 'b',
          sandboxId: 's1',
          localSliccVersion: 'v',
          userId: 'u1',
        }),
        call(do_, '/resume-cone', {
          bearer: 'b',
          sandboxId: 's2',
          localSliccVersion: 'v',
          userId: 'u1',
        }),
      ]),
      2000,
      'both resume-cone calls should resolve after barrier release'
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(entered.sort()).toEqual(['s1', 's2']);
    expect(substrate.sandboxes.get('s1')?.state).toBe('running');
    expect(substrate.sandboxes.get('s2')?.state).toBe('running');
  });

  it('rejects a duplicate concurrent resume of the same cone while the first is in flight', async () => {
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s1', { metadata: { userId: 'u1', name: 'a' }, state: 'paused' });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
    await call(do_, '/list-cones', { userId: 'u1' });

    // Hold the first resume's connect() open so the second resume must
    // observe the 'reserved' state flip while the first is still in flight.
    const entered = deferred<void>();
    const releaseConnect = deferred<void>();
    const originalConnect = substrate.connect.bind(substrate);
    substrate.connect = async (sandboxId: string) => {
      entered.resolve();
      await withTimeout(releaseConnect.promise, 2000, 'first resume should be released');
      return originalConnect(sandboxId);
    };

    const firstResume = call(do_, '/resume-cone', {
      bearer: 'b',
      sandboxId: 's1',
      localSliccVersion: 'v',
      userId: 'u1',
    });
    await withTimeout(
      entered.promise,
      2000,
      'first resume should flip to reserved and reach connect before the duplicate check'
    );

    const secondResume = await call(do_, '/resume-cone', {
      bearer: 'b',
      sandboxId: 's1',
      localSliccVersion: 'v',
      userId: 'u1',
    });
    expect(secondResume.status).toBe(409);
    expect(((await secondResume.json()) as { error: string }).error).toBe('ALREADY_RUNNING');

    releaseConnect.resolve();
    const firstRes = await withTimeout(
      firstResume,
      2000,
      'first resume should complete after release'
    );
    expect(firstRes.status).toBe(200);
    expect(substrate.sandboxes.get('s1')?.state).toBe('running');
  });

  it('resume-cone rolls back to original state on failure', async () => {
    // Setup: paused cone, but substrate.connect will fail after state flip.
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s-fail', { metadata: { userId: 'u1', name: 'fail' }, state: 'paused' });
    // Configure substrate to throw on connect (after the reserved flip)
    substrate.connectError = new Error('Substrate connect failed');
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));

    // Pre-populate registry with paused entry so listCones doesn't fail
    const entry = {
      sandboxId: 's-fail',
      substrate: 'e2b',
      name: 'fail',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'paused' as const,
      joinUrl: 'https://w/join/s-fail',
      metadata: { userId: 'u1', name: 'fail' },
    };
    await state.storage.put('cloud-sessions-list', [entry.sandboxId]);
    await state.storage.put(`cloud-sessions:s-fail`, entry);

    const res = await call(do_, '/resume-cone', {
      bearer: 'b',
      sandboxId: 's-fail',
      localSliccVersion: 'v',
      userId: 'u1',
    });

    // Should fail with substrate error
    expect(res.status).toBe(500);

    // Check that registry entry rolled back to 'paused', not stuck in 'reserved'
    const finalEntry = await state.storage.get<typeof entry>('cloud-sessions:s-fail');
    expect(finalEntry?.state).toBe('paused');
  });

  it('resume-cone stamps tokenExpiresAt on the refreshed Adobe account (JWT bearer)', async () => {
    // Regression: resuming with only the fresh IMS bearer (no user-supplied
    // adobe account delta) must carry an expiry, or the window-less kernel
    // worker treats the valid token as expired and throws "Adobe session
    // expired" on the first turn after resume.
    const created = 1_780_000_000_000;
    const ttl = 86_400_000; // 24h
    const b64url = (o: object) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwtBearer = [
      b64url({ alg: 'RS256', typ: 'JWT' }),
      b64url({ created_at: String(created), expires_in: String(ttl) }),
      'sig',
    ].join('.');

    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s-jwt', { metadata: { userId: 'u1', name: 'jwt' }, state: 'paused' });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
    await call(do_, '/list-cones', { userId: 'u1' });

    const res = await call(do_, '/resume-cone', {
      bearer: jwtBearer,
      sandboxId: 's-jwt',
      localSliccVersion: 'v',
      userId: 'u1',
    });
    expect(res.status).toBe(200);

    // Read back the cone-config.json the resume merge wrote into the sandbox.
    const written = await (await substrate.connect('s-jwt')).readFile('/slicc/cone-config.json');
    const adobe = (JSON.parse(written).accounts as Array<{ providerId: string }>).find(
      (a) => a.providerId === 'adobe'
    );
    expect(adobe).toMatchObject({ kind: 'oauth', tokenExpiresAt: created + ttl });
  });

  it('resume-cone strips user-supplied adobe account so the fresh bearer wins', async () => {
    const created = 1_780_000_000_000;
    const ttl = 86_400_000;
    const b64url = (o: object) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const freshBearer = [
      b64url({ alg: 'RS256', typ: 'JWT' }),
      b64url({ created_at: String(created), expires_in: String(ttl) }),
      'fresh-sig',
    ].join('.');
    const staleToken = 'stale-adobe-token-from-localstorage';

    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s-stale', {
      metadata: { userId: 'u1', name: 'stale' },
      state: 'paused',
    });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
    await call(do_, '/list-cones', { userId: 'u1' });

    const res = await call(do_, '/resume-cone', {
      bearer: freshBearer,
      sandboxId: 's-stale',
      localSliccVersion: 'v',
      userId: 'u1',
      coneConfigDelta: {
        upsert: {
          accounts: [
            { providerId: 'adobe', kind: 'oauth', accessToken: staleToken },
            { providerId: 'github', kind: 'oauth', accessToken: 'ghp_valid' },
          ],
        },
      },
    });
    expect(res.status).toBe(200);

    const written = await (await substrate.connect('s-stale')).readFile('/slicc/cone-config.json');
    const accounts = JSON.parse(written).accounts as Array<{
      providerId: string;
      accessToken?: string;
    }>;
    const adobe = accounts.find((a) => a.providerId === 'adobe');
    const github = accounts.find((a) => a.providerId === 'github');
    // Fresh bearer from the Auth header wins — stale user-supplied adobe is stripped
    expect(adobe?.accessToken).toBe(freshBearer);
    // Non-adobe user accounts pass through
    expect(github?.accessToken).toBe('ghp_valid');
  });
});
