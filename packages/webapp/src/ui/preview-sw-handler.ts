/**
 * Pure request-handler half of the `/preview/*` service worker.
 *
 * Extracted from `preview-sw.ts` so the logic is testable without a
 * `ServiceWorkerGlobalScope`. After dropping the legacy IDB fast-path
 * (which served stale post-migration bytes), every read goes through
 * the `preview-vfs` BroadcastChannel responder — the same OPFS-backed
 * `VirtualFS` the rest of the app sees. There is intentionally no
 * SW-side cache: the responder is the single source of truth.
 *
 * The only structural carry-over from the old fast-path is the
 * directory → `index.html` resolution. When the responder reports
 * `EISDIR` for the requested path, we retry with `<path>/index.html`.
 */

/**
 * Structural subset of `BroadcastChannel` so this module is testable
 * with an in-memory fake.
 */
export interface PreviewChannel {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
}

export function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    mjs: 'application/javascript',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    avif: 'image/avif',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    webm: 'video/webm',
    pdf: 'application/pdf',
    txt: 'text/plain',
    xml: 'application/xml',
    wasm: 'application/wasm',
  };
  return map[ext] ?? 'application/octet-stream';
}

export const TEXT_TYPES = new Set([
  'text/html',
  'text/css',
  'text/plain',
  'application/javascript',
  'application/json',
  'image/svg+xml',
  'application/xml',
]);

export type ReadOutcome =
  | { ok: true; content: string | Uint8Array }
  | { ok: false; error: string | null };

/**
 * Worst-case `vfs-read-file` RPC budget. Matches `RemoteVfsClient`'s 30 s
 * default so large binary reads — pyodide.asm.wasm (~10 MB), python_stdlib.zip
 * (~4 MB), Whisper ONNX weights (~31 MB) — finish in the SW window instead of
 * surfacing as a misleading 404 while the responder is still pumping bytes.
 */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Cold-start re-post cadence. A `/preview/*` navigation commits a fresh page
 * whose `preview-vfs` responder listener is not yet wired into the channel
 * when the SW intercepts the first sub-resource (CSS/JS) and posts its read.
 * BroadcastChannel does not queue for not-yet-attached listeners, so that lone
 * message is dropped and the read would stall for the full `timeoutMs`. We
 * re-post on this interval so a responder that attaches a moment later still
 * sees the request.
 */
const RETRY_INTERVAL_MS = 200;

/**
 * Upper bound on the cold-start re-post window. Re-posting stops at the first
 * `preview-vfs-ack` (so a healthy responder mid-way through a large read is
 * never asked twice) or once this window elapses — whichever comes first. The
 * remaining `timeoutMs` is then spent waiting for the in-flight response, so
 * slow multi-MB reads still complete inside the SW budget.
 */
const RETRY_WINDOW_MS = 3000;

/**
 * Ask the page-side `installPreviewVfsResponder` for a file's content.
 * Uses BroadcastChannel because the main page at `/` is outside the SW's
 * `/preview/` scope, so `clients.matchAll()` can't find it.
 *
 * The responder acks each read on receipt; the SW re-posts the read during a
 * bounded cold-start window (see `RETRY_INTERVAL_MS` / `RETRY_WINDOW_MS`) until
 * that ack arrives, so a responder whose listener wires up slightly after the
 * read was first posted still answers instead of stalling for `timeoutMs`. The
 * ack stops re-posting before a large read is duplicated.
 *
 * Returns the responder's outcome verbatim; `error: null` is reserved for
 * a wire-level timeout (responder never replied within `timeoutMs`).
 */
export async function readViaMainPage(
  channel: PreviewChannel,
  vfsPath: string,
  asText: boolean,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ReadOutcome> {
  const id = `pvfs-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise<ReadOutcome>((resolve) => {
    let retry: ReturnType<typeof setInterval> | undefined;
    let retryStop: ReturnType<typeof setTimeout> | undefined;

    function stopRetries(): void {
      if (retry !== undefined) {
        clearInterval(retry);
        retry = undefined;
      }
      if (retryStop !== undefined) {
        clearTimeout(retryStop);
        retryStop = undefined;
      }
    }

    const timer = setTimeout(() => {
      stopRetries();
      channel.removeEventListener('message', handler);
      resolve({ ok: false, error: null });
    }, timeoutMs);

    function handler(event: MessageEvent): void {
      const data = event.data as
        | { type?: string; id?: string; content?: string | Uint8Array; error?: string }
        | undefined;
      if (!data || data.id !== id) return;
      // Responder heard us — stop the cold-start re-post loop, but keep waiting
      // for the actual response (a large read may still be in flight).
      if (data.type === 'preview-vfs-ack') {
        stopRetries();
        return;
      }
      if (data.type !== 'preview-vfs-response') return;
      stopRetries();
      channel.removeEventListener('message', handler);
      clearTimeout(timer);
      if (typeof data.error === 'string') {
        resolve({ ok: false, error: data.error });
        return;
      }
      if (data.content !== undefined) {
        resolve({ ok: true, content: data.content });
        return;
      }
      resolve({ ok: false, error: 'empty response' });
    }

    function post(): void {
      channel.postMessage({ type: 'preview-vfs-read', id, path: vfsPath, asText });
    }

    channel.addEventListener('message', handler);
    post();
    retry = setInterval(post, RETRY_INTERVAL_MS);
    retryStop = setTimeout(stopRetries, Math.min(RETRY_WINDOW_MS, timeoutMs));
  });
}

/**
 * Serve a `/preview/*` request by asking the responder. Preserves the
 * directory → `index.html` semantics the legacy LFS fast-path provided:
 * on an `EISDIR` from the responder, retries once with `/index.html`
 * appended (and recomputes the response content-type accordingly).
 */
export async function handlePreviewRequest(
  channel: PreviewChannel,
  vfsPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  let path = vfsPath;
  let mimeType = getMimeType(path);
  let outcome = await readViaMainPage(channel, path, TEXT_TYPES.has(mimeType), timeoutMs);

  if (!outcome.ok && outcome.error && outcome.error.includes('EISDIR')) {
    path = path.endsWith('/') ? path + 'index.html' : path + '/index.html';
    mimeType = getMimeType(path);
    outcome = await readViaMainPage(channel, path, TEXT_TYPES.has(mimeType), timeoutMs);
  }

  if (outcome.ok) {
    const body =
      typeof outcome.content === 'string'
        ? outcome.content
        : new Uint8Array(outcome.content as Uint8Array);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': mimeType, 'Cache-Control': 'no-cache' },
    });
  }

  if (outcome.error && !outcome.error.includes('ENOENT')) {
    console.error('[preview-sw] Error serving', vfsPath, outcome.error);
    return new Response(`Preview error: ${outcome.error}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Distinguish responder-timeout (no reply within budget) from a genuine
  // ENOENT so future debugging doesn't conflate "file missing" with
  // "read ran past the SW window". `outcome.error === null` is the sentinel
  // `readViaMainPage` uses for timeout.
  const reason = outcome.error === null ? 'responder timeout' : 'ENOENT';
  console.warn('[preview-sw] 404 for', vfsPath, '-', reason);
  return new Response(`Not found (${reason}): ${vfsPath}`, {
    status: 404,
    headers: { 'Content-Type': 'text/plain' },
  });
}

/**
 * Paths that should NOT be intercepted in project serve mode — they
 * belong to the slicc app itself (Vite HMR, API endpoints, UI assets).
 */
export function isSliccAppPath(pathname: string): boolean {
  return (
    pathname.startsWith('/@') ||
    pathname.startsWith('/__') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/packages/webapp/src/') ||
    pathname.startsWith('/node_modules/') ||
    pathname === '/' ||
    pathname === '/index.html'
  );
}
