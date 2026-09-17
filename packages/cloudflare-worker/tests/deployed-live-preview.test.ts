/**
 * Post-deploy smoke for the live (leader-relayed) preview path and the preview
 * quota (#2852, #3213).
 *
 * Runs against staging after BOTH the hub and the preview worker deployed,
 * with a scripted leader that serves generated files. Before the chunk-wise
 * assembler, a ~12 MiB file reset the tray DO right after it was served, so
 * the leader socket dropped and the next request failed. Also covers HTTP
 * Range on live previews (served in ≤ 8 MiB windows, even above the 25 MiB
 * whole-file cap) and on `--ttl` snapshots. Skipped unless WORKER_BASE_URL
 * is set.
 */
import { createHash } from 'node:crypto';
import { PREVIEW_MAX_RANGE_BYTES, parseByteRange } from '@slicc/shared-ts';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const workerBaseUrl = process.env.WORKER_BASE_URL;
const describeIfConfigured = workerBaseUrl ? describe : describe.skip;

const MIB = 1024 * 1024;
const LARGE_BYTES = 16 * MIB;
const OVERSIZE_BYTES = 25 * MIB + 1;
const SMALL_BYTES = 256 * 1024;
const CHUNK_CHARS = 64 * 1024;

interface Leader {
  trayId: string;
  controllerToken: string;
  socket: WebSocket;
  closedWith: () => number | null;
}

function fileBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 13) & 0xff;
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Answer `preview.request` like the webapp leader: 64 KiB base64 chunks, and
 * for a `range` only that window, clamped to `PREVIEW_MAX_RANGE_BYTES`.
 */
function answerPreviewRequests(socket: WebSocket, files: Map<string, Uint8Array>): void {
  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    const msg = JSON.parse(raw.toString('utf8')) as {
      type: string;
      reqId?: string;
      vfsPath?: string;
      range?: string;
    };
    if (msg.type !== 'preview.request' || !msg.reqId) return;
    const name = msg.vfsPath?.split('/').pop() ?? '';
    const file = files.get(name);
    if (!file) {
      socket.send(
        JSON.stringify({ type: 'preview.response', reqId: msg.reqId, ok: false, status: 404 })
      );
      return;
    }
    const size = file.byteLength;
    const range = parseByteRange(msg.range, size);
    if (range === 'unsatisfiable') {
      socket.send(
        JSON.stringify({ type: 'preview.response', reqId: msg.reqId, ok: false, status: 416, size })
      );
      return;
    }
    let bytes = file;
    let meta: Record<string, unknown> = { status: 200, size };
    if (range) {
      const end = Math.min(range.end, range.start + PREVIEW_MAX_RANGE_BYTES - 1);
      bytes = file.subarray(range.start, end + 1);
      meta = { status: 206, size, range: { start: range.start, end } };
    }
    const content = Buffer.from(bytes).toString('base64');
    const totalChunks = Math.max(1, Math.ceil(content.length / CHUNK_CHARS));
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      socket.send(
        JSON.stringify({
          type: 'preview.response',
          reqId: msg.reqId,
          ok: true,
          mime: name.endsWith('.html') ? 'text/html' : 'application/octet-stream',
          chunkIndex,
          totalChunks,
          content: content.slice(chunkIndex * CHUNK_CHARS, (chunkIndex + 1) * CHUNK_CHARS),
          encoding: 'base64',
          ...meta,
        })
      );
    }
  });
}

async function attachLeader(baseUrl: string, files: Map<string, Uint8Array>): Promise<Leader> {
  const created = (await (await fetch(new URL('/tray', baseUrl), { method: 'POST' })).json()) as {
    trayId: string;
    capabilities: { controller: { url: string } };
  };
  const controllerUrl = created.capabilities.controller.url;
  const attach = (await (
    await fetch(controllerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'ci-live-preview', runtime: 'github-actions' }),
    })
  ).json()) as { websocket?: { url: string } | null };
  if (!attach.websocket?.url) throw new Error('controller attach returned no websocket');
  const socket = new WebSocket(attach.websocket.url);
  let closeCode: number | null = null;
  socket.on('close', (code: number) => {
    closeCode = code;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  answerPreviewRequests(socket, files);
  return {
    trayId: created.trayId,
    controllerToken: new URL(controllerUrl).pathname.split('/').pop() ?? '',
    socket,
    closedWith: () => closeCode,
  };
}

describeIfConfigured('deployed live preview (staging)', () => {
  const files = new Map<string, Uint8Array>([
    ['index.html', new TextEncoder().encode('<h1>live preview smoke</h1>')],
    ['large.bin', fileBytes(LARGE_BYTES)],
    ['oversize.bin', fileBytes(OVERSIZE_BYTES)],
    ['small.bin', fileBytes(SMALL_BYTES)],
  ]);
  const cleanups: Array<() => Promise<void>> = [];

  /** A fresh tray + scripted leader per test, so one failure cannot cascade. */
  async function setup() {
    const leader = await attachLeader(workerBaseUrl!, files);
    const minted: string[] = [];
    const api = (path: string, init: RequestInit = {}) =>
      fetch(new URL(`/api/tray/${leader.trayId}${path}`, workerBaseUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${leader.controllerToken}`,
          'content-type': 'application/json',
        },
      });
    cleanups.push(async () => {
      for (const previewToken of minted) {
        await api('/preview/stop', { method: 'POST', body: JSON.stringify({ previewToken }) });
      }
      leader.socket.close();
    });
    const mint = async (extra: { ttlMs?: number } = {}) => {
      const res = await api('/preview', {
        method: 'POST',
        body: JSON.stringify({
          servedRoot: '/smoke',
          entryPath: '/smoke/index.html',
          allowLive: false,
          ...extra,
        }),
      });
      const body = (await res.json()) as {
        previewToken?: string;
        uploadToken?: string;
        url?: string;
        error?: string;
        code?: string;
        active?: number;
        limit?: number;
      };
      if (body.previewToken) minted.push(body.previewToken);
      return { status: res.status, body };
    };
    /** Upload and finalize a `--ttl` snapshot the way `preview-mint-client.ts` does. */
    const publish = async (previewToken: string, uploadToken: string, names: string[]) => {
      const base = new URL(
        `/api/tray/${leader.trayId}/preview/${encodeURIComponent(previewToken)}`,
        workerBaseUrl
      );
      for (const name of names) {
        const upload = await fetch(`${base}/file?path=${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${uploadToken}`,
            'content-type': name.endsWith('.html') ? 'text/html' : 'application/octet-stream',
          },
          body: files.get(name)!,
        });
        expect(upload.status).toBe(204);
      }
      const finalize = await fetch(`${base}/finalize`, {
        method: 'POST',
        headers: { authorization: `Bearer ${uploadToken}` },
      });
      expect(finalize.status).toBe(200);
      return (await finalize.json()) as { url: string };
    };
    return { leader, mint, api, publish };
  }

  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup().catch(() => {});
  });

  it('serves a 16 MiB file and the tray stays healthy afterwards', async () => {
    const { leader, mint } = await setup();
    const { status, body } = await mint();
    expect(status).toBe(200);
    const origin = new URL(body.url!).origin;

    const large = await fetch(`${origin}/large.bin`);
    expect(large.status).toBe(200);
    const received = new Uint8Array(await large.arrayBuffer());
    expect(received.length).toBe(LARGE_BYTES);
    expect(sha256(received)).toBe(sha256(files.get('large.bin')!));

    // The regression: the DO reset shortly AFTER serving, dropping the leader.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const after = await fetch(`${origin}/index.html?after=large`);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe('<h1>live preview smoke</h1>');
    expect(leader.closedWith()).toBeNull();
  }, 180_000);

  it('rejects a file over 25 MiB with a clean 413 instead of a Worker exception', async () => {
    const { leader, mint } = await setup();
    const origin = new URL((await mint()).body.url!).origin;
    const oversize = await fetch(`${origin}/oversize.bin`);
    expect(oversize.status).toBe(413);
    expect(await oversize.text()).toBe('preview file exceeds 25 MiB limit');

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect((await fetch(`${origin}/index.html?after=oversize`)).status).toBe(200);
    expect(leader.closedWith()).toBeNull();
  }, 180_000);

  it('serves live byte ranges, including 8 MiB windows of a file over 25 MiB', async () => {
    const { leader, mint } = await setup();
    const origin = new URL((await mint()).body.url!).origin;
    const large = files.get('large.bin')!;

    const middle = await fetch(`${origin}/large.bin`, { headers: { range: 'bytes=1000-1999' } });
    expect(middle.status).toBe(206);
    expect(middle.headers.get('content-range')).toBe(`bytes 1000-1999/${LARGE_BYTES}`);
    expect(middle.headers.get('accept-ranges')).toBe('bytes');
    expect(
      Buffer.from(await middle.arrayBuffer()).equals(Buffer.from(large.subarray(1000, 2000)))
    ).toBe(true);

    const window = await fetch(`${origin}/oversize.bin`, { headers: { range: 'bytes=0-' } });
    expect(window.status).toBe(206);
    expect(window.headers.get('content-range')).toBe(
      `bytes 0-${PREVIEW_MAX_RANGE_BYTES - 1}/${OVERSIZE_BYTES}`
    );
    const windowBytes = new Uint8Array(await window.arrayBuffer());
    expect(windowBytes.byteLength).toBe(PREVIEW_MAX_RANGE_BYTES);
    expect(sha256(windowBytes)).toBe(
      sha256(files.get('oversize.bin')!.subarray(0, PREVIEW_MAX_RANGE_BYTES))
    );

    const suffix = await fetch(`${origin}/large.bin`, { headers: { range: 'bytes=-100' } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe(
      `bytes ${LARGE_BYTES - 100}-${LARGE_BYTES - 1}/${LARGE_BYTES}`
    );
    expect(Buffer.from(await suffix.arrayBuffer()).equals(Buffer.from(large.subarray(-100)))).toBe(
      true
    );

    const outside = await fetch(`${origin}/large.bin`, {
      headers: { range: `bytes=${LARGE_BYTES}-` },
    });
    expect(outside.status).toBe(416);
    expect(outside.headers.get('content-range')).toBe(`bytes */${LARGE_BYTES}`);

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect((await fetch(`${origin}/index.html?after=ranges`)).status).toBe(200);
    expect(leader.closedWith()).toBeNull();
  }, 180_000);

  it('serves byte ranges from a --ttl snapshot', async () => {
    const { mint, publish } = await setup();
    const { status, body } = await mint({ ttlMs: 10 * 60 * 1000 });
    expect(status).toBe(200);
    const { url } = await publish(body.previewToken!, body.uploadToken!, [
      'index.html',
      'small.bin',
    ]);
    const origin = new URL(url).origin;
    const ranged = await fetch(`${origin}/small.bin`, { headers: { range: 'bytes=100-199' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 100-199/${SMALL_BYTES}`);
    expect(ranged.headers.get('accept-ranges')).toBe('bytes');
    expect(
      Buffer.from(await ranged.arrayBuffer()).equals(
        Buffer.from(files.get('small.bin')!.subarray(100, 200))
      )
    ).toBe(true);
    const outside = await fetch(`${origin}/small.bin`, {
      headers: { range: `bytes=${SMALL_BYTES}-` },
    });
    expect(outside.status).toBe(416);
  }, 60_000);

  it('limits only --ttl snapshots, lists uploads in progress, and leaves live previews free', async () => {
    const { mint, api } = await setup();
    // Snapshots are minted but never uploaded, so they stay `pending` and
    // write nothing to R2; afterAll stops them.
    let refused: Awaited<ReturnType<typeof mint>> | undefined;
    for (let i = 0; i < 20 && !refused; i++) {
      const attempt = await mint({ ttlMs: 10 * 60_000 });
      if (attempt.status !== 200) refused = attempt;
    }
    expect(refused?.status).toBe(429);
    expect(refused?.body).toMatchObject({
      error: 'Snapshot limit reached',
      code: 'PREVIEW_LIMIT',
      active: 10,
      limit: 10,
    });

    for (let i = 0; i < 3; i++) expect((await mint()).status).toBe(200);

    const listed = (await (await api('/previews')).json()) as {
      previews: Array<{ mode?: string; state?: string }>;
    };
    expect(
      listed.previews.filter((p) => p.mode === 'persistent' && p.state === 'pending')
    ).toHaveLength(10);
    expect(listed.previews.filter((p) => p.mode === 'live')).toHaveLength(3);
  }, 60_000);
});
