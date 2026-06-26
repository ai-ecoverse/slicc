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
  stat(path: string): Promise<{ type: 'file' | 'directory' | 'symlink' }>;
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
  let vfsPath = msg.vfsPath;

  if (!isPathWithinServedRoot(vfsPath, servedRoot)) {
    ws.send({ type: 'preview.response', reqId, ok: false, status: 403 });
    return;
  }

  try {
    const st = await vfs.stat(vfsPath);
    if (st.type === 'directory') {
      vfsPath = vfsPath.replace(/\/?$/, '/') + 'index.html';
      if (!isPathWithinServedRoot(vfsPath, servedRoot)) {
        ws.send({ type: 'preview.response', reqId, ok: false, status: 403 });
        return;
      }
    }
  } catch {
    // ENOENT here is fine — fall through to readFile, which will surface the 404 below.
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
