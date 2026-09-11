import { describe, expect, it, vi } from 'vitest';
import { handlePreviewRequest } from '../src/preview-handler.js';
import { handlePreviewUpload } from '../src/preview-routes.js';
import type { TrayRecord } from '../src/shared.js';
import { createTestEnv, setupConnectedLeader } from './preview-bridge-harness.js';

const base = 'https://www.sliccy.ai';
type Leader = Awaited<ReturnType<typeof setupConnectedLeader>>;
const post = (action: string, body: unknown) =>
  new Request(`https://internal/internal/preview/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const resolve = (token: string) =>
  new Request(`https://internal/internal/preview/resolve?token=${token}`);

/** Isolated opt-in: ordinary fixture tests intentionally mutate their fake store. */
async function cloneStorage(leader: Leader) {
  const storage = leader.state.storage;
  const get = storage.get.bind(storage);
  const put = storage.put.bind(storage);
  storage.get = async <T>(key: string) => structuredClone(await get<T>(key));
  storage.put = async <T>(key: string, value: T) => put(key, structuredClone(value));
  // Detach the already-created live tray from its previously shared stored value.
  await storage.put('tray', await storage.get('tray'));
  return Object.assign(storage, {
    setAlarm: vi.fn(async (_timestamp: number) => {}),
    deleteAlarm: vi.fn(async () => {}),
  });
}

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: vi.fn(async (key: string, value: ArrayBuffer) => {
      objects.set(key, new Uint8Array(value).slice());
      return { etag: key };
    }),
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes
        ? {
            body: bytes,
            size: bytes.byteLength,
            httpEtag: `"${key}"`,
            writeHttpMetadata: (headers: Headers) => headers.set('content-type', 'text/html'),
          }
        : null;
    }),
    list: vi.fn(async ({ prefix }: R2ListOptions) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(prefix ?? ''))
        .map((key) => ({ key })),
      truncated: false,
    })),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key);
    }),
  };
  return { objects, implementation: bucket, bucket: bucket as unknown as R2Bucket };
}

async function harness(persistent = false) {
  const r2 = memoryBucket();
  const clock = { now: Date.now() };
  const { env, namespace } = createTestEnv({ previewStorage: r2.bucket, now: () => clock.now });
  const newLeader = async () => {
    const leader = await setupConnectedLeader(env, namespace, base);
    const storage = await cloneStorage(leader);
    return { ...leader, storage };
  };
  const source = await newLeader();
  const target = await newLeader();
  const minted = await source.stub.fetch(
    post('mint', {
      controllerToken: source.controllerToken,
      servedRoot: '/site',
      entryPath: '/site/index.html',
      allowLive: true,
      workerBaseUrl: base,
      ...(persistent ? { ttlMs: 60_000 } : {}),
    })
  );
  expect(minted.status).toBe(200);
  const preview = (await minted.json()) as {
    previewToken: string;
    url: string;
    uploadToken: string;
  };
  const transfer = (from: Leader = source, to: Leader = target) =>
    from.stub.fetch(
      post('transfer', {
        controllerToken: from.controllerToken,
        targetTrayId: to.session.trayId,
        targetControllerToken: to.controllerToken,
      })
    );
  const upload = (content = 'data', mime = 'text/html') =>
    handlePreviewUpload(
      new Request(`${base}/upload?path=index.html`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${preview.uploadToken}`, 'content-type': mime },
        body: content,
      }),
      source.stub,
      r2.bucket,
      preview.previewToken
    );
  const finalize = () =>
    source.stub.fetch(
      post('finalize', {
        previewToken: preview.previewToken,
        uploadToken: preview.uploadToken,
      })
    );
  return {
    r2,
    clock,
    env,
    namespace,
    source,
    target,
    newLeader,
    preview,
    transfer,
    upload,
    finalize,
  };
}

function failPutOnce(leader: Leader, predicate: (tray: TrayRecord) => boolean) {
  const put = leader.state.storage.put.bind(leader.state.storage);
  let failed = false;
  const spy = vi.spyOn(leader.state.storage, 'put').mockImplementation(async (key, value) => {
    if (!failed && key === 'tray' && predicate(value as TrayRecord)) {
      failed = true;
      throw new Error('injected durable write failure');
    }
    await put(key, value);
  });
  return { spy, failed: () => failed };
}

describe('preview continuity durable failure recovery', () => {
  it.each([
    { end: 'expiry', failure: 'ambiguous commit' },
    { end: 'expiry', failure: 'failed delete' },
    { end: 'revoke', failure: 'ambiguous commit' },
    { end: 'revoke', failure: 'failed delete' },
  ])(
    'retains cleanup ownership when a put completes after $end: $failure',
    async ({ end, failure }) => {
      const h = await harness(true);
      expect((await h.transfer()).status).toBe(200);
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const put = h.r2.implementation.put.getMockImplementation()!;
      h.r2.implementation.put.mockImplementation(async (...args) => {
        await paused;
        return put(...args);
      });
      const upload = h.upload();
      await vi.waitFor(() => expect(h.r2.implementation.put).toHaveBeenCalled());
      if (end === 'expiry') {
        h.clock.now += 60_001;
        await h.target.stub.alarm();
      } else {
        expect(
          (
            await h.source.stub.fetch(
              post('stop', {
                controllerToken: h.source.controllerToken,
                previewToken: h.preview.previewToken,
              })
            )
          ).status
        ).toBe(200);
      }
      const tombstone = (await h.target.storage.get<TrayRecord>('tray'))!.previews![
        h.preview.previewToken
      ];
      expect(tombstone.state).toBe('cleanup');
      expect(tombstone.pendingUploadKeys).toHaveLength(1);
      expect(h.r2.objects.size).toBe(0);
      if (failure === 'ambiguous commit') {
        const fetch = h.target.stub.fetch.bind(h.target.stub);
        vi.spyOn(h.target.stub, 'fetch').mockImplementation((request) =>
          new URL(request.url).pathname.endsWith('/upload-commit')
            ? Promise.resolve(new Response('unknown', { status: 503 }))
            : fetch(request)
        );
      } else {
        h.r2.implementation.delete.mockRejectedValueOnce(new Error('delete unavailable'));
      }
      resume(); // The object first appears AFTER terminal cleanup swept its prefix.
      expect((await upload).status).toBe(failure === 'ambiguous commit' ? 503 : 404);
      h.clock.now += 60_001;
      await h.namespace.reconstruct(h.target.session.trayId).alarm();
      expect(h.r2.objects.size).toBe(0);
      expect(
        (await h.target.storage.get<TrayRecord>('tray'))!.previews![h.preview.previewToken]
      ).toBeUndefined();
    }
  );

  it('keeps a tombstone sweeping even when a timed-out R2 put materializes after cleanup', async () => {
    const h = await harness(true);
    expect((await h.transfer()).status).toBe(200);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const put = h.r2.implementation.put.getMockImplementation()!;
    h.r2.implementation.put.mockImplementation(async (...args) => {
      await paused;
      return put(...args);
    });
    vi.useFakeTimers();
    try {
      const upload = h.upload();
      await vi.waitFor(() => expect(h.r2.implementation.put).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await upload).status).toBe(502);
      h.clock.now += 60_001;
      await h.target.stub.alarm();
      expect(h.r2.objects.size).toBe(0);
      resume();
      await vi.waitFor(() => expect(h.r2.objects.size).toBe(1));
      h.clock.now += 60_001;
      await h.namespace.reconstruct(h.target.session.trayId).alarm();
      expect(h.r2.objects.size).toBe(0);
      expect(
        (await h.target.storage.get<TrayRecord>('tray'))!.previews![h.preview.previewToken].state
      ).toBe('cleanup');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled request body and releases its lease without ever starting an R2 write', async () => {
    const h = await harness(true);
    const cancel = vi.fn();
    const request = new Request(`${base}/upload?path=index.html`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${h.preview.uploadToken}` },
      body: new ReadableStream({ cancel }),
      duplex: 'half',
    } as RequestInit);
    vi.useFakeTimers();
    try {
      const upload = handlePreviewUpload(
        request,
        h.source.stub,
        h.r2.bucket,
        h.preview.previewToken
      );
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await upload).status).toBe(408);
      expect(cancel).toHaveBeenCalled();
      expect(h.r2.implementation.put).not.toHaveBeenCalled();
      expect(
        (await h.source.storage.get<TrayRecord>('tray'))!.previews![h.preview.previewToken]
          .pendingUploadKeys
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds unresolved leases instead of permitting unlimited cleanup bookkeeping', async () => {
    const h = await harness(true);
    const authorize = () =>
      h.source.stub.fetch(
        post('upload-authorize', {
          previewToken: h.preview.previewToken,
          uploadToken: h.preview.uploadToken,
          relativePath: 'index.html',
          size: 4,
        })
      );
    for (let i = 0; i < 8; i++) expect((await authorize()).status).toBe(200);
    expect((await authorize()).status).toBe(429);
    expect(
      (await h.source.storage.get<TrayRecord>('tray'))!.previews![h.preview.previewToken]
        .pendingUploadKeys
    ).toHaveLength(8);
  });

  it('retries a failed A locator write during B to C before acknowledging, then survives restarting A', async () => {
    const h = await harness();
    expect((await h.transfer()).status).toBe(200);
    const third = await h.newLeader();
    const failure = failPutOnce(
      h.source,
      (tray) => tray.previewForwarding?.[h.preview.previewToken] === third.session.trayId
    );
    expect((await h.transfer(h.target, third)).status).toBe(503);
    expect(failure.failed()).toBe(true);
    expect(
      (await h.source.storage.get<TrayRecord>('tray'))!.previewForwarding![h.preview.previewToken]
    ).toBe(h.target.session.trayId);
    failure.spy.mockRestore();
    // Retry the same live original instance: no restart to hide a stale cache.
    expect((await h.transfer(h.target, third)).status).toBe(200);
    const original = h.namespace.reconstruct(h.source.session.trayId);
    const response = await original.fetch(resolve(h.preview.previewToken));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-slicc-preview-tray')).toBe(third.session.trayId);
  });

  it.each(['pending', 'forwarded', 'complete', 'import', 'activate'] as const)(
    'reloads durable state after the %s write fails instead of trusting an uncommitted phase/receipt',
    async (stage) => {
      const h = await harness();
      const owner = stage === 'import' || stage === 'activate' ? h.target : h.source;
      const failure = failPutOnce(owner, (tray) =>
        stage === 'import'
          ? tray.previewImports?.[h.source.session.trayId]?.activated === false
          : stage === 'activate'
            ? tray.previewImports?.[h.source.session.trayId]?.activated === true
            : tray.previewTransfer?.phase === stage
      );
      expect((await h.transfer()).status).toBe(503);
      expect(failure.failed()).toBe(true);
      failure.spy.mockRestore();
      expect((await h.transfer()).status).toBe(200);
      h.namespace.reconstruct(h.target.session.trayId);
      const original = h.namespace.reconstruct(h.source.session.trayId);
      expect((await original.fetch(resolve(h.preview.previewToken))).status).toBe(200);
    }
  );

  it('reinstalls a failed imported snapshot alarm on retry and expires R2 without any preview read', async () => {
    const h = await harness(true);
    expect((await h.upload()).status).toBe(204);
    expect((await h.finalize()).status).toBe(200);
    const expiry = (await h.source.storage.get<TrayRecord>('tray'))!.previews![
      h.preview.previewToken
    ].expiresAt!;
    h.target.storage.setAlarm.mockRejectedValueOnce(new Error('alarm installation failed'));
    expect((await h.transfer()).status).toBe(503);
    h.namespace.reconstruct(h.target.session.trayId);
    expect((await h.transfer()).status).toBe(200);
    expect(h.target.storage.setAlarm).toHaveBeenLastCalledWith(Date.parse(expiry));
    const target = h.namespace.reconstruct(h.target.session.trayId);
    h.clock.now = Date.parse(expiry) + 1;
    await target.alarm();
    expect(h.r2.objects.size).toBe(0);
    expect(
      (await h.target.storage.get<TrayRecord>('tray'))!.previews![h.preview.previewToken]
    ).toBeUndefined();
  });

  it('keeps committed bytes after a forwarded response is lost and reconciles replay without overwrite', async () => {
    const h = await harness(true);
    expect((await h.transfer()).status).toBe(200);
    const fetch = h.target.stub.fetch.bind(h.target.stub);
    const spy = vi.spyOn(h.target.stub, 'fetch').mockImplementation(async (request) => {
      const response = await fetch(request);
      if (new URL(request.url).pathname.endsWith('/upload-commit'))
        throw new Error('response lost after commit');
      return response;
    });
    expect((await h.upload()).status).toBe(503);
    spy.mockRestore();
    const committed = (await h.target.storage.get<TrayRecord>('tray'))!.previews![
      h.preview.previewToken
    ].uploadedFiles!['index.html'];
    expect(h.r2.objects.has(committed.key)).toBe(true);
    expect((await h.upload('evil')).status).toBe(409); // Same length, different digest.
    expect((await h.upload('data', 'application/octet-stream')).status).toBe(409);
    expect((await h.upload('longer')).status).toBe(409);
    expect((await h.upload()).status).toBe(204);
    expect(h.r2.implementation.put).toHaveBeenCalledTimes(1);
    expect(h.r2.implementation.delete).not.toHaveBeenCalled();
    expect((await h.finalize()).status).toBe(200);
    const response = await handlePreviewRequest(new Request(h.preview.url), h.env);
    expect(await response.text()).toBe('data');
  });

  it('expires ambiguous uncommitted upload objects with the owner archive rather than leaking them', async () => {
    const h = await harness(true);
    expect((await h.transfer()).status).toBe(200);
    const fetch = h.target.stub.fetch.bind(h.target.stub);
    const spy = vi
      .spyOn(h.target.stub, 'fetch')
      .mockImplementation((request) =>
        new URL(request.url).pathname.endsWith('/upload-commit')
          ? Promise.resolve(new Response('outcome unknown', { status: 503 }))
          : fetch(request)
      );
    expect((await h.upload()).status).toBe(503);
    spy.mockRestore();
    expect(h.r2.objects.size).toBe(1);
    expect((await h.upload()).status).toBe(204);
    expect(h.r2.objects.size).toBe(2);
    h.clock.now += 60_001;
    await h.namespace.reconstruct(h.target.session.trayId).alarm();
    expect(h.r2.objects.size).toBe(0);
  });
});
