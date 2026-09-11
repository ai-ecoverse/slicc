import { describe, expect, it, vi } from 'vitest';
import { handlePreviewRequest } from '../src/preview-handler.js';
import previewWorker from '../src/preview-worker.js';
import type { PreviewRecord, TrayRecord } from '../src/shared.js';
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

async function harness() {
  const { env, namespace } = createTestEnv();
  const source = await setupConnectedLeader(env, namespace, base);
  const target = await setupConnectedLeader(env, namespace, base);
  const minted = await source.stub.fetch(
    post('mint', {
      controllerToken: source.controllerToken,
      servedRoot: '/workspace/site',
      entryPath: '/workspace/site/nested/start.html',
      allowLive: true,
      workerBaseUrl: base,
      bridge: true,
      maxTabs: 1,
      webhookId: 'original-hook',
    })
  );
  expect(minted.status).toBe(200);
  const preview = (await minted.json()) as { previewToken: string; url: string };
  const transfer = (from = source, to = target) =>
    from.stub.fetch(
      post('transfer', {
        controllerToken: from.controllerToken,
        targetTrayId: to.session.trayId,
        targetControllerToken: to.controllerToken,
      })
    );
  return { env, namespace, source, target, preview, transfer };
}

async function answer(leader: Leader, pending: Promise<Response>, content: string) {
  await vi.waitFor(() =>
    expect(leader.leaderSent.some((m) => m.type === 'preview.request')).toBe(true)
  );
  const request = leader.leaderSent.find((m) => m.type === 'preview.request')!;
  await leader.stub.webSocketMessage(
    leader.state.getWebSockets('leader')[0],
    JSON.stringify({
      type: 'preview.response',
      reqId: request.reqId,
      ok: true,
      mime: 'text/html',
      encoding: 'utf-8',
      content,
    })
  );
  return { response: await pending, request };
}

describe('preview continuity across tray roves', () => {
  it('keeps the old host, entry and jail on both worker entry points after source expiry/hibernation', async () => {
    for (const dedicated of [false, true]) {
      const h = await harness();
      const before = await (await h.source.stub.fetch(resolve(h.preview.previewToken))).json();
      expect((await h.transfer()).status).toBe(200);
      const sourceRecord = await h.source.state.storage.get<TrayRecord>('tray');
      sourceRecord!.expiredAt = new Date().toISOString();
      h.namespace.reconstruct(h.source.session.trayId);
      const root = new URL(h.preview.url);
      root.pathname = '/';
      const pending = dedicated
        ? previewWorker.fetch(new Request(root), h.env as Parameters<typeof previewWorker.fetch>[1])
        : handlePreviewRequest(new Request(root), h.env);
      const { response, request } = await answer(h.target, pending, '<html>after rove</html>');
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('after rove');
      expect(request).toMatchObject({
        servedRoot: '/workspace/site',
        vfsPath: '/workspace/site/nested/start.html',
      });
      const resolved = await h.namespace
        .get(h.namespace.idFromName(h.source.session.trayId))
        .fetch(resolve(h.preview.previewToken));
      expect(await resolved.json()).toEqual(before);
      expect(resolved.headers.get('x-slicc-preview-tray')).toBe(h.target.session.trayId);
      expect(response.headers.get('location')).toBeNull();
      expect(h.source.leaderSent.some((m) => m.type === 'preview.request')).toBe(false);
    }
  });

  it('retargets the ORIGINAL locator on repeated roves; revokes never resurrect on retry', async () => {
    const h = await harness();
    expect((await h.transfer()).status).toBe(200);
    let current = h.target;
    for (let i = 0; i < 5; i++) {
      const next = await setupConnectedLeader(h.env, h.namespace, base);
      expect((await h.transfer(current, next)).status).toBe(200);
      current = next;
      const resolved = await h.source.stub.fetch(resolve(h.preview.previewToken));
      expect(resolved.status).toBe(200);
      expect(resolved.headers.get('x-slicc-preview-tray')).toBe(current.session.trayId);
    }
    const stop = await current.stub.fetch(
      post('stop', {
        controllerToken: current.controllerToken,
        previewToken: h.preview.previewToken,
      })
    );
    expect(stop.status).toBe(200);
    expect((await h.transfer()).status).toBe(200);
    expect((await h.source.stub.fetch(resolve(h.preview.previewToken))).status).toBe(404);
    expect((await current.stub.listPreviews()).length).toBe(0);
  });

  it('requires both controller capabilities and rejects unknown or self destinations without freezing', async () => {
    const h = await harness();
    for (const overrides of [
      { controllerToken: 'wrong' },
      { targetControllerToken: 'wrong' },
      { targetTrayId: h.source.session.trayId },
      { targetTrayId: 'missing' },
    ]) {
      const response = await h.source.stub.fetch(
        post('transfer', {
          controllerToken: h.source.controllerToken,
          targetTrayId: h.target.session.trayId,
          targetControllerToken: h.target.controllerToken,
          ...overrides,
        })
      );
      expect(response.ok).toBe(false);
      expect((await h.source.stub.fetch(resolve(h.preview.previewToken))).status).toBe(200);
    }
  });

  it('preserves bridge opt-in, maxTabs, emit webhook scope and closes old sockets for reconnect', async () => {
    const h = await harness();
    const url = new URL('/__slicc/bridge', h.preview.url);
    const open = () =>
      handlePreviewRequest(new Request(url, { headers: { upgrade: 'websocket' } }), h.env);
    expect((await open()).status).toBe(101);
    expect(h.source.state.getWebSockets('bridge')).toHaveLength(1);
    expect((await h.transfer()).status).toBe(200);
    expect(h.source.state.getWebSockets('bridge')).toHaveLength(0);
    expect((await open()).status).toBe(101);
    expect((await open()).status).toBe(429);
    expect(h.target.state.getWebSockets('bridge')).toHaveLength(1);
    const emit = await handlePreviewRequest(
      new Request(new URL('/__slicc/emit', url), {
        method: 'POST',
        body: JSON.stringify({ name: 'clicked', detail: 1 }),
      }),
      h.env
    );
    expect(emit.status).toBe(200);
    expect(h.target.leaderSent).toContainEqual(
      expect.objectContaining({
        type: 'webhook.event',
        webhookId: 'original-hook',
        body: { name: 'clicked', detail: 1 },
      })
    );
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
    expect(h.target.state.getWebSockets('bridge')).toHaveLength(0);
    expect((await open()).status).toBe(404);
  });

  it('lists and stops only the old source capabilities, never newly minted target previews', async () => {
    const h = await harness();
    expect((await h.transfer()).status).toBe(200);
    await h.target.stub.mintPreview({
      controllerToken: h.target.controllerToken,
      servedRoot: '/private',
      entryPath: '/private/index.html',
      workerBaseUrl: base,
      allowLive: false,
    });
    const list = await h.source.stub.fetch(
      new Request('https://internal/internal/preview/list', {
        headers: { 'x-controller-token': h.source.controllerToken },
      })
    );
    expect(
      ((await list.json()) as { previews: PreviewRecord[] }).previews.map((p) => p.previewToken)
    ).toEqual([h.preview.previewToken]);
    const unknown = (await h.target.stub.listPreviews()).find(
      (p) => p.previewToken !== h.preview.previewToken
    )!;
    expect(
      await (
        await h.source.stub.fetch(
          post('stop', {
            controllerToken: h.source.controllerToken,
            previewToken: unknown.previewToken,
          })
        )
      ).json()
    ).toMatchObject({ revoked: false });
    expect(await h.target.stub.listPreviews()).toHaveLength(2);
  });

  it('retries a lost import response after hibernation without copying a revoked preview back', async () => {
    const h = await harness();
    const fetch = h.target.stub.fetch.bind(h.target.stub);
    const spy = vi.spyOn(h.target.stub, 'fetch').mockImplementation(async (request) => {
      const response = await fetch(request);
      if (new URL(request.url).pathname.endsWith('/import')) throw new Error('lost response');
      return response;
    });
    expect((await h.transfer()).status).toBe(503);
    spy.mockRestore();
    expect((await h.source.stub.fetch(resolve(h.preview.previewToken))).status).toBe(503);
    await h.target.stub.revokePreview(h.preview.previewToken);
    const freshSource = h.namespace.reconstruct(h.source.session.trayId);
    const retry = await freshSource.fetch(
      post('transfer', {
        controllerToken: h.source.controllerToken,
        targetTrayId: h.target.session.trayId,
        targetControllerToken: h.target.controllerToken,
      })
    );
    expect(retry.status).toBe(200);
    expect((await freshSource.fetch(resolve(h.preview.previewToken))).status).toBe(404);
  });

  it('moves persistent R2 metadata unchanged and removes source cleanup ownership', async () => {
    const h = await harness();
    const tray = (await h.source.state.storage.get<TrayRecord>('tray'))!;
    const record = tray.previews![h.preview.previewToken];
    Object.assign(record, {
      mode: 'persistent',
      bridge: false,
      allowLive: false,
      archivePrefix: 'previews/original/archive/',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      retentionMs: 86_400_000,
      uploadedFiles: {
        'nested/start.html': {
          key: 'previews/original/archive/start',
          size: 4,
          mime: 'text/html',
          etag: 'original',
        },
      },
    });
    const snapshot = structuredClone(record);
    expect((await h.transfer()).status).toBe(200);
    expect(await h.target.stub.resolvePreview(h.preview.previewToken)).toEqual(snapshot);
    await h.source.stub.alarm();
    expect(tray.previews).toEqual({});
    expect(await h.target.stub.resolvePreview(h.preview.previewToken)).toEqual(snapshot);
  });

  it('bounds a silent destination and leaves the original usable when confirmation times out', async () => {
    const h = await harness();
    const originalFetch = h.target.stub.fetch.bind(h.target.stub);
    const spy = vi
      .spyOn(h.target.stub, 'fetch')
      .mockImplementation((request) =>
        new URL(request.url).pathname.endsWith('/confirm-controller')
          ? new Promise<Response>(() => {})
          : originalFetch(request)
      );
    vi.useFakeTimers();
    try {
      const pending = h.transfer();
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await pending).status).toBe(503);
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
    expect((await h.source.stub.fetch(resolve(h.preview.previewToken))).status).toBe(200);
    expect((await h.transfer()).status).toBe(200);
  });

  it('fails closed on an interrupted locator update and resumes the same transfer', async () => {
    const h = await harness();
    const originalFetch = h.source.stub.fetch.bind(h.source.stub);
    const spy = vi
      .spyOn(h.source.stub, 'fetch')
      .mockImplementation((request) =>
        new URL(request.url).pathname.endsWith('/relocate')
          ? Promise.resolve(new Response('unavailable', { status: 503 }))
          : originalFetch(request)
      );
    expect((await h.transfer()).status).toBe(503);
    spy.mockRestore();
    expect((await handlePreviewRequest(new Request(h.preview.url), h.env)).status).toBe(503);
    expect((await h.transfer()).status).toBe(200);
    expect((await h.source.stub.fetch(resolve(h.preview.previewToken))).status).toBe(200);
  });

  it('does not migrate previously revoked previews or grant bridge access to read-only ones', async () => {
    const h = await harness();
    await h.source.stub.revokePreview(h.preview.previewToken);
    const readOnly = await h.source.stub.mintPreview({
      controllerToken: h.source.controllerToken,
      servedRoot: '/workspace/readonly',
      entryPath: '/workspace/readonly/index.html',
      workerBaseUrl: base,
      allowLive: false,
    });
    expect((await h.transfer()).status).toBe(200);
    expect((await h.source.stub.fetch(resolve(h.preview.previewToken))).status).toBe(404);
    expect(await h.target.stub.resolvePreview(h.preview.previewToken)).toBeNull();
    const unauthorizedBridge = await h.target.stub.fetch(
      new Request(new URL('/__slicc/bridge', readOnly.url), { headers: { upgrade: 'websocket' } })
    );
    expect(unauthorizedBridge.status).toBe(403);
    expect(h.target.state.getWebSockets('bridge')).toHaveLength(0);
  });

  it('keeps expired archives revoked during failed cleanup and transfer retries', async () => {
    const h = await harness();
    const tray = (await h.source.state.storage.get<TrayRecord>('tray'))!;
    const record = tray.previews![h.preview.previewToken];
    Object.assign(record, {
      mode: 'persistent',
      bridge: false,
      allowLive: false,
      archivePrefix: 'previews/original/archive/',
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    // The harness intentionally has no R2 bucket. Cleanup must retain its
    // tombstone for retry, not return an expired snapshot or resurrect it.
    expect((await h.transfer()).status).toBe(200);
    const target = (await h.target.state.storage.get<TrayRecord>('tray'))!;
    expect(target.previews![h.preview.previewToken].state).toBe('cleanup');
    expect((await h.source.stub.fetch(resolve(h.preview.previewToken))).status).toBe(404);
    expect((await h.transfer()).status).toBe(200);
    expect((await h.source.stub.fetch(resolve(h.preview.previewToken))).status).toBe(404);
    expect(tray.previews).toEqual({});
  });

  it('keeps retention cleanup running during an interrupted transfer without losing its locator', async () => {
    const h = await harness();
    const tray = (await h.source.state.storage.get<TrayRecord>('tray'))!;
    const record = tray.previews![h.preview.previewToken];
    Object.assign(record, {
      mode: 'persistent',
      bridge: false,
      allowLive: false,
      archivePrefix: 'previews/original/archive/',
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    const originalFetch = h.target.stub.fetch.bind(h.target.stub);
    const spy = vi
      .spyOn(h.target.stub, 'fetch')
      .mockImplementation((request) =>
        new URL(request.url).pathname.endsWith('/import')
          ? Promise.resolve(new Response('unavailable', { status: 503 }))
          : originalFetch(request)
      );
    expect((await h.transfer()).status).toBe(503);
    spy.mockRestore();
    await h.source.stub.alarm();
    expect(record.state).toBe('cleanup');
    expect(tray.previews![h.preview.previewToken]).toBeDefined();
    expect((await h.transfer()).status).toBe(200);
    expect((await h.source.stub.fetch(resolve(h.preview.previewToken))).status).toBe(404);
  });

  it('resumes pending snapshot finalization through the original token after handoff', async () => {
    const h = await harness();
    const tray = (await h.source.state.storage.get<TrayRecord>('tray'))!;
    Object.assign(tray.previews![h.preview.previewToken], {
      mode: 'persistent',
      state: 'pending',
      bridge: false,
      allowLive: false,
      uploadToken: 'original-upload-capability',
      archivePrefix: 'previews/original/archive/',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      retentionMs: 60_000,
      uploadedFiles: {
        'nested/start.html': {
          key: 'previews/original/archive/start',
          size: 4,
          mime: 'text/html',
          etag: 'same',
        },
      },
    });
    expect((await h.transfer()).status).toBe(200);
    expect(
      (
        await h.source.stub.fetch(
          post('finalize', {
            previewToken: h.preview.previewToken,
            uploadToken: 'wrong',
          })
        )
      ).status
    ).toBe(403);
    expect(
      (
        await h.source.stub.fetch(
          post('finalize', {
            previewToken: h.preview.previewToken,
            uploadToken: 'original-upload-capability',
          })
        )
      ).status
    ).toBe(200);
    const resolved = await h.source.stub.fetch(resolve(h.preview.previewToken));
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      state: 'ready',
      archivePrefix: 'previews/original/archive/',
      retentionMs: 60_000,
    });
  });
});
