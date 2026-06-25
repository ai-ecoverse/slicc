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
