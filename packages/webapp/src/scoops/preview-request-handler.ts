import { PREVIEW_MAX_FILE_BYTES } from '@slicc/shared-ts';
import { isPathWithinServedRoot } from './preview-security.js';
import { uint8ToBase64 } from './tray-fs-handler.js';

const CHUNK_THRESHOLD = 64 * 1024;

export interface PreviewRequestMessage {
  type: 'preview.request';
  reqId: string;
  servedRoot: string;
  vfsPath: string;
  asText: boolean;
}

interface MinimalVfs {
  readFile(path: string, options?: { encoding?: 'utf-8' | 'binary' }): Promise<string | Uint8Array>;
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

  // Refuse before reading: the worker relay buffers the whole file and caps it
  // at the same limit, so sending more only burns the socket (#2852).
  if (size !== undefined && size > PREVIEW_MAX_FILE_BYTES) {
    ws.send({
      type: 'preview.response',
      reqId,
      ok: false,
      status: 413,
      reason: `preview file exceeds ${PREVIEW_MAX_FILE_BYTES / 1024 / 1024} MiB limit: ${servedRelativePath(vfsPath, servedRoot)}`,
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
    const code = (e as { code?: string })?.code;
    if (code === 'ENOENT') {
      ws.send({ type: 'preview.response', reqId, ok: false, status: 404 });
    } else {
      ws.send({
        type: 'preview.response',
        reqId,
        ok: false,
        status: 500,
        reason: String((e as Error)?.message ?? e),
      });
    }
    return;
  }

  const mime = mimeForPath(vfsPath);
  const chunks = chunkBy(content, CHUNK_THRESHOLD);
  for (let i = 0; i < chunks.length; i++) {
    ws.send({
      type: 'preview.response',
      reqId,
      ok: true,
      mime,
      chunkIndex: i,
      totalChunks: chunks.length,
      content: chunks[i],
      encoding,
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
