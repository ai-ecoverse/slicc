import { parseByteRange } from '@slicc/shared-ts';

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
  | { ok: true; content: string | Uint8Array; size?: number }
  | { ok: false; error: string | null };

export interface PreviewReadWindow {
  start: number;
  end?: number;
}

const DEFAULT_TIMEOUT_MS = 30000;

const RETRY_INTERVAL_MS = 200;

const RETRY_WINDOW_MS = 3000;

export async function readViaMainPage(
  channel: PreviewChannel,
  vfsPath: string,
  asText: boolean,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  byteWindow?: PreviewReadWindow
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    function armTimeout(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        stopRetries();
        channel.removeEventListener('message', handler);
        resolve({ ok: false, error: null });
      }, timeoutMs);
    }
    armTimeout();

    function handler(event: MessageEvent): void {
      const data = event.data as
        | {
            type?: string;
            id?: string;
            content?: string | Uint8Array;
            error?: string;
            size?: number;
          }
        | undefined;
      if (!data || data.id !== id) return;

      if (data.type === 'preview-vfs-ack') {
        stopRetries();
        return;
      }

      if (data.type === 'preview-vfs-start') {
        stopRetries();
        armTimeout();
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
        resolve({
          ok: true,
          content: data.content,
          ...(typeof data.size === 'number' ? { size: data.size } : {}),
        });
        return;
      }
      resolve({ ok: false, error: 'empty response' });
    }

    function post(): void {
      channel.postMessage({
        type: 'preview-vfs-read',
        id,
        path: vfsPath,
        asText,
        ...(byteWindow && Number.isInteger(byteWindow.start) ? { start: byteWindow.start } : {}),
        ...(byteWindow && Number.isInteger(byteWindow.end) ? { end: byteWindow.end } : {}),
      });
    }

    channel.addEventListener('message', handler);
    post();
    retry = setInterval(post, RETRY_INTERVAL_MS);
    retryStop = setTimeout(stopRetries, Math.min(RETRY_WINDOW_MS, timeoutMs));
  });
}

export async function handlePreviewRequest(
  channel: PreviewChannel,
  vfsPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  rangeHeader?: string | null
): Promise<Response> {
  let path = vfsPath;
  let mimeType = getMimeType(path);
  const asText = TEXT_TYPES.has(mimeType);

  const byteWindow = asText ? undefined : byteWindowFromRangeHeader(rangeHeader);
  let outcome = await readViaMainPage(channel, path, asText, timeoutMs, byteWindow);

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
    return rangedResponse(body, mimeType, rangeHeader, outcome.size);
  }

  if (outcome.error && !outcome.error.includes('ENOENT')) {
    console.error('[preview-sw] Error serving', vfsPath, outcome.error);
    return new Response(`Preview error: ${outcome.error}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const reason = outcome.error === null ? 'responder timeout' : 'ENOENT';
  console.warn('[preview-sw] 404 for', vfsPath, '-', reason);
  return new Response(`Not found (${reason}): ${vfsPath}`, {
    status: 404,
    headers: { 'Content-Type': 'text/plain' },
  });
}

function rangedResponse(
  body: string | Uint8Array<ArrayBuffer>,
  mimeType: string,
  rangeHeader: string | null | undefined,
  entitySize?: number
): Response {
  if (typeof body === 'string') {
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': mimeType, 'Cache-Control': 'no-cache' },
    });
  }

  const size = entitySize ?? body.byteLength;
  const baseHeaders: Record<string, string> = {
    'Content-Type': mimeType,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  };

  const range = parseByteRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
    });
  }
  if (range === null) {
    return new Response(body, { status: 200, headers: baseHeaders });
  }

  const expected = range.end - range.start + 1;

  const slice = body.byteLength === expected ? body : body.subarray(range.start, range.end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(slice.byteLength),
    },
  });
}

export function byteWindowFromRangeHeader(
  header: string | null | undefined
): PreviewReadWindow | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '') return undefined;
  const start = Number(rawStart);
  if (rawEnd === '') return { start };
  return { start, end: Number(rawEnd) + 1 };
}

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

export function pathnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  return pathname.startsWith('/') ? pathname : null;
}

export function projectServeVfsPath(
  projectRoot: string | null,
  pathname: string,
  requesterPath: string | null,
  requesterIsProjectDocument: boolean
): string | null {
  if (!projectRoot) return null;
  if (isSliccAppPath(pathname)) return null;
  const isProjectContext = requesterIsProjectDocument || requesterPath?.startsWith('/preview/');
  return isProjectContext ? projectRoot + pathname : null;
}
