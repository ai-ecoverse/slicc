import { describe, expect, it } from 'vitest';
import { MAX_PREVIEWS_PER_TRAY } from '../src/persistent-preview-storage.js';
import {
  dispatchPreviewRoute,
  PREVIEW_FILE_TOO_LARGE,
  PreviewAssembler,
  type PreviewDeps,
  type PreviewResponseChunk,
} from '../src/session-tray-preview.js';
import type { PreviewRecord } from '../src/shared.js';

const CHUNK = 64 * 1024;

function patternBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7) & 0xff;
  return bytes;
}

function base64Chunks(bytes: Uint8Array, chunkChars = CHUNK): string[] {
  const b64 = Buffer.from(bytes).toString('base64');
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += chunkChars) out.push(b64.slice(i, i + chunkChars));
  return out;
}

function chunk(
  pieces: string[],
  index: number,
  encoding: 'utf-8' | 'base64' = 'base64'
): PreviewResponseChunk {
  return {
    type: 'preview.response',
    reqId: 'r1',
    ok: true,
    mime: 'application/octet-stream',
    chunkIndex: index,
    totalChunks: pieces.length,
    content: pieces[index],
    encoding,
  };
}

describe('PreviewAssembler', () => {
  it('decodes multi-chunk base64 into the exact original bytes, in any order', async () => {
    const bytes = patternBytes(3 * CHUNK + 1234);
    const pieces = base64Chunks(bytes);
    const assembler = new PreviewAssembler();
    for (const i of [2, 0, 3, 1, 4].filter((n) => n < pieces.length)) {
      assembler.push(chunk(pieces, i));
    }
    const result = await assembler.done;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.body as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
  });

  it('joins utf-8 chunks as text', async () => {
    const pieces = ['<h1>', 'héllo ', '😀</h1>'];
    const assembler = new PreviewAssembler();
    pieces.forEach((_, i) => {
      assembler.push(chunk(pieces, i, 'utf-8'));
    });
    const result = await assembler.done;
    expect(result).toMatchObject({ ok: true, body: '<h1>héllo 😀</h1>' });
  });

  it('ignores a duplicated chunk index', async () => {
    const bytes = patternBytes(2 * CHUNK);
    const pieces = base64Chunks(bytes);
    const assembler = new PreviewAssembler();
    assembler.push(chunk(pieces, 0));
    assembler.push(chunk(pieces, 0));
    for (let i = 1; i < pieces.length; i++) assembler.push(chunk(pieces, i));
    const result = await assembler.done;
    expect(result.ok && (result.body as Uint8Array).length).toBe(bytes.length);
  });

  it('fails with 413 once the decoded size passes the cap, and ignores later chunks', async () => {
    const pieces = base64Chunks(patternBytes(4 * 48), 64);
    const assembler = new PreviewAssembler(100);
    for (let i = 0; i < pieces.length; i++) assembler.push(chunk(pieces, i));
    await expect(assembler.done).resolves.toEqual({
      ok: false,
      status: 413,
      reason: PREVIEW_FILE_TOO_LARGE,
    });
  });

  it('accepts a body exactly at the cap', async () => {
    const pieces = base64Chunks(patternBytes(96), 64);
    const assembler = new PreviewAssembler(96);
    for (let i = 0; i < pieces.length; i++) assembler.push(chunk(pieces, i));
    const result = await assembler.done;
    expect(result.ok).toBe(true);
  });

  it('fails with 502 on an undecodable base64 chunk', async () => {
    const assembler = new PreviewAssembler();
    assembler.push(chunk(['@@@@'], 0));
    await expect(assembler.done).resolves.toMatchObject({ ok: false, status: 502 });
  });

  it('keeps the first settlement when the leader fails after an error', async () => {
    const assembler = new PreviewAssembler();
    assembler.push({ type: 'preview.response', reqId: 'r1', ok: false, status: 404 });
    assembler.fail(502, 'leader disconnected');
    await expect(assembler.done).resolves.toEqual({ ok: false, status: 404, reason: undefined });
  });
});

function fakeDeps(): PreviewDeps & { previews: Record<string, PreviewRecord> } {
  const tray = {
    trayId: '11111111-1111-4111-8111-111111111111',
    controllerToken: 'ctl',
    previews: {} as Record<string, PreviewRecord>,
  };
  return {
    previews: tray.previews,
    loadTray: async () => {},
    getTray: () => tray,
    persistTray: async () => {},
    isoNow: () => new Date(0).toISOString(),
    hasLiveLeader: () => true,
    sendToLeader: () => true,
    matchesToken: (a, b) => a === b,
    pendingPreviews: new Map(),
    now: () => 0,
    archiveAvailable: () => true,
    deleteArchivePrefix: async () => {},
    scheduleExpiry: async () => {},
  };
}

function mintRequest(extra: { ttlMs?: number } = {}): Request {
  return new Request('https://internal/internal/preview/mint', {
    method: 'POST',
    body: JSON.stringify({
      controllerToken: 'ctl',
      servedRoot: '/w',
      entryPath: '/w/index.html',
      allowLive: false,
      workerBaseUrl: 'https://www.sliccy.ai',
      ...extra,
    }),
  });
}

async function mint(deps: PreviewDeps, extra: { ttlMs?: number } = {}): Promise<Response> {
  const res = await dispatchPreviewRoute(
    new URL('https://internal/internal/preview/mint'),
    mintRequest(extra),
    deps
  );
  if (!res) throw new Error('mint route did not match');
  return res;
}

describe('preview quota', () => {
  it('counts pending --ttl snapshots and reports active/limit on the 429', async () => {
    const deps = fakeDeps();
    expect((await mint(deps, { ttlMs: 60_000 })).status).toBe(200);
    for (let i = 1; i < MAX_PREVIEWS_PER_TRAY; i++) {
      expect((await mint(deps)).status).toBe(200);
    }
    const refused = await mint(deps);
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({
      error: 'Preview limit reached',
      code: 'PREVIEW_LIMIT',
      active: MAX_PREVIEWS_PER_TRAY,
      limit: MAX_PREVIEWS_PER_TRAY,
    });
  });

  it('does not count cleanup tombstones', async () => {
    const deps = fakeDeps();
    for (let i = 0; i < MAX_PREVIEWS_PER_TRAY; i++) await mint(deps);
    const first = Object.values(deps.previews)[0]!;
    first.state = 'cleanup';
    expect((await mint(deps)).status).toBe(200);
  });

  it('keeps the plain 403 body for other mint failures', async () => {
    const deps = fakeDeps();
    deps.matchesToken = () => false;
    const res = await mint(deps);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid controller capability' });
  });
});
