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

function makeDoEnv(substrate: FakeSubstrate) {
  return {
    E2B_API_KEY: 'test',
    CONE_CAP_RUNNING: '1',
    CONE_CAP_PAUSED: '5',
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

describe('CloudSessionsDurableObject — lifecycle endpoints', () => {
  it('start-cone creates a new cone when under cap', async () => {
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

  it('start-cone returns 403 CAP_EXCEEDED when running cap is hit', async () => {
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
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('CAP_EXCEEDED');
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

  it('concurrent start-cone calls serialize via blockConcurrencyWhile — second gets CAP_EXCEEDED', async () => {
    const substrate = new FakeSubstrate();
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));

    // Launch two concurrent start-cone requests. The DO's blockConcurrencyWhile
    // serializes them: first reserves a slot, second tries to reserve and hits cap.
    const [res1, res2] = await Promise.all([
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
    ]);

    // One should succeed (200), the other should get CAP_EXCEEDED (403)
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 403]);

    const bodies = await Promise.all([res1.json(), res2.json()]);
    const errors = bodies.filter((b) => b.error);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBe('CAP_EXCEEDED');
  });

  it('concurrent resume-cone calls serialize via blockConcurrencyWhile — second gets CAP_EXCEEDED', async () => {
    // Setup: two paused cones, cap=1 running.
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s1', { metadata: { userId: 'u1', name: 'a' }, state: 'paused' });
    substrate.seedSandbox('s2', { metadata: { userId: 'u1', name: 'b' }, state: 'paused' });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
    // Pre-populate registry with both cones (since substrate.list discovery is needed):
    await call(do_, '/list-cones', { userId: 'u1' });
    // Concurrent resumes:
    const [res1, res2] = await Promise.all([
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
    ]);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 403]); // one succeeds, one CAP_EXCEEDED
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
