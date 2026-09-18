import { describe, expect, it } from 'vitest';
import {
  LIVE_PREVIEW_ORPHAN_MS,
  MAX_LIVE_PREVIEWS_PER_TRAY,
  MAX_SNAPSHOTS_PER_TRAY,
} from '../src/persistent-preview-storage.js';
import {
  dispatchPreviewRoute,
  expireOrphanedLivePreviews,
  leaderGoneSince,
  listPreviews,
  PREVIEW_FILE_TOO_LARGE,
  PreviewAssembler,
  type PreviewDeps,
  type PreviewResponseChunk,
  resolvePreview,
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

  it('caps utf-8 text by encoded bytes, not UTF-16 code units', async () => {
    const text = 'é'.repeat(30) + '😀'.repeat(5);
    expect(new TextEncoder().encode(text).length).toBe(80);
    const over = new PreviewAssembler(79);
    over.push(chunk([text], 0, 'utf-8'));
    await expect(over.done).resolves.toMatchObject({ ok: false, status: 413 });

    const exact = new PreviewAssembler(80);
    exact.push(chunk([text], 0, 'utf-8'));
    await expect(exact.done).resolves.toMatchObject({ ok: true, body: text });
  });

  it('counts an unpaired surrogate as three bytes', async () => {
    const assembler = new PreviewAssembler(3);
    assembler.push(chunk(['\ud83d'], 0, 'utf-8'));
    await expect(assembler.done).resolves.toMatchObject({ ok: true });
    const tooSmall = new PreviewAssembler(2);
    tooSmall.push(chunk(['\ud83dx'.slice(0, 1)], 0, 'utf-8'));
    await expect(tooSmall.done).resolves.toMatchObject({ ok: false, status: 413 });
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

interface FakeDeps extends PreviewDeps {
  previews: Record<string, PreviewRecord>;
  tray: {
    trayId: string;
    controllerToken: string;
    previews: Record<string, PreviewRecord>;
    leader: { connected: boolean; disconnectedAt?: string; lastSeenAt?: string } | null;
    previewTransfer?: { phase: 'pending' | 'forwarded' | 'complete' };
  };
  clock: { now: number };
  expiredCalls: string[][];
}

function fakeDeps(): FakeDeps {
  const tray: FakeDeps['tray'] = {
    trayId: '11111111-1111-4111-8111-111111111111',
    controllerToken: 'ctl',
    previews: {},
    leader: { connected: true },
  };
  const clock = { now: 0 };
  const expiredCalls: string[][] = [];
  return {
    tray,
    clock,
    expiredCalls,
    previews: tray.previews,
    loadTray: async () => {},
    getTray: () => tray,
    persistTray: async () => {},
    isoNow: () => new Date(clock.now).toISOString(),
    hasLiveLeader: () => true,
    sendToLeader: () => true,
    matchesToken: (a, b) => a === b,
    pendingPreviews: new Map(),
    now: () => clock.now,
    archiveAvailable: () => true,
    deleteArchivePrefix: async () => {},
    scheduleExpiry: async () => {},
    onLivePreviewsExpired: (tokens) => {
      expiredCalls.push(tokens);
    },
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

async function mintToken(deps: PreviewDeps, extra: { ttlMs?: number } = {}): Promise<string> {
  const res = await mint(deps, extra);
  expect(res.status).toBe(200);
  return ((await res.json()) as { previewToken: string }).previewToken;
}

describe('preview quota', () => {
  it('limits --ttl snapshots (uploads in progress included) and reports active/limit', async () => {
    const deps = fakeDeps();
    for (let i = 0; i < MAX_SNAPSHOTS_PER_TRAY; i++) await mintToken(deps, { ttlMs: 60_000 });
    const refused = await mint(deps, { ttlMs: 60_000 });
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({
      error: 'Snapshot limit reached',
      code: 'PREVIEW_LIMIT',
      active: MAX_SNAPSHOTS_PER_TRAY,
      limit: MAX_SNAPSHOTS_PER_TRAY,
    });
  });

  it('does not count live previews against the snapshot quota, nor snapshots against live', async () => {
    const deps = fakeDeps();
    for (let i = 0; i < 25; i++) await mintToken(deps);
    for (let i = 0; i < MAX_SNAPSHOTS_PER_TRAY; i++) await mintToken(deps, { ttlMs: 60_000 });
    expect((await mint(deps)).status).toBe(200);
  });

  it('bounds live previews only to protect the tray record', async () => {
    const deps = fakeDeps();
    for (let i = 0; i < MAX_LIVE_PREVIEWS_PER_TRAY; i++) await mintToken(deps);
    const refused = await mint(deps);
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({
      code: 'LIVE_PREVIEW_LIMIT',
      active: MAX_LIVE_PREVIEWS_PER_TRAY,
      limit: MAX_LIVE_PREVIEWS_PER_TRAY,
    });
  });

  it('does not count cleanup tombstones', async () => {
    const deps = fakeDeps();
    for (let i = 0; i < MAX_SNAPSHOTS_PER_TRAY; i++) await mintToken(deps, { ttlMs: 60_000 });
    Object.values(deps.previews)[0]!.state = 'cleanup';
    expect((await mint(deps, { ttlMs: 60_000 })).status).toBe(200);
  });

  it('keeps the plain 403 body for other mint failures', async () => {
    const deps = fakeDeps();
    deps.matchesToken = () => false;
    const res = await mint(deps);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid controller capability' });
  });
});

describe('listPreviews', () => {
  it('lists snapshots that are still uploading, but not cleanup tombstones', async () => {
    const deps = fakeDeps();
    const live = await mintToken(deps);
    const uploading = await mintToken(deps, { ttlMs: 60_000 });
    const tombstone = await mintToken(deps, { ttlMs: 60_000 });
    deps.previews[tombstone]!.state = 'cleanup';
    const listed = await listPreviews(deps);
    expect(listed.map((r) => [r.previewToken, r.mode, r.state])).toEqual([
      [live, 'live', 'ready'],
      [uploading, 'persistent', 'pending'],
    ]);
  });
});

describe('live preview expiry', () => {
  it('drops live previews once the leader has been gone past the grace period', async () => {
    const deps = fakeDeps();
    const live = await mintToken(deps);
    const snapshot = await mintToken(deps, { ttlMs: 7 * 86_400_000 });
    deps.tray.leader = { connected: false, disconnectedAt: new Date(0).toISOString() };

    deps.clock.now = LIVE_PREVIEW_ORPHAN_MS - 1;
    expect(await resolvePreview(live, deps)).not.toBeNull();
    expect(deps.expiredCalls).toEqual([]);

    deps.clock.now = LIVE_PREVIEW_ORPHAN_MS;
    expect(await resolvePreview(live, deps)).toBeNull();
    expect(deps.previews[live]).toBeUndefined();
    expect(deps.previews[snapshot]).toBeDefined();
    expect(deps.expiredCalls).toEqual([[live]]);
  });

  it('never expires while a connected leader keeps talking', async () => {
    const deps = fakeDeps();
    const live = await mintToken(deps);
    for (let minutes = 1; minutes <= 60; minutes++) {
      deps.clock.now = minutes * 60_000;
      deps.tray.leader = {
        connected: true,
        lastSeenAt: new Date(deps.clock.now - 30_000).toISOString(),
      };
      expect(await resolvePreview(live, deps)).not.toBeNull();
    }
  });

  it('treats a connected but silent (ghost) leader as gone', async () => {
    const deps = fakeDeps();
    const live = await mintToken(deps);
    deps.tray.leader = { connected: true, lastSeenAt: new Date(0).toISOString() };
    deps.clock.now = LIVE_PREVIEW_ORPHAN_MS - 1;
    expect(await resolvePreview(live, deps)).not.toBeNull();
    deps.clock.now = LIVE_PREVIEW_ORPHAN_MS;
    expect(await resolvePreview(live, deps)).toBeNull();
    expect(deps.expiredCalls).toEqual([[live]]);
  });

  it('leaderGoneSince prefers disconnectedAt over lastSeenAt', () => {
    expect(leaderGoneSince({ disconnectedAt: 'a', lastSeenAt: 'b' })).toBe('a');
    expect(leaderGoneSince({ lastSeenAt: 'b' })).toBe('b');
    expect(leaderGoneSince(null)).toBeUndefined();
  });

  it('uses the disconnect time handed in by a reclaim', async () => {
    const deps = fakeDeps();
    const live = await mintToken(deps);
    deps.clock.now = LIVE_PREVIEW_ORPHAN_MS + 1;
    await expect(expireOrphanedLivePreviews(deps, new Date(0).toISOString())).resolves.toEqual([
      live,
    ]);
    await expect(expireOrphanedLivePreviews(deps, new Date(0).toISOString())).resolves.toEqual([]);
  });

  it('leaves records alone while a preview transfer is in flight', async () => {
    const deps = fakeDeps();
    const live = await mintToken(deps);
    deps.tray.previewTransfer = { phase: 'pending' };
    deps.clock.now = LIVE_PREVIEW_ORPHAN_MS * 2;
    await expect(expireOrphanedLivePreviews(deps, new Date(0).toISOString())).resolves.toEqual([]);
    expect(deps.previews[live]).toBeDefined();
  });
});
