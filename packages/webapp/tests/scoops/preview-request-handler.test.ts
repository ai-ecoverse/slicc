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
