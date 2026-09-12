import { describe, expect, it, vi } from 'vitest';
import { handlePreviewRequest } from '../src/preview-handler.js';
import { handlePreviewUpload } from '../src/preview-routes.js';
import {
  PREVIEW_CLEANUP_HORIZON_MS,
  PREVIEW_UPLOAD_LEASE_MS,
} from '../src/session-tray-preview.js';
import { TRAY_RECLAIM_TTL_MS, type TrayRecord } from '../src/shared.js';
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

async function harness(persistent = false, ttlMs = 60_000) {
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
      ...(persistent ? { ttlMs } : {}),
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
  async function expireTarget(h: Awaited<ReturnType<typeof harness>>) {
    const socket = h.target.state.getWebSockets('leader')[0];
    socket.close();
    await h.target.stub.webSocketClose(socket);
    h.clock.now += TRAY_RECLAIM_TTL_MS + 1;
    const response = await h.target.stub.fetch(
      new Request('https://internal/internal/confirm-controller', {
        method: 'POST',
        body: JSON.stringify({ controllerToken: h.target.controllerToken }),
      })
    );
    expect(await response.json()).toEqual({ confirmed: false });
    expect((await h.target.storage.get<TrayRecord>('tray'))?.expiredAt).toBeDefined();
  }

  it('explicitly permits replacing an expired target only before the source freezes', async () => {
    const h = await harness();
    await expireTarget(h);
    const refused = await h.transfer();
    expect(refused.status).toBe(410);
    expect(await refused.json()).toMatchObject({ code: 'PREVIEW_TARGET_UNAVAILABLE' });
    expect((await h.source.storage.get<TrayRecord>('tray'))?.previewTransfer).toBeUndefined();
    const next = await h.newLeader();
    expect((await h.transfer(h.source, next)).status).toBe(200);
    expect(
      (await h.source.stub.fetch(resolve(h.preview.previewToken))).headers.get(
        'x-slicc-preview-tray'
      )
    ).toBe(next.session.trayId);
  });

  it.each(['import', 'relocate', 'activate'])(
    'finishes a frozen pair after real target expiry at %s, then roves from that owner',
    async (stage) => {
      const h = await harness();
      const failing = stage === 'relocate' ? h.source.stub : h.target.stub;
      const fetch = failing.fetch.bind(failing);
      let failed = false;
      const spy = vi.spyOn(failing, 'fetch').mockImplementation(async (request) => {
        if (!failed && new URL(request.url).pathname === `/internal/preview/${stage}`) {
          failed = true;
          // Exercise no import receipt, a partially moved locator, and lost
          // activation acknowledgement independently.
          if (stage !== 'import') await fetch(request);
          return new Response(null, { status: 503 });
        }
        return fetch(request);
      });
      expect((await h.transfer()).status).toBe(503);
      spy.mockRestore();
      await expireTarget(h);
      const source = h.namespace.reconstruct(h.source.session.trayId);
      const target = h.namespace.reconstruct(h.target.session.trayId);
      const resume = await source.fetch(
        post('transfer', {
          controllerToken: h.source.controllerToken,
          targetTrayId: h.target.session.trayId,
          targetControllerToken: h.target.controllerToken,
        })
      );
      expect(resume.status).toBe(200);
      expect((await h.target.storage.get<TrayRecord>('tray'))?.expiredAt).toBeDefined();
      const next = await h.newLeader();
      expect(
        (
          await target.fetch(
            post('transfer', {
              controllerToken: h.target.controllerToken,
              targetTrayId: next.session.trayId,
              targetControllerToken: next.controllerToken,
            })
          )
        ).status
      ).toBe(200);
      const resolved = await source.fetch(resolve(h.preview.previewToken));
      expect(resolved.status).toBe(200);
      expect(resolved.headers.get('x-slicc-preview-tray')).toBe(next.session.trayId);
      expect(
        (await next.storage.get<TrayRecord>('tray'))?.previews?.[h.preview.previewToken]
      ).toMatchObject({ servedRoot: '/site', entryPath: '/site/index.html' });
    }
  );

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
      expect(tombstone.pendingUploads).toHaveLength(1);
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
          .pendingUploads
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands an arbitrarily late timed-out write to R2 lifecycle after bounded local cleanup', async () => {
    const h = await harness(true);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const put = h.r2.implementation.put.getMockImplementation()!;
    let materializedAt = 0;
    h.r2.implementation.put.mockImplementation(async (...args) => {
      await paused;
      materializedAt = h.clock.now;
      return put(...args);
    });
    vi.useFakeTimers();
    try {
      const upload = h.upload();
      await vi.waitFor(() => expect(h.r2.implementation.put).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await upload).status).toBe(502);
      h.clock.now += 60_001;
      await h.source.stub.alarm();
      h.clock.now += PREVIEW_CLEANUP_HORIZON_MS;
      await h.namespace.reconstruct(h.source.session.trayId).alarm();
      expect(
        (await h.source.storage.get<TrayRecord>('tray'))!.previews![h.preview.previewToken]
      ).toBeUndefined();
      expect(h.r2.objects.size).toBe(0);
      resume(); // Backend may complete even AFTER the edge and local cleanup owner are gone.
      await vi.waitFor(() => expect(h.r2.objects.size).toBe(1));
      expect((await h.source.stub.fetch(resolve(h.preview.previewToken))).status).toBe(404);
      // Model the independently deployed 90-day R2 age rule, measured from
      // materialization, not lease time. This is explicitly not a DO callback.
      const lifecycle = () => {
        if (h.clock.now >= materializedAt + 90 * 86_400_000) h.r2.objects.clear();
      };
      lifecycle();
      expect(h.r2.objects.size).toBe(1);
      h.clock.now += 90 * 86_400_000;
      lifecycle();
      expect(h.r2.objects.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never overwrites or deletes a retry canonical object when an expired put completes late', async () => {
    const h = await harness(true, 3_600_000);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const put = h.r2.implementation.put.getMockImplementation()!;
    h.r2.implementation.put.mockImplementationOnce(async (...args) => {
      await paused;
      return put(...args);
    });
    const oldUpload = h.upload('old!');
    await vi.waitFor(() => expect(h.r2.implementation.put).toHaveBeenCalledTimes(1));
    h.clock.now += PREVIEW_UPLOAD_LEASE_MS;
    expect((await h.upload()).status).toBe(204);
    const canonical = (await h.source.storage.get<TrayRecord>('tray'))!.previews![
      h.preview.previewToken
    ].uploadedFiles!['index.html'].key;
    resume();
    expect((await oldUpload).status).toBe(409);
    expect([...h.r2.objects.keys()]).toEqual([canonical]);
    expect(new TextDecoder().decode(h.r2.objects.get(canonical))).toBe('data');
    expect((await h.finalize()).status).toBe(200);
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
        .pendingUploads
    ).toHaveLength(8);
  });

  it.each(['upload-authorize', 'upload-commit', 'upload-release'] as const)(
    'bounds a stalled %s response without losing canonical bytes',
    async (action) => {
      const h = await harness(true, 3_600_000);
      const fetch = h.source.stub.fetch.bind(h.source.stub);
      let stalled = false;
      const spy = vi.spyOn(h.source.stub, 'fetch').mockImplementation(async (request) => {
        const response = await fetch(request);
        if (new URL(request.url).pathname.endsWith(`/${action}`)) {
          stalled = true;
          return new Promise<Response>(() => {});
        }
        return response;
      });
      vi.useFakeTimers();
      try {
        const upload = h.upload();
        await vi.waitFor(() => expect(stalled).toBe(true));
        await vi.advanceTimersByTimeAsync(30_001);
        expect((await upload).status).toBe(action === 'upload-release' ? 204 : 503);
        spy.mockRestore();
        expect((await h.upload()).status).toBe(204);
        expect(h.r2.implementation.put).toHaveBeenCalledTimes(1);
        expect((await h.finalize()).status).toBe(200);
        expect(await (await handlePreviewRequest(new Request(h.preview.url), h.env)).text()).toBe(
          'data'
        );
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each(['lost authorization', 'lost release', 'aborted edge'] as const)(
    'recovers eight leaked leases after %s without reviving an old candidate',
    async (failure) => {
      const h = await harness(true, 3_600_000);
      const fetch = h.source.stub.fetch.bind(h.source.stub);
      const keys: string[] = [];
      const spy = vi.spyOn(h.source.stub, 'fetch').mockImplementation(async (request) => {
        const action = new URL(request.url).pathname;
        if (action.endsWith('/upload-release')) throw new Error('release lost');
        const response = await fetch(request);
        if (action.endsWith('/upload-authorize') && response.ok) {
          keys.push(((await response.clone().json()) as { objectKey: string }).objectKey);
          if (failure === 'lost authorization') throw new Error('authorization response lost');
        }
        return response;
      });
      for (let i = 0; i < 8; i++) {
        if (failure === 'aborted edge') {
          // The edge disappears after authorization: no callback can execute.
          expect(
            (
              await h.source.stub.fetch(
                post('upload-authorize', {
                  previewToken: h.preview.previewToken,
                  uploadToken: h.preview.uploadToken,
                  relativePath: 'index.html',
                  size: 4,
                })
              )
            ).status
          ).toBe(200);
        } else {
          const abort = new AbortController();
          abort.abort();
          const response = await handlePreviewUpload(
            new Request(`${base}/upload?path=index.html`, {
              method: 'PUT',
              headers: { authorization: `Bearer ${h.preview.uploadToken}` },
              body: 'data',
              signal: abort.signal,
            }),
            h.source.stub,
            h.r2.bucket,
            h.preview.previewToken
          );
          expect(response.status).toBe(failure === 'lost authorization' ? 503 : 400);
        }
      }
      expect((await h.upload()).status).toBe(429);
      spy.mockRestore();
      h.clock.now += PREVIEW_UPLOAD_LEASE_MS;
      h.namespace.reconstruct(h.source.session.trayId);
      expect((await h.upload()).status).toBe(204);
      const record = (await h.source.storage.get<TrayRecord>('tray'))!.previews![
        h.preview.previewToken
      ];
      expect(record.pendingUploads).toEqual([]);
      expect(record.hasUnsettledUploads).toBe(true);
      // An abandoned candidate cannot acquire a different canonical path after expiry.
      expect(
        (
          await h.source.stub.fetch(
            post('upload-commit', {
              previewToken: h.preview.previewToken,
              uploadToken: h.preview.uploadToken,
              relativePath: 'late.html',
              size: 4,
              objectKey: keys[0],
              mime: 'text/html',
              etag: 'late',
            })
          )
        ).status
      ).toBe(409);
      expect((await h.finalize()).status).toBe(200);
      expect(await (await handlePreviewRequest(new Request(h.preview.url), h.env)).text()).toBe(
        'data'
      );
    }
  );

  it.each(['expiry', 'revoke'] as const)(
    'bounds %s cleanup metadata independently of the live preview limit, even with failed sweeps',
    async (end) => {
      const h = await harness(true);
      await h.source.stub.fetch(
        post('upload-authorize', {
          previewToken: h.preview.previewToken,
          uploadToken: h.preview.uploadToken,
          relativePath: 'index.html',
          size: 4,
        })
      );
      h.r2.implementation.list.mockRejectedValue(new Error('R2 unavailable'));
      if (end === 'expiry') {
        h.clock.now += 60_001;
        await h.source.stub.alarm();
      } else {
        await h.source.stub.fetch(
          post('stop', {
            controllerToken: h.source.controllerToken,
            previewToken: h.preview.previewToken,
          })
        );
      }
      const tombstone = (await h.source.storage.get<TrayRecord>('tray'))!.previews![
        h.preview.previewToken
      ];
      expect(tombstone.state).toBe('cleanup');
      for (let i = 0; i < 10; i++) {
        expect(
          (
            await h.source.stub.fetch(
              post('mint', {
                controllerToken: h.source.controllerToken,
                servedRoot: '/site',
                entryPath: '/site/index.html',
                allowLive: true,
                workerBaseUrl: base,
              })
            )
          ).status
        ).toBe(200);
      }
      h.clock.now += PREVIEW_CLEANUP_HORIZON_MS;
      await h.namespace.reconstruct(h.source.session.trayId).alarm();
      expect(
        (await h.source.storage.get<TrayRecord>('tray'))!.previews![h.preview.previewToken]
      ).toBeUndefined();
      expect(h.source.storage.deleteAlarm).toHaveBeenCalled();
    }
  );

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
