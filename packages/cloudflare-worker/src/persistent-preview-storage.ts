import type { PreviewRecord } from './shared.js';

export const PREVIEW_ARCHIVE_PREFIX = 'previews/';
export const MAX_PREVIEW_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PREVIEW_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_PREVIEW_FILES = 1_000;
export const MAX_PREVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

  const objectKey = record.uploadedFiles?.[relativePath]?.key;
  if (!objectKey) return new Response('Not found', { status: 404 });
  const object = await bucket.get(objectKey);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('content-length', String(object.size));
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
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}
