/**
 * Preview lifecycle helpers extracted from SessionTrayDurableObject.
 *
 * Every function accepts explicit dependencies instead of reaching into
 * `this`, so the durable object class keeps thin delegation wrappers.
 */

import { jsonResponse, type PreviewRecord } from './shared.js';

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

/**
 * One chunk of a leader's preview.response. Mirrors LeaderPreviewResponseOk |
 * LeaderPreviewResponseError from `@slicc/shared-ts` (tray-signaling) — kept as a single shape
 * so the assembler can route by `ok` without re-narrowing the discriminator.
 */
export interface PreviewResponseChunk {
  type: 'preview.response';
  reqId: string;
  ok: boolean;
  status?: number;
  mime?: string;
  encoding?: 'utf-8' | 'base64';
  chunkIndex?: number;
  totalChunks?: number;
  content?: string;
  reason?: string;
}

export type AssemblerResult =
  | { ok: true; mime: string; encoding: 'utf-8' | 'base64'; content: string }
  | { ok: false; status: number; reason?: string };

// ────────────────────────────────────────────────────────────────────────
// PreviewAssembler — reassembles chunked preview.response messages
// ────────────────────────────────────────────────────────────────────────

export class PreviewAssembler {
  private readonly chunks = new Map<number, string>();
  private resolveFn!: (result: AssemblerResult) => void;
  readonly done: Promise<AssemblerResult>;

  constructor() {
    this.done = new Promise<AssemblerResult>((r) => {
      this.resolveFn = r;
    });
  }

  push(chunk: PreviewResponseChunk): void {
    if (!chunk.ok) {
      this.resolveFn({
        ok: false,
        status: chunk.status ?? 500,
        reason: chunk.reason,
      });
      return;
    }
    const total = chunk.totalChunks ?? 1;
    const idx = chunk.chunkIndex ?? 0;
    this.chunks.set(idx, chunk.content ?? '');
    if (this.chunks.size === total) {
      let assembled = '';
      for (let i = 0; i < total; i++) {
        assembled += this.chunks.get(i) ?? '';
      }
      this.resolveFn({
        ok: true,
        mime: chunk.mime ?? 'application/octet-stream',
        encoding: chunk.encoding ?? 'utf-8',
        content: assembled,
      });
    }
  }

  fail(status: number, reason?: string): void {
    this.resolveFn({ ok: false, status, reason });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Dependency injection interfaces
// ────────────────────────────────────────────────────────────────────────

interface TrayState {
  controllerToken: string;
  previews?: Record<string, PreviewRecord>;
  trayId: string;
  expiredAt?: string;
}

export interface PreviewDeps {
  loadTray(): Promise<void>;
  getTray(): TrayState | null;
  persistTray(): Promise<void>;
  isoNow(): string;
  hasLiveLeader(): boolean;
  sendToLeader(message: unknown): boolean;
  matchesToken(received: string, expected: string): boolean;
  pendingPreviews: Map<string, PreviewAssembler>;
}

// ────────────────────────────────────────────────────────────────────────
// Leader-message helpers (called from handleLeaderMessage)
// ────────────────────────────────────────────────────────────────────────

/** Push a preview.response chunk to the matching assembler. No-op for unknown reqIds. */
export function pushPreviewResponseChunk(
  pendingPreviews: Map<string, PreviewAssembler>,
  message: PreviewResponseChunk
): void {
  const assembler = pendingPreviews.get(message.reqId);
  if (assembler) {
    assembler.push(message);
  }
}

/** Fail all in-flight preview fetches (leader disconnected). */
export function failAllPendingPreviews(pendingPreviews: Map<string, PreviewAssembler>): void {
  for (const assembler of pendingPreviews.values()) {
    assembler.fail(502, 'leader disconnected');
  }
  pendingPreviews.clear();
}

/** Bump cacheVersion on the matching preview so the worker cache key changes. */
export async function handlePreviewPurge(previewToken: string, deps: PreviewDeps): Promise<void> {
  await deps.loadTray();
  const tray = deps.getTray();
  const rec = tray?.previews?.[previewToken];
  if (!rec) return;
  rec.cacheVersion = (rec.cacheVersion ?? 1) + 1;
  await deps.persistTray();
}

// ────────────────────────────────────────────────────────────────────────
// Route dispatcher
// ────────────────────────────────────────────────────────────────────────

/**
 * Dispatch a `/internal/preview/*` request. Returns `null` when no preview
 * route matches so the caller can fall through to normal routes.
 */
export async function dispatchPreviewRoute(
  url: URL,
  request: Request,
  deps: PreviewDeps
): Promise<Response | null> {
  const { pathname } = url;
  const { method } = request;

  if (pathname === '/internal/preview/mint' && method === 'POST') {
    return handlePreviewMint(request, deps);
  }
  if (pathname === '/internal/preview/stop' && method === 'POST') {
    return handlePreviewStop(request, deps);
  }
  if (pathname === '/internal/preview/list' && method === 'GET') {
    return handlePreviewList(request, deps);
  }
  if (pathname === '/internal/preview/resolve' && method === 'GET') {
    return handlePreviewResolve(url, deps);
  }
  if (pathname === '/internal/preview/fetch' && method === 'POST') {
    return handlePreviewFetch(request, deps);
  }
  if (pathname === '/internal/preview/emit' && method === 'POST') {
    return handlePreviewEmit(request, deps);
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Per-route handlers
// ────────────────────────────────────────────────────────────────────────

async function handlePreviewMint(request: Request, deps: PreviewDeps): Promise<Response> {
  const body = (await request.json()) as {
    controllerToken: string;
    servedRoot: string;
    entryPath: string;
    allowLive: boolean;
    workerBaseUrl: string;
    bridge?: boolean;
    maxTabs?: number;
    webhookId?: string;
  };
  await deps.loadTray();
  const tray = deps.getTray();
  if (!tray) {
    return jsonResponse({ error: 'Not found', code: 'TRAY_NOT_INITIALIZED' }, 404);
  }
  try {
    const result = await mintPreview(body, deps);
    return jsonResponse(result, 200);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 403;
    const code = (err as { code?: string }).code;
    return jsonResponse({ error: (err as Error).message, ...(code ? { code } : {}) }, status);
  }
}

async function handlePreviewStop(request: Request, deps: PreviewDeps): Promise<Response> {
  const body = (await request.json()) as {
    controllerToken: string;
    previewToken: string;
  };
  await deps.loadTray();
  const tray = deps.getTray();
  if (!tray) {
    return jsonResponse({ error: 'Not found', code: 'TRAY_NOT_INITIALIZED' }, 404);
  }
  if (!deps.matchesToken(body.controllerToken, tray.controllerToken)) {
    return jsonResponse({ error: 'Invalid controller capability' }, 403);
  }
  const result = await revokePreview(body.previewToken, deps);
  return jsonResponse(result, 200);
}

async function handlePreviewList(request: Request, deps: PreviewDeps): Promise<Response> {
  const controllerToken = request.headers.get('x-controller-token') ?? '';
  await deps.loadTray();
  const tray = deps.getTray();
  if (!tray) {
    return jsonResponse({ error: 'Not found', code: 'TRAY_NOT_INITIALIZED' }, 404);
  }
  if (!deps.matchesToken(controllerToken, tray.controllerToken)) {
    return jsonResponse({ error: 'Invalid controller capability' }, 403);
  }
  return jsonResponse({ previews: await listPreviews(deps) }, 200);
}

async function handlePreviewResolve(url: URL, deps: PreviewDeps): Promise<Response> {
  const token = url.searchParams.get('token') ?? '';
  await deps.loadTray();
  const tray = deps.getTray();
  if (!tray) {
    return jsonResponse({ error: 'Not found', code: 'TRAY_NOT_INITIALIZED' }, 404);
  }
  const rec = await resolvePreview(token, deps);
  if (!rec) {
    return jsonResponse({ error: 'Not found' }, 404);
  }
  return jsonResponse(rec, 200);
}

async function handlePreviewFetch(request: Request, deps: PreviewDeps): Promise<Response> {
  await deps.loadTray();
  if (!deps.getTray()) {
    return jsonResponse({ error: 'Not found', code: 'TRAY_NOT_INITIALIZED' }, 404);
  }
  let body: {
    reqId: string;
    servedRoot: string;
    vfsPath: string;
    asText: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  const assembler = new PreviewAssembler();
  deps.pendingPreviews.set(body.reqId, assembler);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const sent = deps.sendToLeader({
      type: 'preview.request',
      reqId: body.reqId,
      servedRoot: body.servedRoot,
      vfsPath: body.vfsPath,
      asText: body.asText,
    });
    if (!sent) {
      return new Response('Bad gateway: leader disconnected', {
        status: 502,
      });
    }
    const timeoutPromise = new Promise<AssemblerResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, status: 504, reason: 'leader timeout' }),
        30_000
      );
    });
    const result = await Promise.race([assembler.done, timeoutPromise]);
    if (!result.ok) {
      return new Response(result.reason ?? 'error', {
        status: result.status,
      });
    }
    const responseBody =
      result.encoding === 'base64'
        ? Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0))
        : result.content;
    return new Response(responseBody, {
      status: 200,
      headers: {
        'content-type': result.mime,
        'cache-control': 'no-store',
        // ponytail: served pages may need arbitrary third-party resources
        // (CDN scripts/fonts/APIs); frame-ancestors stays 'none' — that's
        // about framing THIS preview elsewhere, unrelated to what it loads.
        'content-security-policy':
          "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'none'",
      },
    });
  } finally {
    if (timer) clearTimeout(timer);
    deps.pendingPreviews.delete(body.reqId);
  }
}

async function handlePreviewEmit(request: Request, deps: PreviewDeps): Promise<Response> {
  await deps.loadTray();
  if (!deps.getTray()) {
    return jsonResponse({ error: 'Not found', code: 'TRAY_NOT_INITIALIZED' }, 404);
  }
  let body: { previewToken: string; body: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  const record = await resolvePreview(body.previewToken, deps);
  if (!record) {
    return jsonResponse({ error: 'Preview not found' }, 404);
  }
  if (!record.webhookId) {
    return jsonResponse({ error: 'Preview has no webhookId' }, 400);
  }
  if (!deps.hasLiveLeader()) {
    return jsonResponse({ error: 'No live leader', code: 'NO_LIVE_LEADER' }, 410);
  }
  // The bootstrap sends `window.slicc.emit(name, detail)` as a JSON string via
  // sendBeacon (a raw request body). Parse it so the cone's webhook lick carries
  // the `{ name, detail }` object rather than a stringified blob; fall back to the
  // raw value if it isn't valid JSON (or was already an object, e.g. in tests).
  let emitBody: unknown = body.body;
  if (typeof emitBody === 'string') {
    try {
      emitBody = JSON.parse(emitBody);
    } catch {
      // keep the raw string
    }
  }
  const sent = deps.sendToLeader({
    type: 'webhook.event',
    webhookId: record.webhookId,
    headers: {},
    body: emitBody,
    timestamp: deps.isoNow(),
  });
  if (!sent) {
    return jsonResponse({ error: 'Failed to send to leader' }, 502);
  }
  return jsonResponse({ ok: true }, 200);
}

// ────────────────────────────────────────────────────────────────────────
// CRUD operations
// ────────────────────────────────────────────────────────────────────────

const MAX_PREVIEWS_PER_TRAY = 10;

// Both are normalized absolute VFS paths and entryPath is guaranteed to be a
// descendant of servedRoot (serve-command.ts's isSafeServeEntry rejects
// absolute/`..` entries before joining them under the directory). Serving
// the entry at its real relative path — instead of always at `/` — keeps
// relative links inside the entry HTML resolving the same way they would
// under `open`, matching preview-handler.ts's joinUnderRoot resolution for
// every other path.
function entryRelativeUrlPath(servedRoot: string, entryPath: string): string {
  if (servedRoot === '/') return entryPath;
  return entryPath.slice(servedRoot.length) || '/';
}

export async function mintPreview(
  req: {
    controllerToken: string;
    servedRoot: string;
    entryPath: string;
    allowLive: boolean;
    workerBaseUrl: string;
    bridge?: boolean;
    maxTabs?: number;
    webhookId?: string;
    userHash?: string;
  },
  deps: PreviewDeps
): Promise<{ previewToken: string; url: string }> {
  await deps.loadTray();
  const tray = deps.getTray();
  if (!tray) {
    throw new Error('Tray not loaded');
  }

  if (!deps.matchesToken(req.controllerToken, tray.controllerToken)) {
    throw new Error('Invalid controller capability');
  }

  const { createCapabilityToken } = await import('./shared.js');
  const { buildPreviewUrl } = await import('@slicc/shared-ts');

  const previewToken = createCapabilityToken(tray.trayId, 10);
  const record: PreviewRecord = {
    previewToken,
    trayId: tray.trayId,
    servedRoot: req.servedRoot,
    entryPath: req.entryPath,
    allowLive: req.allowLive,
    createdAt: deps.isoNow(),
    cacheVersion: 1,
    bridge: req.bridge ?? false,
    maxTabs: req.maxTabs ?? 20,
    webhookId: req.webhookId,
    userHash: req.userHash,
  };

  tray.previews ??= {};
  if (Object.keys(tray.previews).length >= MAX_PREVIEWS_PER_TRAY) {
    throw Object.assign(new Error('Preview limit reached'), {
      code: 'PREVIEW_LIMIT',
      status: 429,
    });
  }
  tray.previews[previewToken] = record;
  await deps.persistTray();

  const url = buildPreviewUrl(
    req.workerBaseUrl,
    previewToken,
    entryRelativeUrlPath(req.servedRoot, req.entryPath),
    req.userHash
  );
  return { previewToken, url };
}

export async function resolvePreview(
  previewToken: string,
  deps: PreviewDeps
): Promise<PreviewRecord | null> {
  await deps.loadTray();
  const tray = deps.getTray();
  if (!tray || tray.expiredAt) return null;
  return tray.previews?.[previewToken] ?? null;
}

export async function revokePreview(
  previewToken: string,
  deps: PreviewDeps
): Promise<{ revoked: boolean; webhookId?: string }> {
  await deps.loadTray();
  const tray = deps.getTray();
  if (!tray) {
    throw new Error('Tray not loaded');
  }
  if (!tray.previews?.[previewToken]) return { revoked: false };
  const webhookId = tray.previews[previewToken].webhookId;
  delete tray.previews[previewToken];
  await deps.persistTray();

  deps.sendToLeader({ type: 'preview.revoked', previewToken });
  return { revoked: true, webhookId };
}

export async function listPreviews(deps: PreviewDeps): Promise<PreviewRecord[]> {
  await deps.loadTray();
  const tray = deps.getTray();
  if (!tray || tray.expiredAt) return [];
  return Object.values(tray.previews ?? {});
}
