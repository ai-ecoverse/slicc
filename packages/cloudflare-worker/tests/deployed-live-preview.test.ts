/**
 * Post-deploy smoke for the live (leader-relayed) preview path and the preview
 * quota (#2852, #3213).
 *
 * Runs against staging after BOTH the hub and the preview worker deployed,
 * with a scripted leader that serves generated files. Before the chunk-wise
 * assembler, a ~12 MiB file reset the tray DO right after it was served, so
 * the leader socket dropped and the next request failed. Skipped unless
 * WORKER_BASE_URL is set.
 */
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const workerBaseUrl = process.env.WORKER_BASE_URL;
const describeIfConfigured = workerBaseUrl ? describe : describe.skip;

const MIB = 1024 * 1024;
const LARGE_BYTES = 16 * MIB;
const OVERSIZE_BYTES = 25 * MIB + 1;
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

/** Answer `preview.request` like the webapp leader: 64 KiB base64 chunks. */
function answerPreviewRequests(socket: WebSocket, files: Map<string, Uint8Array>): void {
  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    const msg = JSON.parse(raw.toString('utf8')) as {
      type: string;
      reqId?: string;
      vfsPath?: string;
    };
    if (msg.type !== 'preview.request' || !msg.reqId) return;
    const name = msg.vfsPath?.split('/').pop() ?? '';
    const bytes = files.get(name);
    if (!bytes) {
      socket.send(
        JSON.stringify({ type: 'preview.response', reqId: msg.reqId, ok: false, status: 404 })
      );
      return;
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
        url?: string;
        error?: string;
        code?: string;
        active?: number;
        limit?: number;
      };
      if (body.previewToken) minted.push(body.previewToken);
      return { status: res.status, body };
    };
    return { leader, mint, api };
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
