/**
 * HostFsMountBackend — configured host-folder mounts over the local bridge.
 *
 * Backed by the launcher's `/api/hostfs` surface (node-server `hostfs.ts`,
 * swift-server `HostFSRoutes.swift`), which serves exactly the OS folders
 * named in the mount table (`--mount=<os-path>:<slicc-path>`, or Sliccstart's
 * Settings → Mounts). Because the server owns the OS access, these mounts
 * need no File System Access handle, no picker, and no Chrome permission —
 * they are mounted fully automatically at kernel boot (`host.ts` →
 * `mountConfiguredHostMounts`) and are NOT persisted to the mount table
 * store: the launcher config is their single source of truth on every boot.
 *
 * Requests address the mount by its SLICC target (`/mnt/project`) plus a
 * mount-relative path; the server refuses anything outside the mapped root
 * (traversal, symlink escapes). There is no client-side cache: the bridge is
 * loopback-fast and host files can change under us at any time, so every
 * operation is a live passthrough — which also means external edits are
 * visible immediately, unlike picker mounts.
 *
 * ## Why the metadata ops POST to one URL
 *
 * The bridge token rides as a custom `X-Bridge-Token` header, so every
 * cross-origin hostfs call is a non-simple CORS request; Chrome's Private
 * Network Access additionally preflights public→loopback traffic. A
 * preflight is unavoidable — but the preflight cache is keyed by URL, and
 * the per-op routes put the path in the query string, so every request hit a
 * fresh URL and `Access-Control-Max-Age` never applied (issue #2715:
 * 246,893 `OPTIONS` for 385,033 `GET`s in one benchmark session).
 *
 * `list`/`stat`/`mkdir`/`rename`/`remove` therefore go to the single stable
 * `POST /api/hostfs` with the parameters in a JSON body: one preflight per
 * max-age window covers all of them. `read` deliberately keeps its per-file
 * `GET` — a POST response is not cacheable, and the browser HTTP cache
 * revalidating big blobs with a 304 is worth far more than its preflight
 * (and that URL repeats, so the preflight cache does work for it). `write`
 * keeps its `PUT` for the same reason in reverse: raw bytes, and it repeats
 * against the same path (e.g. `.git/index`).
 *
 * `readFileRange` sends a `Range` header on that same `GET` and expects a 206.
 * It is the only way to touch a file bigger than `HOSTFS_MAX_BODY_BYTES` —
 * without it a repo whose largest packfile crosses the cap is unreadable by
 * git, and every pack under it still costs its full size in worker memory on
 * each object lookup (issue #2711).
 *
 * A bridge without the stable route (an older node-server binary behind a
 * freshly-updated hosted UI) answers with a framework 404 that carries no
 * `{ code }`; that is the signal to fall back to the per-op routes for the
 * rest of this backend's life. The cost is one wasted request — or one per
 * op already in flight when the first 404 lands, which self-heals.
 *
 * ## Why one dropped fetch must not kill the command
 *
 * A local bridge still loses the occasional request: Node's default 5 s
 * `keepAliveTimeout` closes a pooled socket the browser is about to reuse and
 * the `fetch()` rejects with `TypeError: Failed to fetch` (issue #2720 —
 * `git status` died twice at ~6,000 requests against a healthy bridge). So
 * every op runs through `attemptRequest`: network-level rejections — from the
 * fetch OR from reading the body — are retried for the idempotent ops, and
 * the requests are held to `maxInflight` so a fan-out cannot queue thousands
 * of fetches into a 6-socket pool. The server side is
 * `packages/node-server/src/http-keepalive.ts`.
 */

import { apiHeaders, resolveApiUrl } from '../../base/api-endpoint.js';
import { FsError, type FsErrorCode } from '../types.js';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  MountStatIdentity,
  RefreshReport,
} from './backend.js';
import { createInflightLimiter, type InflightLimiter } from './inflight-limiter.js';

/**
 * Matches the server-side cap (node-server `HOSTFS_MAX_BODY_BYTES`). It bounds
 * a WHOLE-file `readFile`/`writeFile`, where the caller holds the entire body
 * in worker memory. `readFileRange` is bounded by the window it asks for
 * instead, so it can reach into a file larger than this — that is what makes a
 * repo with a packfile over the cap readable at all (issue #2711).
 */
const HOSTFS_MAX_BODY_BYTES = 100 * 1024 * 1024;

/**
 * Ops routed through the stable `POST /api/hostfs` endpoint so their CORS
 * preflight is cached for the whole `Access-Control-Max-Age` window. `read`
 * and `write` stay on their per-op routes — see the module doc.
 */
const STABLE_OPS: ReadonlySet<string> = new Set(['list', 'stat', 'mkdir', 'rename', 'remove']);

/** The one URL every stable-endpoint op shares. */
const HOSTFS_STABLE_PATH = '/api/hostfs';

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'EEXIST',
  'ENOTDIR',
  'EISDIR',
  'ENOTEMPTY',
  'EINVAL',
  'EACCES',
  'ELOOP',
  'EBUSY',
  'EFBIG',
  'EBADF',
  'EIO',
]);

/**
 * Ops whose server handler is idempotent, so replaying one after a
 * network-level failure cannot change the outcome: the three read ops, plus
 * `mkdir` (node-server / swift-server both create with `recursive: true`, so a
 * replay never reports EEXIST). `write`, `rename` and `remove` are deliberately
 * absent — `remove` is served with `force: false` (a replay of a request that
 * did land turns into a spurious ENOENT) and a replayed `write`/`rename` can
 * clobber a concurrent change; those still surface EIO on the first failure.
 */
const RETRYABLE_OPS: ReadonlySet<string> = new Set(['list', 'stat', 'read', 'mkdir']);

/**
 * Attempts (not retries) for a retryable op. Two retries cover the keep-alive
 * race — the second attempt opens a fresh socket — without turning a genuinely
 * down bridge into a long stall.
 */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Backoff before retry N (25 ms, 50 ms). Short: the bridge is loopback. */
const DEFAULT_RETRY_BASE_DELAY_MS = 25;

/**
 * Concurrent bridge requests per mount. Chrome allows ~6 sockets per origin,
 * so anything above that is queueing anyway; 24 keeps the pool saturated while
 * bounding how long a queued request can sit next to a closing keep-alive
 * socket. Thousands of queued fetches are what made the race likely.
 */
const DEFAULT_MAX_INFLIGHT = 24;

/**
 * Body consumers. Every op reads its body INSIDE the retried, limiter-held
 * operation — including the ops that ignore the payload, because an undrained
 * body keeps the socket busy after the slot is released.
 */
const readJson = (response: Response): Promise<unknown> => response.json();
const readBytes = (response: Response): Promise<ArrayBuffer> => response.arrayBuffer();
/**
 * A ranged read has to know whether the bridge honored `Range`. A bridge that
 * predates it (or any proxy in between) answers 200 with the WHOLE file, and
 * handing that back as if it were the window would silently give the caller
 * bytes from the wrong offsets, which a pack reader would parse as garbage.
 */
const readRangedBytes = async (
  response: Response
): Promise<{ partial: boolean; body: ArrayBuffer }> => ({
  partial: response.status === 206,
  body: await response.arrayBuffer(),
});
const drainBody = async (response: Response): Promise<void> => {
  await response.arrayBuffer();
};

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * The EIO a caller finally sees when every attempt failed at the network
 * level. It names the op and says the failure is transient, because the old
 * "hostfs bridge unreachable" read as "the launcher is gone" even when the
 * bridge was healthy and a single pooled socket had been closed under us.
 */
function transientBridgeError(
  op: string,
  path: string,
  err: unknown,
  attempts: number,
  retryable: boolean
): FsError {
  const detail = err instanceof Error ? err.message : String(err);
  const tried = retryable
    ? ` after ${attempts} attempt${attempts === 1 ? '' : 's'}`
    : ' (not retried: non-idempotent op)';
  return new FsError('EIO', `hostfs ${op} failed${tried}: transient bridge error: ${detail}`, path);
}

/** Wire shape of the stat identity, before it is validated. */
interface RawStatIdentity {
  ctime?: unknown;
  ino?: unknown;
  uid?: unknown;
  gid?: unknown;
  mode?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Pick the host `stat` identity fields off a bridge payload — the same
 * payload whether it arrived from the stable `POST /api/hostfs` dispatcher or
 * a per-op GET route.
 *
 * The server sends them for every file it could stat (node-server
 * `statIdentity`, swift-server `statIdentity`); an older bridge, or a raced
 * entry the server failed to stat, simply omits them and the consumer keeps
 * its synthesized defaults. Kept permissive on purpose — a partial payload
 * must never make a mount unreadable. See issue #2708.
 */
function readStatIdentity(raw: RawStatIdentity): MountStatIdentity {
  const identity: MountStatIdentity = {};
  const ctime = finiteNumber(raw.ctime);
  if (ctime !== undefined) identity.ctime = ctime;
  const ino = finiteNumber(raw.ino);
  if (ino !== undefined) identity.ino = ino;
  const uid = finiteNumber(raw.uid);
  if (uid !== undefined) identity.uid = uid;
  const gid = finiteNumber(raw.gid);
  if (gid !== undefined) identity.gid = gid;
  const mode = finiteNumber(raw.mode);
  if (mode !== undefined) identity.mode = mode;
  return identity;
}

export interface HostFsMountBackendOptions {
  /** SLICC target path this backend is mounted at, e.g. `/mnt/project`. */
  targetPath: string;
  /** OS folder as reported by the server (display only). */
  hostPath: string;
  mountId?: string;
  /** Injectable for tests; production uses the realm's fetch. */
  fetchImpl?: typeof fetch;
  /** Concurrent bridge requests (default 24). Injectable for tests. */
  maxInflight?: number;
  /** Attempts for an idempotent op (default 3, i.e. two retries). */
  maxAttempts?: number;
  /** Base backoff between attempts in ms (default 25); 0 disables the wait. */
  retryDelayMs?: number;
}

export class HostFsMountBackend implements MountBackend {
  readonly kind = 'hostfs' as const;
  /**
   * Both bridges stat every dirent inside `list` and answer `stat` from the
   * same syscall, so when a listing reports size/mtime those numbers equal
   * what `stat` would return (issue #2716). Presence is always-on for
   * hostfs (stats are free in the listing response). A file the bridge
   * could not stat comes back as a bare `{name, kind}` and is not
   * promoted — see `statsFromDirEntry`.
   */
  readonly listingStatsMatchStat = true;
  readonly source: string;
  readonly mountId: string;

  private readonly targetPath: string;
  private readonly hostPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: InflightLimiter;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private closed = false;
  /**
   * Whether this bridge answers `POST /api/hostfs`. Optimistic: flipped off
   * for the lifetime of the backend the first time the endpoint 404s without
   * an errno `code`, after which every op uses its per-op route.
   */
  private stableEndpoint = true;

  constructor(opts: HostFsMountBackendOptions) {
    this.targetPath = opts.targetPath;
    this.hostPath = opts.hostPath;
    this.source = `hostfs://${opts.hostPath}`;
    this.mountId = opts.mountId ?? crypto.randomUUID();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = createInflightLimiter(opts.maxInflight ?? DEFAULT_MAX_INFLIGHT);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  }

  private assertOpen(path: string): void {
    if (this.closed) throw new FsError('EBADF', 'mount closed', path);
  }

  private url(op: string, path: string, extra?: Record<string, string>): string {
    const params = new URLSearchParams({ mount: this.targetPath, path: path.replace(/^\/+/, '') });
    for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
    return resolveApiUrl(`/api/hostfs/${op}?${params.toString()}`);
  }

  /**
   * Pick the URL + init for one op: the stable POST endpoint when the bridge
   * supports it and the op has no body of its own, else the per-op route.
   * `extra` (rename's `to`, remove's `recursive`) travels as query params on
   * the per-op route and as extra JSON fields on the stable one; the server
   * accepts the string forms either way.
   */
  private buildRequest(
    op: string,
    path: string,
    init?: RequestInit & { extra?: Record<string, string> }
  ): { url: string; init: RequestInit } {
    const headers = apiHeaders(init?.headers as Record<string, string> | undefined);
    if (this.stableEndpoint && STABLE_OPS.has(op)) {
      return {
        url: resolveApiUrl(HOSTFS_STABLE_PATH),
        init: {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            op,
            mount: this.targetPath,
            path: path.replace(/^\/+/, ''),
            ...(init?.extra ?? {}),
          }),
        },
      };
    }
    const { extra: _extra, ...rest } = init ?? {};
    return { url: this.url(op, path, init?.extra), init: { ...rest, headers } };
  }

  /**
   * Execute one bridge request under the in-flight limiter and hand the caller
   * the MATERIALIZED body — `consume` runs inside the guarded operation, so a
   * bridge drop while the body is streaming is a network failure like any
   * other: retried for the idempotent ops, otherwise mapped to a transient
   * EIO. Returning the raw `Response` would leak both (a mid-body `TypeError`
   * would escape unmapped, and a slow body would hold a socket the limiter
   * had already counted as free).
   *
   * Non-2xx responses carry `{ code, message }` and are rethrown as a faithful
   * FsError; envelope failures surface as EIO so callers can distinguish
   * "file missing" from "bridge missing" — but only after the retries, because
   * the common case is a single transient `Failed to fetch` in a fan-out.
   */
  private async request<T>(
    op: string,
    path: string,
    consume: (response: Response) => Promise<T>,
    init?: RequestInit & { extra?: Record<string, string> }
  ): Promise<T> {
    this.assertOpen(path);
    return this.limiter.run(() => this.attemptRequest(op, path, consume, init));
  }

  /**
   * Fetch (and read the body) with bounded retries. Only *rejections* — from
   * the fetch or from reading the body — are retried, and only for the
   * idempotent ops in `RETRYABLE_OPS`: an HTTP error is an answer from the
   * server and is mapped straight through.
   */
  private async attemptRequest<T>(
    op: string,
    path: string,
    consume: (response: Response) => Promise<T>,
    init?: RequestInit & { extra?: Record<string, string> }
  ): Promise<T> {
    const maxAttempts = RETRYABLE_OPS.has(op) ? this.maxAttempts : 1;
    let attempt = 0;
    let lastErr: unknown;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await this.routeAndConsume(op, path, consume, init);
      } catch (err) {
        if (err instanceof FsError) throw err;
        lastErr = err;
        if (this.closed) break;
        if (attempt < maxAttempts) await sleep(this.retryDelayMs * attempt);
      }
    }
    throw transientBridgeError(op, path, lastErr, attempt, maxAttempts > 1);
  }

  /**
   * One routed attempt: build → fetch → consume. A stable-endpoint downgrade
   * re-enters HERE rather than in `attemptRequest`, because switching routes
   * is a routing correction, not a transient failure — it must not spend one
   * of the retry attempts. It still runs inside the caller's attempt, so a
   * network failure on the per-op route is mapped and retried normally.
   * Recursion is bounded: the downgrade clears `stableEndpoint`, so the
   * re-entered call cannot take the stable branch again.
   */
  private async routeAndConsume<T>(
    op: string,
    path: string,
    consume: (response: Response) => Promise<T>,
    init?: RequestInit & { extra?: Record<string, string> }
  ): Promise<T> {
    const usedStableEndpoint = this.stableEndpoint && STABLE_OPS.has(op);
    const plan = this.buildRequest(op, path, init);
    const response = await this.fetchImpl(plan.url, plan.init);
    if (response.ok) return await consume(response);

    const { error, rawCode } = await this.errorFromResponse(op, path, response);
    // A bridge that predates the stable endpoint answers with its
    // framework's 404/405 — no errno `code`. Every error the real route
    // emits carries one, so this is unambiguous: downgrade permanently and
    // retry the same op on its per-op route.
    if (
      usedStableEndpoint &&
      rawCode === null &&
      (response.status === 404 || response.status === 405)
    ) {
      this.stableEndpoint = false;
      return await this.routeAndConsume(op, path, consume, init);
    }
    throw error;
  }

  /**
   * Map a non-2xx bridge response onto its errno FsError, also reporting the
   * raw `code` the body carried (`null` when it had none — the signal that
   * this bridge has no stable endpoint).
   */
  private async errorFromResponse(
    op: string,
    path: string,
    response: Response
  ): Promise<{ error: FsError; rawCode: string | null }> {
    let code: FsErrorCode = 'EIO';
    let rawCode: string | null = null;
    let message = `hostfs ${op} failed with HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof body.code === 'string') {
        rawCode = body.code;
        if (KNOWN_CODES.has(body.code)) code = body.code as FsErrorCode;
      }
      if (typeof body.message === 'string') message = body.message;
    } catch {
      /* non-JSON error body — keep the HTTP-status message */
    }
    return { error: new FsError(code, message, path), rawCode };
  }

  async readDir(path: string): Promise<MountDirEntry[]> {
    const body = (await this.request('list', path, readJson)) as { entries?: unknown };
    if (!Array.isArray(body.entries)) return [];
    const entries: MountDirEntry[] = [];
    for (const raw of body.entries) {
      const e = raw as RawStatIdentity & {
        name?: unknown;
        kind?: unknown;
        size?: unknown;
        lastModified?: unknown;
      };
      if (typeof e.name !== 'string' || (e.kind !== 'file' && e.kind !== 'directory')) continue;
      entries.push({
        name: e.name,
        kind: e.kind,
        ...(typeof e.size === 'number' ? { size: e.size } : {}),
        ...(typeof e.lastModified === 'number' ? { lastModified: e.lastModified } : {}),
        ...readStatIdentity(e),
      });
    }
    return entries;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const buffer = await this.request('read', path, readBytes);
    if (buffer.byteLength > HOSTFS_MAX_BODY_BYTES) {
      throw new FsError('EFBIG', 'file exceeds the hostfs body cap', path);
    }
    return new Uint8Array(buffer);
  }

  /**
   * Read `[start, end)` as one HTTP `Range` request — half-open on the wire's
   * inclusive `bytes=start-(end-1)`.
   *
   * The whole-file cap does not apply to the file, only to the window: the
   * point of this path is to reach into a file too big to hold at once
   * (issue #2711). A bridge that ignores `Range` answers 200 with everything,
   * which is corrected here by slicing rather than by failing — an old
   * launcher behind a fresh hosted UI must stay correct, just not fast.
   */
  async readFileRange(path: string, start: number, end: number): Promise<Uint8Array> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new FsError('EINVAL', `invalid byte range ${start}-${end}`, path);
    }
    if (end === start) return new Uint8Array(0);
    if (end - start > HOSTFS_MAX_BODY_BYTES) {
      throw new FsError('EFBIG', 'byte range exceeds the hostfs body cap', path);
    }
    const { partial, body } = await this.request('read', path, readRangedBytes, {
      headers: { Range: `bytes=${start}-${end - 1}` },
    });
    if (partial) return new Uint8Array(body);
    return new Uint8Array(body).slice(start, end);
  }

  async writeFile(path: string, body: Uint8Array): Promise<void> {
    if (body.byteLength > HOSTFS_MAX_BODY_BYTES) {
      throw new FsError('EFBIG', 'body exceeds the hostfs body cap', path);
    }
    await this.request('write', path, drainBody, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      // Copy into a plain ArrayBuffer-backed view so fetch never sees a
      // SharedArrayBuffer-backed slice (kernel worker buffers can be).
      body: new Uint8Array(body),
    });
  }

  async stat(path: string): Promise<MountStat> {
    const body = (await this.request('stat', path, readJson)) as RawStatIdentity & {
      kind?: unknown;
      size?: unknown;
      mtime?: unknown;
    };
    return {
      kind: body.kind === 'directory' ? 'directory' : 'file',
      size: typeof body.size === 'number' ? body.size : 0,
      mtime: typeof body.mtime === 'number' ? body.mtime : 0,
      ...readStatIdentity(body),
    };
  }

  async mkdir(path: string): Promise<void> {
    await this.request('mkdir', path, drainBody, { method: 'POST' });
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    await this.request('rename', fromPath, drainBody, {
      method: 'POST',
      extra: { to: toPath.replace(/^\/+/, '') },
    });
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.request('remove', path, drainBody, {
      method: 'DELETE',
      extra: opts?.recursive ? { recursive: '1' } : undefined,
    });
  }

  /**
   * Live passthrough — there is no cache to reconcile, every read already
   * sees the host's current state. Reported as all-unchanged.
   */
  async refresh(): Promise<RefreshReport> {
    this.assertOpen(this.targetPath);
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    const displayName = this.hostPath.split('/').filter(Boolean).at(-1) ?? this.hostPath;
    return {
      displayName,
      source: this.source,
      extra: 'configured via mount table (auto-mounted, live host view)',
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Test/internal access. */
  getHostPath(): string {
    return this.hostPath;
  }
}
