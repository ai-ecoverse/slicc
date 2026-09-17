import {
  type ByteRange,
  PREVIEW_MAX_FILE_BYTES,
  PREVIEW_MAX_RANGE_BYTES,
  parseByteRange,
} from '@slicc/shared-ts';
import { isPathWithinServedRoot } from './preview-security.js';
import { uint8ToBase64 } from './tray-fs-handler.js';

const CHUNK_THRESHOLD = 64 * 1024;

export interface PreviewRequestMessage {
  type: 'preview.request';
  reqId: string;
  servedRoot: string;
  vfsPath: string;
  asText: boolean;
  /** Raw visitor `Range` header; see `WorkerPreviewRequest.range`. */
  range?: string;
}

interface MinimalVfs {
  readFile(path: string, options?: { encoding?: 'utf-8' | 'binary' }): Promise<string | Uint8Array>;
  /** Half-open `[start, end)`, as `VirtualFS.readFileRange`. */
  readFileRange(path: string, start: number, end: number): Promise<Uint8Array>;
  stat(path: string): Promise<{ type: 'file' | 'directory' | 'symlink'; size?: number }>;
}

interface MinimalLeaderSocket {
  send(msg: unknown): void;
}

export async function handlePreviewRequest(
  msg: PreviewRequestMessage,
  ws: MinimalLeaderSocket,
  vfs: MinimalVfs
): Promise<void> {
  const { reqId, servedRoot, asText } = msg;

  if (!isPathWithinServedRoot(msg.vfsPath, servedRoot)) {
    ws.send({ type: 'preview.response', reqId, ok: false, status: 403 });
    return;
  }

  const resolved = await statServedFile(msg.vfsPath, servedRoot, vfs);
  if (resolved === 'forbidden') {
    ws.send({ type: 'preview.response', reqId, ok: false, status: 403 });
    return;
  }
  const { vfsPath, size } = resolved;

  const range = size === undefined ? null : parseByteRange(msg.range, size);
  if (range === 'unsatisfiable') {
    ws.send({ type: 'preview.response', reqId, ok: false, status: 416, size });
    return;
  }
  if (range && size !== undefined) {
    await sendRange(msg, ws, vfs, vfsPath, clampRange(range), size);
    return;
  }

  // Refuse before reading: the worker relay buffers the whole file and caps it
  // at the same limit, so sending more only burns the socket (#2852). Ranged
  // requests above took their own bounded path, so large media still plays.
  if (size !== undefined && size > PREVIEW_MAX_FILE_BYTES) {
    ws.send({
      type: 'preview.response',
      reqId,
      ok: false,
      status: 413,
      reason: `preview file exceeds ${PREVIEW_MAX_FILE_BYTES / 1024 / 1024} MiB limit: ${servedRelativePath(vfsPath, servedRoot)}`,
      size,
    });
    return;
  }

  let content: string;
  let encoding: 'utf-8' | 'base64';
  try {
    if (asText) {
      content = (await vfs.readFile(vfsPath, { encoding: 'utf-8' })) as string;
      encoding = 'utf-8';
    } else {
      const bytes = (await vfs.readFile(vfsPath, { encoding: 'binary' })) as Uint8Array;
      content = uint8ToBase64(bytes);
      encoding = 'base64';
    }
  } catch (e: unknown) {
    sendReadError(reqId, ws, e);
    return;
  }

  sendChunks(ws, {
    reqId,
    mime: mimeForPath(vfsPath),
    content,
    encoding,
    meta: { status: 200, ...(size !== undefined ? { size } : {}) },
  });
}

/**
 * A server may answer a range with fewer bytes than were asked; media
 * elements request the next window. Clamping keeps every 206 within what the
 * worker relay buffers, whatever the file size.
 */
function clampRange(range: ByteRange): ByteRange {
  return {
    start: range.start,
    end: Math.min(range.end, range.start + PREVIEW_MAX_RANGE_BYTES - 1),
  };
}

/**
 * Read and send one window. Always base64: a window can split a multi-byte
 * character, which utf-8 transport cannot carry.
 */
async function sendRange(
  msg: PreviewRequestMessage,
  ws: MinimalLeaderSocket,
  vfs: MinimalVfs,
  vfsPath: string,
  range: ByteRange,
  size: number
): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = await vfs.readFileRange(vfsPath, range.start, range.end + 1);
  } catch (e: unknown) {
    sendReadError(msg.reqId, ws, e);
    return;
  }
  // The file may have shrunk between stat and read; describe what was read.
  if (bytes.byteLength === 0) {
    ws.send({ type: 'preview.response', reqId: msg.reqId, ok: false, status: 416, size });
    return;
  }
  const sent = { start: range.start, end: range.start + bytes.byteLength - 1 };
  sendChunks(ws, {
    reqId: msg.reqId,
    mime: mimeForPath(vfsPath),
    content: uint8ToBase64(bytes),
    encoding: 'base64',
    meta: { status: 206, size, range: sent },
  });
}

function sendReadError(reqId: string, ws: MinimalLeaderSocket, e: unknown): void {
  const code = (e as { code?: string })?.code;
  if (code === 'ENOENT') {
    ws.send({ type: 'preview.response', reqId, ok: false, status: 404 });
    return;
  }
  ws.send({
    type: 'preview.response',
    reqId,
    ok: false,
    status: 500,
    reason: String((e as Error)?.message ?? e),
  });
}

/**
 * Range metadata rides on every chunk, so the worker can read it from
 * whichever chunk completes the set.
 */
function sendChunks(
  ws: MinimalLeaderSocket,
  body: {
    reqId: string;
    mime: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    meta: { status: 200 | 206; size?: number; range?: ByteRange };
  }
): void {
  const chunks = chunkBy(body.content, CHUNK_THRESHOLD);
  for (let i = 0; i < chunks.length; i++) {
    ws.send({
      type: 'preview.response',
      reqId: body.reqId,
      ok: true,
      mime: body.mime,
      chunkIndex: i,
      totalChunks: chunks.length,
      content: chunks[i],
      encoding: body.encoding,
      ...body.meta,
    });
  }
}

/** Map a directory to its index.html and read the file size when the entry exists. */
async function statServedFile(
  vfsPath: string,
  servedRoot: string,
  vfs: MinimalVfs
): Promise<{ vfsPath: string; size?: number } | 'forbidden'> {
  try {
    const st = await vfs.stat(vfsPath);
    if (st.type !== 'directory') return { vfsPath, size: st.size };
    const indexPath = vfsPath.replace(/\/?$/, '/') + 'index.html';
    if (!isPathWithinServedRoot(indexPath, servedRoot)) return 'forbidden';
    const indexStat = await vfs.stat(indexPath).catch(() => null);
    return { vfsPath: indexPath, size: indexStat?.size };
  } catch {
    // ENOENT here is fine — readFile surfaces the 404.
    return { vfsPath };
  }
}

function servedRelativePath(vfsPath: string, servedRoot: string): string {
  const root = servedRoot.replace(/\/$/, '');
  return vfsPath.startsWith(`${root}/`) ? vfsPath.slice(root.length + 1) : vfsPath;
}

function chunkBy(content: string, size: number): string[] {
  if (content.length <= size) return [content];
  const out: string[] = [];
  for (let i = 0; i < content.length; i += size) out.push(content.slice(i, i + size));
  return out;
}

function mimeForPath(path: string): string {
  if (/\.html?$/i.test(path)) return 'text/html';
  if (/\.css$/i.test(path)) return 'text/css';
  if (/\.m?js$/i.test(path)) return 'application/javascript';
  if (/\.json$/i.test(path)) return 'application/json';
  if (/\.svg$/i.test(path)) return 'image/svg+xml';
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  if (/\.gif$/i.test(path)) return 'image/gif';
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.ico$/i.test(path)) return 'image/x-icon';
  if (/\.woff2$/i.test(path)) return 'font/woff2';
  if (/\.woff$/i.test(path)) return 'font/woff';
  if (/\.ttf$/i.test(path)) return 'font/ttf';
  if (/\.mp4$/i.test(path)) return 'video/mp4';
  if (/\.webm$/i.test(path)) return 'video/webm';
  if (/\.mp3$/i.test(path)) return 'audio/mpeg';
  if (/\.pdf$/i.test(path)) return 'application/pdf';
  if (/\.xml$/i.test(path)) return 'application/xml';
  if (/\.wasm$/i.test(path)) return 'application/wasm';
  return 'application/octet-stream';
}
