import { describe, expect, it, vi } from 'vitest';
import {
  listPreviewsViaWorker,
  mintPreviewViaWorker,
  revokePreviewViaWorker,
} from '../../../src/shell/supplemental-commands/preview-mint-client.js';

describe('mintPreviewViaWorker', () => {
  it('POSTs to /api/tray/:trayId/preview with controllerToken auth + body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ previewToken: 'abc.def', url: 'https://abc--def.sliccy.now/' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    const result = await mintPreviewViaWorker(
      {
        workerBaseUrl: 'https://www.sliccy.ai',
        trayId: 'tray1',
        controllerToken: 'tray1.secret',
        servedRoot: '/workspace/dist',
        entryPath: '/workspace/dist/index.html',
        allowLive: false,
        quiet: true,
      },
      fetchMock
    );
    expect(result).toEqual({ previewToken: 'abc.def', url: 'https://abc--def.sliccy.now/' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.sliccy.ai/api/tray/tray1/preview',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tray1.secret',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          servedRoot: '/workspace/dist',
          entryPath: '/workspace/dist/index.html',
          allowLive: false,
          quiet: true,
        }),
      })
    );
  });

  it('throws on non-200 with the status code in the message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(
      mintPreviewViaWorker(
        {
          workerBaseUrl: 'x',
          trayId: 'y',
          controllerToken: 'z',
          servedRoot: '/a',
          entryPath: '/a/i.html',
          allowLive: false,
        },
        fetchMock
      )
    ).rejects.toThrow(/403/);
  });

  it('uploads snapshot bytes and finalizes a persistent preview', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            previewToken: 'preview-token',
            uploadToken: 'upload-token',
            url: 'https://preview.sliccy.now/index.html',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            previewToken: 'preview-token',
            url: 'https://preview.sliccy.now/index.html',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const result = await mintPreviewViaWorker(
      {
        workerBaseUrl: 'https://www.sliccy.ai',
        trayId: 'tray1',
        controllerToken: 'controller-token',
        servedRoot: '/workspace/app',
        entryPath: '/workspace/app/index.html',
        allowLive: false,
        ttlMs: 86_400_000,
        snapshotFiles: [
          { path: 'index.html', content: new TextEncoder().encode('hello'), mime: 'text/html' },
        ],
      },
      fetchMock
    );

    expect(result.previewToken).toBe('preview-token');
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://www.sliccy.ai/api/tray/tray1/preview/preview-token/file?path=index.html',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer upload-token',
          'Content-Type': 'text/html',
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://www.sliccy.ai/api/tray/tray1/preview/preview-token/finalize',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('revokes a pending preview after an upload failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            previewToken: 'preview-token',
            uploadToken: 'upload-token',
            url: 'https://preview.sliccy.now/',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'R2 unavailable' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revoked: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    await expect(
      mintPreviewViaWorker(
        {
          workerBaseUrl: 'https://www.sliccy.ai',
          trayId: 'tray1',
          controllerToken: 'controller-token',
          servedRoot: '/workspace/app',
          entryPath: '/workspace/app/index.html',
          allowLive: false,
          ttlMs: 60_000,
          snapshotFiles: [{ path: 'index.html', content: new Uint8Array([1]), mime: 'text/html' }],
        },
        fetchMock
      )
    ).rejects.toThrow('Preview upload failed for index.html: R2 unavailable');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://www.sliccy.ai/api/tray/tray1/preview/stop',
      expect.objectContaining({ body: JSON.stringify({ previewToken: 'preview-token' }) })
    );
  });
});

describe('revokePreviewViaWorker', () => {
  it('POSTs to /preview/stop with previewToken body and returns { revoked }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ revoked: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const result = await revokePreviewViaWorker(
      {
        workerBaseUrl: 'https://www.sliccy.ai',
        trayId: 'tray1',
        controllerToken: 'tray1.secret',
        previewToken: 'abc.def',
      },
      fetchMock
    );
    expect(result).toEqual({ revoked: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.sliccy.ai/api/tray/tray1/preview/stop',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ previewToken: 'abc.def' }),
      })
    );
  });

  it('throws on non-200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    await expect(
      revokePreviewViaWorker(
        { workerBaseUrl: 'x', trayId: 'y', controllerToken: 'z', previewToken: 't' },
        fetchMock
      )
    ).rejects.toThrow(/404/);
  });
});

describe('listPreviewsViaWorker', () => {
  it('GETs /api/tray/:trayId/previews with controllerToken auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          previews: [
            {
              previewToken: 'a.b',
              url: 'https://a--b.sliccy.now/',
              servedRoot: '/w',
              entryPath: '/w/i.html',
              allowLive: false,
              createdAt: '2026-06-05T00:00:00.000Z',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const result = await listPreviewsViaWorker(
      {
        workerBaseUrl: 'https://www.sliccy.ai',
        trayId: 'tray1',
        controllerToken: 'tray1.secret',
      },
      fetchMock
    );
    expect(result.previews).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.sliccy.ai/api/tray/tray1/previews',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer tray1.secret' },
      })
    );
  });

  it('throws on non-200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(
      listPreviewsViaWorker({ workerBaseUrl: 'x', trayId: 'y', controllerToken: 'z' }, fetchMock)
    ).rejects.toThrow(/500/);
  });
});
