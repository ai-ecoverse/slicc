// Worker-side HTTP routes for the unified-preview mint/revoke/list API.
//
// Public surface (handleWorkerRequest in `index.ts` matches these paths):
//   POST /api/tray/:trayId/preview       — mint a preview token (Bearer = controllerToken)
//   POST /api/tray/:trayId/preview/stop  — revoke a preview token
//   GET  /api/tray/:trayId/previews      — list active preview records
//
// These handlers extract the bearer, derive workerBaseUrl from the request URL,
// then forward to the `SessionTrayDurableObject` via the DO stub's `fetch()` —
// the DO is a plain class whose only production surface is `fetch(request)`.
// See session-tray.ts dispatcher for the matching `/internal/preview/...` branches.

import {
  MAX_PREVIEW_FILE_BYTES,
  normalizePreviewArchivePath,
} from './persistent-preview-storage.js';
import { jsonResponse } from './shared.js';

interface TrayStub {
  fetch(request: Request): Promise<Response>;
}

export function extractBearer(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

class PreviewUploadTooLargeError extends Error {}
class PreviewUploadTimeoutError extends Error {}

async function withPreviewDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PreviewUploadTimeoutError()), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readPreviewUploadBody(request: Request): Promise<ArrayBuffer> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  try {
    return await withPreviewDeadline(collectPreviewUploadBody(reader));
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
}

async function collectPreviewUploadBody(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PREVIEW_FILE_BYTES) {
      throw new PreviewUploadTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export async function handlePreviewMint(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  let body: {
    servedRoot: string;
    entryPath: string;
    allowLive: boolean;
    bridge?: boolean;
    maxTabs?: number;
    webhookId?: string;
    userHash?: string;
    quiet?: boolean;
    ttlMs?: number;
  };
  try {
    body = (await request.json()) as {
      servedRoot: string;
      entryPath: string;
      allowLive: boolean;
      bridge?: boolean;
      maxTabs?: number;
      webhookId?: string;
      userHash?: string;
      quiet?: boolean;
      ttlMs?: number;
    };
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  if (body.userHash !== undefined && !/^[0-9a-f]{8}$/.test(body.userHash)) {
    return jsonResponse({ error: 'invalid userHash (expected 8 lowercase hex chars)' }, 400);
  }
  const url = new URL(request.url);
  const workerBaseUrl = `${url.protocol}//${url.host}`;
  return trayStub.fetch(
    new Request('https://internal/internal/preview/mint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        controllerToken,
        servedRoot: body.servedRoot,
        entryPath: body.entryPath,
        allowLive: body.allowLive,
        bridge: body.bridge,
        maxTabs: body.maxTabs,
        webhookId: body.webhookId,
        userHash: body.userHash,
        quiet: body.quiet,
        ttlMs: body.ttlMs,
        workerBaseUrl,
      }),
    })
  );
}

export async function handlePreviewUpload(
  request: Request,
  trayStub: TrayStub,
  bucket: R2Bucket,
  previewToken: string
): Promise<Response> {
  const uploadToken = extractBearer(request);
  if (!uploadToken) return jsonResponse({ error: 'unauthorized' }, 401);
  const relativePath = normalizePreviewArchivePath(
    new URL(request.url).searchParams.get('path') ?? ''
  );
  if (!relativePath) return jsonResponse({ error: 'invalid preview file path' }, 400);
  const contentLengthHeader = request.headers.get('content-length');
  const declaredSize = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (
    contentLengthHeader !== null &&
    (!/^[0-9]+$/.test(contentLengthHeader) || !Number.isSafeInteger(declaredSize))
  ) {
    return jsonResponse({ error: 'invalid content-length' }, 400);
  }
  if (declaredSize !== null && declaredSize > MAX_PREVIEW_FILE_BYTES) {
    return jsonResponse({ error: 'preview file exceeds 25 MiB limit' }, 413);
  }
  const uploadBody: {
    previewToken: string;
    uploadToken: string;
    relativePath: string;
    size: number;
    mime?: string;
    etag?: string;
    objectKey?: string;
    sha256?: string;
    allowReplay: boolean;
  } = { previewToken, uploadToken, relativePath, size: declaredSize ?? 0, allowReplay: true };
  let authorized: Response;
  try {
    authorized = await withPreviewDeadline(
      trayStub.fetch(
        new Request('https://internal/internal/preview/upload-authorize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(uploadBody),
        })
      )
    );
  } catch {
    // The owner may have leased a key before the response disappeared.
    return jsonResponse({ error: 'Upload authorization unavailable; retry the same file' }, 503);
  }
  if (!authorized.ok) return authorized;
  const { objectKey, uploaded, leased } = (await authorized.json()) as {
    objectKey: string;
    uploaded?: { size: number; mime: string; sha256?: string };
    leased?: boolean;
  };
  const release = () => releasePreviewUpload(trayStub, previewToken, objectKey, leased);
  let bytes: ArrayBuffer;
  try {
    request.signal.throwIfAborted();
    bytes = await readPreviewUploadBody(request);
    request.signal.throwIfAborted();
  } catch (err) {
    await release(); // No R2 write was started.
    return previewUploadBodyError(err);
  }
  if (declaredSize !== null && bytes.byteLength !== declaredSize) {
    await release();
    return jsonResponse({ error: 'content-length does not match upload body' }, 400);
  }
  uploadBody.size = bytes.byteLength;
  uploadBody.sha256 = await previewUploadHash(bytes);
  uploadBody.mime = request.headers.get('content-type') ?? 'application/octet-stream';
  if (uploaded) {
    // Reconcile a committed-but-unacknowledged upload before writing anything.
    // Never overwrite or delete the canonical object on a mismatching replay.
    return reconcilePreviewUpload(bucket, objectKey, uploaded, uploadBody);
  }
  const key = objectKey;
  try {
    const object = await withPreviewDeadline(
      bucket.put(key, bytes, {
        httpMetadata: {
          contentType: request.headers.get('content-type') ?? 'application/octet-stream',
        },
      })
    );
    uploadBody.mime = request.headers.get('content-type') ?? 'application/octet-stream';
    uploadBody.etag = object.etag;
    uploadBody.objectKey = objectKey;
  } catch {
    // Rejection/timeout can be an ambiguous R2 outcome. Do not release: lease
    // expiry reclaims concurrency, prefix sweeps/lifecycle reclaim late bytes.
    return jsonResponse({ error: 'persistent preview upload failed' }, 502);
  }
  let committed: Response;
  try {
    committed = await withPreviewDeadline(
      trayStub.fetch(
        new Request('https://internal/internal/preview/upload-commit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(uploadBody),
        })
      )
    );
  } catch {
    return jsonResponse({ error: 'Upload outcome unknown; retry the same file' }, 503);
  } finally {
    // R2 put resolved before commit began. Even if the commit outcome is
    // unknown, there is now no future writer behind this lease.
    await release();
  }
  return previewUploadCommitResponse(committed, bucket, key);
}

function previewUploadBodyError(error: unknown): Response {
  if (error instanceof PreviewUploadTooLargeError) {
    return jsonResponse({ error: 'preview file exceeds 25 MiB limit' }, 413);
  }
  if (error instanceof PreviewUploadTimeoutError) {
    return jsonResponse({ error: 'preview upload body timed out' }, 408);
  }
  return jsonResponse({ error: 'invalid upload body' }, 400);
}

async function releasePreviewUpload(
  trayStub: TrayStub,
  previewToken: string,
  objectKey: string,
  leased?: boolean
): Promise<void> {
  if (!leased) return;
  // Failure leaves a bounded lease/tombstone, not an unowned R2 prefix.
  await withPreviewDeadline(
    trayStub.fetch(
      new Request('https://internal/internal/preview/upload-release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewToken, objectKey }),
      })
    )
  ).catch(() => {});
}

async function previewUploadCommitResponse(
  committed: Response,
  bucket: R2Bucket,
  key: string
): Promise<Response> {
  if (!committed.ok) {
    // A 5xx/timeout may follow a successful durable commit. Keep its bytes;
    // replay reconciles by digest, and the owner's archive-prefix expiry
    // cleanup bounds orphan lifetime if no commit was actually stored.
    if (committed.status >= 400 && committed.status < 500) {
      await withPreviewDeadline(bucket.delete(key)).catch(() => {});
    }
    return committed;
  }
  return new Response(null, { status: 204 });
}

async function previewUploadHash(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function reconcilePreviewUpload(
  bucket: R2Bucket,
  key: string,
  uploaded: { size: number; mime: string; sha256?: string },
  incoming: { size: number; mime?: string; sha256?: string }
): Promise<Response> {
  if (uploaded.size !== incoming.size || uploaded.mime !== incoming.mime) {
    return jsonResponse({ error: 'Upload replay does not match the original file' }, 409);
  }
  let hash = uploaded.sha256;
  if (!hash) {
    // Records minted before digest support remain immutable too.
    try {
      const object = await bucket.get(key);
      if (!object) return jsonResponse({ error: 'Original upload is unavailable' }, 503);
      hash = await previewUploadHash(await new Response(object.body).arrayBuffer());
    } catch {
      return jsonResponse({ error: 'Original upload is unavailable' }, 503);
    }
  }
  return hash === incoming.sha256
    ? new Response(null, { status: 204 })
    : jsonResponse({ error: 'Upload replay does not match the original file' }, 409);
}

export async function handlePreviewFinalize(
  request: Request,
  trayStub: TrayStub,
  previewToken: string
): Promise<Response> {
  const uploadToken = extractBearer(request);
  if (!uploadToken) return jsonResponse({ error: 'unauthorized' }, 401);
  return trayStub.fetch(
    new Request('https://internal/internal/preview/finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previewToken, uploadToken }),
    })
  );
}

export async function handlePreviewStop(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  let body: { previewToken: string };
  try {
    body = (await request.json()) as { previewToken: string };
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  return trayStub.fetch(
    new Request('https://internal/internal/preview/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        controllerToken,
        previewToken: body.previewToken,
      }),
    })
  );
}

export async function handlePreviewList(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  return trayStub.fetch(
    new Request('https://internal/internal/preview/list', {
      method: 'GET',
      headers: { 'x-controller-token': controllerToken },
    })
  );
}

/**
 * `POST /api/tray/:trayId/supersede` — Bearer = the OLD tray's controllerToken.
 * Called by the leader right before it abandons this tray for a freshly-minted
 * one (see `shouldRecreateTray` in the webapp's `tray-leader.ts`), so a follower
 * still holding the old `/join/:token` link gets redirected instead of dead-ending.
 */
export async function handleTraySupersede(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  let body: { joinUrl?: string; webhookUrl?: string };
  try {
    body = (await request.json()) as { joinUrl?: string; webhookUrl?: string };
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  return trayStub.fetch(
    new Request('https://internal/internal/supersede', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `webhookUrl` lets the old tray redirect webhook deliveries too, not just
      // joins — an external service's cached callback URL embeds the tray id and
      // dies with the tray otherwise (#1957).
      body: JSON.stringify({ controllerToken, joinUrl: body.joinUrl, webhookUrl: body.webhookUrl }),
    })
  );
}
