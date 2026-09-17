import { type ByteRange, parseByteRange } from '@slicc/shared-ts';
import type { PreviewRecord } from './shared.js';

export const PREVIEW_ARCHIVE_PREFIX = 'previews/';
export const MAX_PREVIEW_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PREVIEW_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_PREVIEW_FILES = 1_000;
export const MAX_PREVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `--ttl` snapshots one tray may hold, counting snapshots still uploading. */
export const MAX_SNAPSHOTS_PER_TRAY = 10;
/**
 * Not a user quota: live previews cost no storage and expire with the leader
 * connection. This only bounds the single persisted tray record.
 */
export const MAX_LIVE_PREVIEWS_PER_TRAY = 200;
/**
 * Live previews are served from the leader's VFS, so they die with the leader
 * connection. The grace rides out socket blips and page reloads.
 */
export const LIVE_PREVIEW_ORPHAN_MS = 5 * 60 * 1000;

export function normalizePreviewArchivePath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

export async function deletePreviewArchivePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

function entryRelativePath(record: PreviewRecord): string {
  const rootPrefix = record.servedRoot === '/' ? '/' : `${record.servedRoot.replace(/\/$/, '')}/`;
  const relative = record.entryPath.startsWith(rootPrefix)
    ? record.entryPath.slice(rootPrefix.length)
    : record.entryPath.replace(/^\//, '');
  return relative || 'index.html';
}

function requestRelativePath(url: URL, record: PreviewRecord): string | null {
  if (url.pathname === '/') return normalizePreviewArchivePath(entryRelativePath(record));
  try {
    return normalizePreviewArchivePath(decodeURIComponent(url.pathname.slice(1)));
  } catch {
    return null;
  }
}

export async function servePersistentPreview(
  request: Request,
  url: URL,
  record: PreviewRecord,
  bucket: R2Bucket
): Promise<Response> {
  const relativePath = requestRelativePath(url, record);
  if (!relativePath || !record.archivePrefix || !record.expiresAt) {
    return new Response('Not found', { status: 404 });
  }
  const remainingSeconds = Math.floor((Date.parse(record.expiresAt) - Date.now()) / 1000);
  if (remainingSeconds <= 0) return new Response('Not found', { status: 404 });

  const file = record.uploadedFiles?.[relativePath];
  if (!file?.key) return new Response('Not found', { status: 404 });
  const range = await requestedRange(request, file, bucket);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${file.size}` },
    });
  }
  const object = await bucket.get(
    file.key,
    range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined
  );
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  // Revalidate every use so `serve --stop` takes effect immediately. ETags keep
  // unchanged snapshots cheap while avoiding stale browser/CDN copies after
  // the backing record and object prefix are revoked.
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  headers.set(
    'content-security-policy',
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'none'"
  );
  if (request.headers.get('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  const body = request.method === 'HEAD' ? null : object.body;
  if (!range) {
    headers.set('content-length', String(object.size));
    return new Response(body, { status: 200, headers });
  }
  headers.set('content-length', String(range.end - range.start + 1));
  headers.set('content-range', `bytes ${range.start}-${range.end}/${object.size}`);
  return new Response(body, { status: 206, headers });
}

/**
 * The range to serve, against the size recorded at upload. `If-Range` keeps
 * the range only when it strongly matches the object's current ETag;
 * anything else (a date, a weak or stale tag) means "send it all".
 */
async function requestedRange(
  request: Request,
  file: { key: string; size: number },
  bucket: R2Bucket
): Promise<ByteRange | 'unsatisfiable' | null> {
  const range = parseByteRange(request.headers.get('range'), file.size);
  if (range === null) return null;
  const ifRange = request.headers.get('if-range');
  if (ifRange === null) return range;
  const head = await bucket.head(file.key);
  return head && ifRange === head.httpEtag ? range : null;
}
