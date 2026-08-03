import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deletePreviewArchivePrefix,
  MAX_PREVIEW_FILE_BYTES,
  normalizePreviewArchivePath,
  servePersistentPreview,
} from '../src/persistent-preview-storage.js';
import { handlePreviewFinalize, handlePreviewUpload } from '../src/preview-routes.js';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import {
  authorizePreviewUpload,
  commitPreviewUpload,
  dispatchPreviewRoute,
  expirePersistentPreviews,
  finalizePersistentPreview,
  mintPreview,
  type PreviewDeps,
  resolvePreview,
  revokePreview,
} from '../src/session-tray-preview.js';
import type { PreviewRecord, TrayRecord } from '../src/shared.js';
import { FakeDurableObjectState } from './fake-do-state.js';

function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const bucket = {
    put: vi.fn(async (key: string, value: ArrayBuffer, options?: R2PutOptions) => {
      const metadata = options?.httpMetadata;
      const contentType =
        metadata instanceof Headers
          ? (metadata.get('content-type') ?? 'application/octet-stream')
          : (metadata?.contentType ?? 'application/octet-stream');
      objects.set(key, {
        bytes: new Uint8Array(value),
        contentType,
      });
      return { key, etag: `etag-${key}`, httpEtag: `"etag-${key}"` };
    }),
    get: vi.fn(async (key: string) => {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        body: stored.bytes,
        size: stored.bytes.byteLength,
        etag: `etag-${key}`,
        httpEtag: `"etag-${key}"`,
        writeHttpMetadata: (headers: Headers) => headers.set('content-type', stored.contentType),
      };
    }),
    list: vi.fn(async ({ prefix }: R2ListOptions) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(prefix ?? ''))
        .map((key) => ({ key })),
      truncated: false,
    })),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    }),
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

function previewDeps() {
  let now = Date.parse('2026-08-03T00:00:00.000Z');
  const tray = {
    trayId: 'tray',
    controllerToken: 'controller',
    previews: {},
  } as unknown as TrayRecord;
  const deleted: string[] = [];
  const alarms: Array<number | null> = [];
  const deps: PreviewDeps = {
    loadTray: async () => {},
    getTray: () => tray,
    persistTray: async () => {},
    isoNow: () => new Date(now).toISOString(),
    hasLiveLeader: () => false,
    sendToLeader: () => false,
    matchesToken: (received, expected) => received === expected,
    pendingPreviews: new Map(),
    now: () => now,
    archiveAvailable: () => true,
    deleteArchivePrefix: async (prefix) => {
      deleted.push(prefix);
    },
    scheduleExpiry: async (timestamp) => {
      alarms.push(timestamp);
    },
  };
  return { deps, tray, deleted, alarms, advance: (ms: number) => (now += ms) };
}

describe('persistent preview publication', () => {
  it('normalizes archive paths and rejects traversal', () => {
    expect(normalizePreviewArchivePath('assets\\app.js')).toBe('assets/app.js');
    expect(normalizePreviewArchivePath('../secret')).toBeNull();
    expect(normalizePreviewArchivePath('/absolute')).toBeNull();
    expect(normalizePreviewArchivePath('a//b')).toBeNull();
  });

  it('keeps pending previews hidden, then finalizes with upload metadata', async () => {
    const { deps, tray, alarms, advance } = previewDeps();
    const minted = await mintPreview(
      {
        controllerToken: 'controller',
        servedRoot: '/workspace/site',
        entryPath: '/workspace/site/index.html',
        allowLive: true,
        workerBaseUrl: 'https://www.sliccy.ai',
        ttlMs: 86_400_000,
      },
      deps
    );
    expect(minted.uploadToken).toBeTruthy();
    expect(await resolvePreview(minted.previewToken, deps)).toBeNull();
    const upload = {
      previewToken: minted.previewToken,
      uploadToken: minted.uploadToken!,
      relativePath: 'index.html',
      size: 5,
    };
    const first = await authorizePreviewUpload(upload, deps);
    const second = await authorizePreviewUpload(upload, deps);
    expect(second.objectKey).not.toBe(first.objectKey);
    const objectKey = first.objectKey;
    await commitPreviewUpload({ ...upload, objectKey, mime: 'text/html', etag: 'etag-1' }, deps);
    await expect(
      commitPreviewUpload(
        { ...upload, objectKey: second.objectKey, mime: 'text/html', etag: 'etag-2' },
        deps
      )
    ).rejects.toThrow('duplicate preview file path');
    advance(30_000);
    await finalizePersistentPreview(upload, deps);
    expect(await resolvePreview(minted.previewToken, deps)).toMatchObject({
      mode: 'persistent',
      state: 'ready',
      allowLive: false,
      bridge: false,
      uploadedFiles: {
        'index.html': { key: objectKey, size: 5, mime: 'text/html', etag: 'etag-1' },
      },
    });
    expect(tray.previews?.[minted.previewToken]?.uploadToken).toBeUndefined();
    expect(alarms.at(-1)).toBe(Date.parse('2026-08-04T00:00:30.000Z'));
  });

  it('expires records and deletes their isolated R2 prefix', async () => {
    const { deps, tray, deleted, advance } = previewDeps();
    const minted = await mintPreview(
      {
        controllerToken: 'controller',
        servedRoot: '/site',
        entryPath: '/site/index.html',
        allowLive: false,
        workerBaseUrl: 'https://www.sliccy.ai',
        ttlMs: 60_000,
      },
      deps
    );
    const prefix = tray.previews?.[minted.previewToken]?.archivePrefix;
    advance(60_000);
    await expirePersistentPreviews(deps);
    expect(deleted).toEqual([prefix]);
    expect(tray.previews?.[minted.previewToken]).toBeUndefined();
  });

  it('retains an expired cleanup tombstone and retries failed R2 deletion', async () => {
    const { deps, tray, alarms, advance } = previewDeps();
    const deletePrefix = vi
      .fn()
      .mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockResolvedValueOnce(undefined);
    deps.deleteArchivePrefix = deletePrefix;
    const minted = await mintPreview(
      {
        controllerToken: 'controller',
        servedRoot: '/site',
        entryPath: '/site/index.html',
        allowLive: false,
        workerBaseUrl: 'https://www.sliccy.ai',
        ttlMs: 60_000,
      },
      deps
    );

    advance(60_000);
    await expirePersistentPreviews(deps);
    expect(tray.previews?.[minted.previewToken]).toMatchObject({ state: 'cleanup' });
    expect(await resolvePreview(minted.previewToken, deps)).toBeNull();
    expect(alarms.at(-1)).toBe(Date.parse('2026-08-03T00:02:00.000Z'));

    advance(60_000);
    await expirePersistentPreviews(deps);
    expect(deletePrefix).toHaveBeenCalledTimes(2);
    expect(tray.previews?.[minted.previewToken]).toBeUndefined();
  });

  it('hides a revoked preview while retrying failed R2 deletion', async () => {
    const { deps, tray, alarms, advance } = previewDeps();
    const deletePrefix = vi
      .fn()
      .mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockResolvedValueOnce(undefined);
    deps.deleteArchivePrefix = deletePrefix;
    const minted = await mintPreview(
      {
        controllerToken: 'controller',
        servedRoot: '/site',
        entryPath: '/site/index.html',
        allowLive: false,
        workerBaseUrl: 'https://www.sliccy.ai',
        ttlMs: 60_000,
      },
      deps
    );

    await expect(revokePreview(minted.previewToken, deps)).resolves.toEqual({ revoked: true });
    expect(tray.previews?.[minted.previewToken]).toMatchObject({ state: 'cleanup' });
    expect(await resolvePreview(minted.previewToken, deps)).toBeNull();
    expect(alarms.at(-1)).toBe(Date.parse('2026-08-03T00:01:00.000Z'));

    advance(60_000);
    await expirePersistentPreviews(deps);
    expect(deletePrefix).toHaveBeenCalledTimes(2);
    expect(tray.previews?.[minted.previewToken]).toBeUndefined();
  });

  it('wires R2 cleanup and alarm scheduling through SessionTray dependencies', async () => {
    const { bucket, objects } = memoryBucket();
    objects.set('previews/one/file', {
      bytes: new Uint8Array([1]),
      contentType: 'text/plain',
    });
    const durableObject = new SessionTrayDurableObject(new FakeDurableObjectState(), {
      PREVIEW_STORAGE: bucket,
    });
    const deps = (
      durableObject as unknown as {
        previewDeps(): PreviewDeps;
      }
    ).previewDeps();
    expect(deps.archiveAvailable()).toBe(true);
    expect(deps.now()).toBeTypeOf('number');
    await deps.deleteArchivePrefix('previews/one/');
    await deps.scheduleExpiry(Date.now() + 1_000);
    await deps.scheduleExpiry(null);
    expect(objects.size).toBe(0);
  });

  it('dispatches authorize, commit, and finalize internal routes', async () => {
    const { deps } = previewDeps();
    const minted = await mintPreview(
      {
        controllerToken: 'controller',
        servedRoot: '/site',
        entryPath: '/index.html',
        allowLive: false,
        workerBaseUrl: 'https://www.sliccy.ai',
        ttlMs: 60_000,
      },
      deps
    );
    const base = {
      previewToken: minted.previewToken,
      uploadToken: minted.uploadToken!,
      relativePath: 'index.html',
      size: 1,
    };
    const authorizeRequest = new Request('https://internal/internal/preview/upload-authorize', {
      method: 'POST',
      body: JSON.stringify(base),
    });
    const authorize = await dispatchPreviewRoute(
      new URL(authorizeRequest.url),
      authorizeRequest,
      deps
    );
    const { objectKey } = (await authorize?.json()) as { objectKey: string };
    expect(authorize?.status).toBe(200);
    const commitRequest = new Request('https://internal/internal/preview/upload-commit', {
      method: 'POST',
      body: JSON.stringify({ ...base, objectKey, mime: 'text/html', etag: 'etag' }),
    });
    expect(
      await dispatchPreviewRoute(new URL(commitRequest.url), commitRequest, deps)
    ).toMatchObject({ status: 200 });
    const finalizeRequest = new Request('https://internal/internal/preview/finalize', {
      method: 'POST',
      body: JSON.stringify(base),
    });
    expect(
      await dispatchPreviewRoute(new URL(finalizeRequest.url), finalizeRequest, deps)
    ).toMatchObject({ status: 200 });
    const rejectedRequest = new Request('https://internal/internal/preview/upload-authorize', {
      method: 'POST',
      body: JSON.stringify(base),
    });
    const rejected = await dispatchPreviewRoute(
      new URL(rejectedRequest.url),
      rejectedRequest,
      deps
    );
    expect(rejected?.status).toBe(404);
  });
});

describe('persistent preview R2 serving', () => {
  afterEach(() => vi.useRealTimers());

  it('serves immutable bytes with metadata and supports ETags', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'));
    const record = {
      servedRoot: '/site',
      entryPath: '/site/index.html',
      archivePrefix: 'previews/tray/snapshot/',
      expiresAt: '2026-08-04T00:00:00.000Z',
      uploadedFiles: {
        'index.html': {
          key: 'previews/tray/snapshot/objects/file-1',
          size: 5,
          mime: 'text/html',
          etag: 'etag-1',
        },
      },
    } as unknown as PreviewRecord;
    const object = {
      body: new TextEncoder().encode('hello'),
      size: 5,
      etag: 'etag-1',
      httpEtag: '"etag-1"',
      writeHttpMetadata: (headers: Headers) => headers.set('content-type', 'text/html'),
    };
    const bucket = { get: vi.fn(async () => object) } as unknown as R2Bucket;
    const url = new URL('https://preview.sliccy.now/index.html');
    const response = await servePersistentPreview(new Request(url), url, record, bucket);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('content-type')).toBe('text/html');

    const cached = await servePersistentPreview(
      new Request(url, { headers: { 'if-none-match': '"etag-1"' } }),
      url,
      record,
      bucket
    );
    expect(cached.status).toBe(304);
  });

  it('deletes every object below an archive prefix', async () => {
    const { bucket, objects } = memoryBucket();
    await bucket.put('previews/one/a', new Uint8Array([1]));
    await bucket.put('previews/one/b', new Uint8Array([2]));
    await bucket.put('previews/two/c', new Uint8Array([3]));
    await deletePreviewArchivePrefix(bucket, 'previews/one/');
    expect([...objects.keys()]).toEqual(['previews/two/c']);
  });

  it('uploads unique R2 objects and forwards finalization to the tray', async () => {
    const { bucket, objects } = memoryBucket();
    const fetch = vi.fn(async (request: Request) => {
      if (request.url.endsWith('/upload-authorize')) {
        return Response.json({ objectKey: 'previews/tray/snapshot/objects/one' });
      }
      return Response.json({ previewToken: 'preview', url: 'https://preview.sliccy.now/' });
    });
    const stub = { fetch };
    const upload = await handlePreviewUpload(
      new Request('https://www.sliccy.ai/file?path=index.html', {
        method: 'PUT',
        headers: { authorization: 'Bearer upload', 'content-type': 'text/html' },
        body: 'hello',
      }),
      stub,
      bucket,
      'preview'
    );
    expect(upload.status).toBe(204);
    expect(objects.has('previews/tray/snapshot/objects/one')).toBe(true);
    const committed = JSON.parse((await fetch.mock.calls[1]![0].text()) as string) as {
      objectKey: string;
      mime: string;
      etag: string;
    };
    expect(committed).toMatchObject({
      objectKey: 'previews/tray/snapshot/objects/one',
      mime: 'text/html',
    });
    const finalized = await handlePreviewFinalize(
      new Request('https://www.sliccy.ai/finalize', {
        method: 'POST',
        headers: { authorization: 'Bearer upload' },
      }),
      stub,
      'preview'
    );
    expect(finalized.status).toBe(200);
  });

  it('rejects an invalid upload capability before consuming its body', async () => {
    const { bucket } = memoryBucket();
    const request = new Request('https://www.sliccy.ai/file?path=index.html', {
      method: 'PUT',
      headers: { authorization: 'Bearer invalid' },
      body: 'untrusted bytes',
    });
    const stub = {
      fetch: vi.fn(async () => Response.json({ error: 'invalid capability' }, { status: 403 })),
    };

    const response = await handlePreviewUpload(request, stub, bucket, 'preview');

    expect(response.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('rejects declared oversized uploads before authorization or buffering', async () => {
    const { bucket } = memoryBucket();
    const request = new Request('https://www.sliccy.ai/file?path=index.html', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer upload',
        'content-length': String(MAX_PREVIEW_FILE_BYTES + 1),
      },
      body: 'small body',
    });
    const stub = { fetch: vi.fn() };

    const response = await handlePreviewUpload(request, stub, bucket, 'preview');

    expect(response.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect(stub.fetch).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('stops streaming an authorized upload after the file-size limit', async () => {
    const { bucket } = memoryBucket();
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted++ <= 25) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const request = new Request('https://www.sliccy.ai/file?path=index.html', {
      method: 'PUT',
      headers: { authorization: 'Bearer upload' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const stub = {
      fetch: vi.fn(async () =>
        Response.json({ objectKey: 'previews/tray/snapshot/objects/oversized' })
      ),
    };

    const response = await handlePreviewUpload(request, stub, bucket, 'preview');

    expect(response.status).toBe(413);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    expect(bucket.put).not.toHaveBeenCalled();
  });
});
