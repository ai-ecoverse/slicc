import { describe, expect, it, vi } from 'vitest';
import { handlePreviewRequest } from '../../src/scoops/preview-request-handler.js';

interface FakeFsState {
  [path: string]: string | Uint8Array;
}

function fakeVfs(files: FakeFsState) {
  return {
    async readFile(path: string, opts?: { encoding?: 'utf-8' | 'binary' }) {
      const content = files[path];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      const encoding = opts?.encoding ?? 'utf-8';
      return encoding === 'utf-8' ? String(content) : (content as Uint8Array);
    },
    async readFileRange(): Promise<Uint8Array> {
      throw new Error('unexpected ranged read');
    },
    async stat(path: string) {
      if (files[path] !== undefined) return { type: 'file' as const };
      const hasChildren = Object.keys(files).some((k) => k.startsWith(path + '/'));
      if (hasChildren) return { type: 'directory' as const };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
}

function recorder() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    ws: { send: (m: unknown) => sent.push(m as Record<string, unknown>) },
  };
}

describe('handlePreviewRequest', () => {
  it('reads a text file and sends a single chunk', async () => {
    const { sent, ws } = recorder();
    const vfs = fakeVfs({ '/workspace/dist/index.html': '<h1>hi</h1>' });
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r1',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/dist/index.html',
        asText: true,
      },
      ws,
      vfs
    );
    expect(sent).toEqual([
      {
        type: 'preview.response',
        reqId: 'r1',
        ok: true,
        mime: 'text/html',
        chunkIndex: 0,
        totalChunks: 1,
        content: '<h1>hi</h1>',
        encoding: 'utf-8',
        status: 200,
      },
    ]);
  });

  it('rejects out-of-root paths with status 403 before any VFS read', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ws = { send: (m: unknown) => sent.push(m as Record<string, unknown>) };
    const readFile = vi.fn();
    const stat = vi.fn();
    const vfs = { readFile, stat } as unknown as Parameters<typeof handlePreviewRequest>[2];
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r2',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/.git/github-token',
        asText: true,
      },
      ws,
      vfs
    );
    expect(sent).toEqual([{ type: 'preview.response', reqId: 'r2', ok: false, status: 403 }]);
    expect(readFile).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it('returns 404 on ENOENT', async () => {
    const { sent, ws } = recorder();
    const vfs = fakeVfs({});
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r3',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/dist/missing.html',
        asText: true,
      },
      ws,
      vfs
    );
    expect(sent[0]).toMatchObject({ ok: false, status: 404 });
  });

  it('chunks large content at 64 KB boundaries', async () => {
    const big = 'x'.repeat(70_000);
    const { sent, ws } = recorder();
    const vfs = fakeVfs({ '/workspace/dist/big.js': big });
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r4',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/dist/big.js',
        asText: true,
      },
      ws,
      vfs
    );
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0].totalChunks).toBe(sent.length);
    expect(sent.map((s) => s.content).join('')).toBe(big);
  });

  it('encodes binary content as base64', async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x10, 0x20]);
    const { sent, ws } = recorder();
    const vfs = fakeVfs({ '/workspace/dist/x.png': bytes });
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r5',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/dist/x.png',
        asText: false,
      },
      ws,
      vfs
    );
    expect(sent[0]).toMatchObject({ encoding: 'base64', mime: 'image/png' });
    expect(atob(sent[0].content as string)).toBe(String.fromCharCode(0xff, 0x00, 0x10, 0x20));
  });

  it('resolves a directory request to index.html (re-gating the rewritten path)', async () => {
    const { sent, ws } = recorder();
    const vfs = fakeVfs({ '/workspace/dist/sub/index.html': 'inner' });
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r6',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/dist/sub',
        asText: true,
      },
      ws,
      vfs
    );
    expect(sent[0]).toMatchObject({ ok: true, content: 'inner', mime: 'text/html' });
  });
});

describe('handlePreviewRequest size pre-flight', () => {
  function sizedVfs(entries: Record<string, { type: 'file' | 'directory'; size?: number }>) {
    const readFile = vi.fn(async () => new Uint8Array(1));
    const readFileRange = vi.fn(async (_path: string, start: number, end: number) =>
      new Uint8Array(end - start).map((_, i) => (start + i) % 256)
    );
    return {
      readFile,
      readFileRange,
      async stat(path: string) {
        const entry = entries[path];
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return entry;
      },
    };
  }

  const request = (vfsPath: string) => ({
    type: 'preview.request' as const,
    reqId: 'big',
    servedRoot: '/workspace/media',
    vfsPath,
    asText: false,
  });

  it('refuses a file over 25 MiB with 413 and never reads it', async () => {
    const { sent, ws } = recorder();
    const vfs = sizedVfs({
      '/workspace/media/clips/talk.mp4': { type: 'file', size: 25 * 1024 * 1024 + 1 },
    });
    await handlePreviewRequest(request('/workspace/media/clips/talk.mp4'), ws, vfs);
    expect(sent).toEqual([
      {
        type: 'preview.response',
        reqId: 'big',
        ok: false,
        status: 413,
        reason: 'preview file exceeds 25 MiB limit: clips/talk.mp4',
        size: 25 * 1024 * 1024 + 1,
      },
    ]);
    expect(vfs.readFile).not.toHaveBeenCalled();
  });

  it('serves a file of exactly 25 MiB', async () => {
    const { sent, ws } = recorder();
    const vfs = sizedVfs({
      '/workspace/media/ok.bin': { type: 'file', size: 25 * 1024 * 1024 },
    });
    await handlePreviewRequest(request('/workspace/media/ok.bin'), ws, vfs);
    expect(vfs.readFile).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({ ok: true, encoding: 'base64' });
  });

  it('applies the limit to a directory index.html', async () => {
    const { sent, ws } = recorder();
    const vfs = sizedVfs({
      '/workspace/media/site': { type: 'directory' },
      '/workspace/media/site/index.html': { type: 'file', size: 26 * 1024 * 1024 },
    });
    await handlePreviewRequest(request('/workspace/media/site'), ws, vfs);
    expect(sent[0]).toMatchObject({ ok: false, status: 413 });
    expect(vfs.readFile).not.toHaveBeenCalled();
  });

  it('falls through to a 404 when a directory has no index.html', async () => {
    const { sent, ws } = recorder();
    const vfs = sizedVfs({ '/workspace/media/empty': { type: 'directory' } });
    vfs.readFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await handlePreviewRequest(request('/workspace/media/empty'), ws, vfs);
    expect(sent).toEqual([{ type: 'preview.response', reqId: 'big', ok: false, status: 404 }]);
  });
});

describe('handlePreviewRequest ranges', () => {
  const MiB = 1024 * 1024;

  function rangedVfs(size: number) {
    const readFile = vi.fn(async (): Promise<string | Uint8Array> => {
      throw new Error('whole-file read on a ranged request');
    });
    const readFileRange = vi.fn(async (_path: string, start: number, end: number) =>
      new Uint8Array(Math.max(0, Math.min(end, size) - start)).map((_, i) => (start + i) % 251)
    );
    return {
      readFile,
      readFileRange,
      async stat(path: string) {
        if (path.endsWith('/missing.mp4')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return { type: 'file' as const, size };
      },
    };
  }

  const request = (range: string | undefined, vfsPath = '/workspace/media/talk.mp4') => ({
    type: 'preview.request' as const,
    reqId: 'rng',
    servedRoot: '/workspace/media',
    vfsPath,
    asText: false,
    ...(range !== undefined ? { range } : {}),
  });

  function joined(sent: Array<Record<string, unknown>>): Uint8Array {
    const binary = sent.map((m) => atob(m.content as string)).join('');
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  it('reads only the window with readFileRange and answers 206 metadata', async () => {
    const { sent, ws } = recorder();
    const vfs = rangedVfs(10_000);
    await handlePreviewRequest(request('bytes=1000-1999'), ws, vfs);
    expect(vfs.readFileRange).toHaveBeenCalledWith('/workspace/media/talk.mp4', 1000, 2000);
    expect(vfs.readFile).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      ok: true,
      status: 206,
      size: 10_000,
      range: { start: 1000, end: 1999 },
      encoding: 'base64',
      mime: 'video/mp4',
    });
    const body = joined(sent);
    expect(body.byteLength).toBe(1000);
    expect(body[0]).toBe(1000 % 251);
  });

  it('clamps an open-ended range to 8 MiB', async () => {
    const { sent, ws } = recorder();
    const vfs = rangedVfs(20 * MiB);
    await handlePreviewRequest(request('bytes=0-'), ws, vfs);
    expect(vfs.readFileRange).toHaveBeenCalledWith(expect.any(String), 0, 8 * MiB);
    expect(sent[0]).toMatchObject({ status: 206, range: { start: 0, end: 8 * MiB - 1 } });

    expect(sent.every((m) => m.status === 206 && m.size === 20 * MiB)).toBe(true);
  });

  it('serves a range of a file above 25 MiB while the unranged GET gets 413', async () => {
    const size = 40 * MiB;
    const ranged = recorder();
    const vfs = rangedVfs(size);
    await handlePreviewRequest(request(`bytes=${size - 100}-`), ranged.ws, vfs);
    expect(ranged.sent[0]).toMatchObject({
      ok: true,
      status: 206,
      size,
      range: { start: size - 100, end: size - 1 },
    });

    const plain = recorder();
    await handlePreviewRequest(request(undefined), plain.ws, vfs);
    expect(plain.sent).toEqual([expect.objectContaining({ ok: false, status: 413, size })]);
    expect(vfs.readFile).not.toHaveBeenCalled();
  });

  it('answers 416 with the entity size for an unsatisfiable range', async () => {
    const { sent, ws } = recorder();
    const vfs = rangedVfs(500);
    await handlePreviewRequest(request('bytes=500-'), ws, vfs);
    expect(sent).toEqual([
      { type: 'preview.response', reqId: 'rng', ok: false, status: 416, size: 500 },
    ]);
    expect(vfs.readFileRange).not.toHaveBeenCalled();
  });

  it('answers 416 when the file shrank between stat and read', async () => {
    const { sent, ws } = recorder();
    const vfs = rangedVfs(500);
    vfs.readFileRange.mockResolvedValueOnce(new Uint8Array(0));
    await handlePreviewRequest(request('bytes=100-'), ws, vfs);
    expect(sent).toEqual([expect.objectContaining({ ok: false, status: 416, size: 500 })]);
  });

  it('sends a ranged text path as base64', async () => {
    const { sent, ws } = recorder();
    const vfs = rangedVfs(300);
    await handlePreviewRequest(
      { ...request('bytes=-10', '/workspace/media/app.js'), asText: true },
      ws,
      vfs
    );
    expect(sent[0]).toMatchObject({
      status: 206,
      encoding: 'base64',
      mime: 'application/javascript',
      range: { start: 290, end: 299 },
    });
  });

  it('serves the whole file for an unsupported Range header', async () => {
    const { sent, ws } = recorder();
    const vfs = rangedVfs(10);
    vfs.readFile.mockResolvedValueOnce(new Uint8Array(10));
    await handlePreviewRequest(request('bytes=0-1,4-5'), ws, vfs);
    expect(sent[0]).toMatchObject({ ok: true, status: 200, size: 10 });
    expect(vfs.readFileRange).not.toHaveBeenCalled();
  });

  it('maps a ranged read failure to 404 or 500', async () => {
    const vfs = rangedVfs(100);
    vfs.readFileRange.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    const missing = recorder();
    await handlePreviewRequest(request('bytes=0-9'), missing.ws, vfs);
    expect(missing.sent).toEqual([expect.objectContaining({ ok: false, status: 404 })]);

    vfs.readFileRange.mockRejectedValueOnce(new Error('disk on fire'));
    const broken = recorder();
    await handlePreviewRequest(request('bytes=0-9'), broken.ws, vfs);
    expect(broken.sent).toEqual([
      expect.objectContaining({ ok: false, status: 500, reason: 'disk on fire' }),
    ]);
  });

  it('ignores Range when the file cannot be stat-ed and lets readFile surface the 404', async () => {
    const { sent, ws } = recorder();
    const vfs = rangedVfs(100);
    vfs.readFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await handlePreviewRequest(request('bytes=0-9', '/workspace/media/missing.mp4'), ws, vfs);
    expect(sent).toEqual([expect.objectContaining({ ok: false, status: 404 })]);
    expect(vfs.readFileRange).not.toHaveBeenCalled();
  });
});
