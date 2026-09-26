import { apiHeaders, resolveApiUrl } from '../../base/api-endpoint.js';
import { inodeIdentity } from '../stat-identity.js';
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
import type { RemoteMountCache } from './remote-cache.js';
import { RemoteMountCache as RemoteMountCacheImpl } from './remote-cache.js';

const HOSTFS_MAX_BODY_BYTES = 100 * 1024 * 1024;

const STABLE_OPS: ReadonlySet<string> = new Set(['list', 'stat', 'mkdir', 'rename', 'remove']);

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

const RETRYABLE_OPS: ReadonlySet<string> = new Set(['list', 'stat', 'read', 'mkdir']);

const DEFAULT_MAX_ATTEMPTS = 3;

const DEFAULT_RETRY_BASE_DELAY_MS = 25;

const DEFAULT_MAX_INFLIGHT = 24;

const DEFAULT_CACHE_TTL_MS = 30_000;

const DEFAULT_MAX_CACHED_BODY_BYTES = 4 * 1024 * 1024;

const NO_STORE: RequestCache = 'no-store';

export function hostFsMountId(targetPath: string, hostPath: string): string {
  return `hostfs:${encodeURIComponent(targetPath)}:${encodeURIComponent(hostPath)}`;
}

const readJson = (response: Response): Promise<unknown> => response.json();

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

interface RawStatIdentity {
  ctime?: unknown;
  ino?: unknown;
  dev?: unknown;
  uid?: unknown;
  gid?: unknown;
  mode?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStatIdentity(raw: RawStatIdentity): MountStatIdentity {
  const identity: MountStatIdentity = {};
  const ctime = finiteNumber(raw.ctime);
  if (ctime !== undefined) identity.ctime = ctime;
  const ino = finiteNumber(raw.ino);
  if (ino !== undefined) identity.ino = ino;
  const dev = finiteNumber(raw.dev);
  if (dev !== undefined && Number.isSafeInteger(dev) && dev >= 0) {
    identity.dev = dev;
    identity.identity = inodeIdentity(`hostfs:${resolveApiUrl(HOSTFS_STABLE_PATH)}`, ino, dev);
  }
  const uid = finiteNumber(raw.uid);
  if (uid !== undefined) identity.uid = uid;
  const gid = finiteNumber(raw.gid);
  if (gid !== undefined) identity.gid = gid;
  const mode = finiteNumber(raw.mode);
  if (mode !== undefined) identity.mode = mode;
  return identity;
}

export interface HostFsMountBackendOptions {
  targetPath: string;

  hostPath: string;
  mountId?: string;

  cache?: RemoteMountCache;

  cacheTtlMs?: number;

  maxCachedBodyBytes?: number;

  fetchImpl?: typeof fetch;

  maxInflight?: number;

  maxAttempts?: number;

  retryDelayMs?: number;
}

export class HostFsMountBackend implements MountBackend {
  readonly kind = 'hostfs' as const;

  readonly listingStatsMatchStat = true;
  readonly source: string;
  readonly mountId: string;

  private readonly targetPath: string;
  private readonly hostPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: InflightLimiter;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly cache: RemoteMountCache;
  private readonly maxCachedBodyBytes: number;

  private cacheGeneration = 0;
  private closed = false;

  private stableEndpoint = true;

  constructor(opts: HostFsMountBackendOptions) {
    this.targetPath = opts.targetPath;
    this.hostPath = opts.hostPath;
    this.source = `hostfs://${opts.hostPath}`;
    this.mountId = opts.mountId ?? hostFsMountId(opts.targetPath, opts.hostPath);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = createInflightLimiter(opts.maxInflight ?? DEFAULT_MAX_INFLIGHT);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.maxCachedBodyBytes = Math.max(0, opts.maxCachedBodyBytes ?? DEFAULT_MAX_CACHED_BODY_BYTES);
    this.cache =
      opts.cache ??
      new RemoteMountCacheImpl({
        mountId: this.mountId,
        ttlMs: opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      });
  }

  private assertOpen(path: string): void {
    if (this.closed) throw new FsError('EBADF', 'mount closed', path);
  }

  private bodyKey(path: string): string {
    return path.replace(/^\/+/, '');
  }

  private async invalidateCachePrefixes(paths: readonly string[]): Promise<void> {
    this.cacheGeneration += 1;
    await this.cache.invalidatePrefixes(paths);
  }

  private async cacheBodyIfCurrent(
    generation: number,
    path: string,
    body: Uint8Array,
    etag: string
  ): Promise<void> {
    if (generation !== this.cacheGeneration || body.byteLength > this.maxCachedBodyBytes) return;
    await this.cache.putBody(path, body, etag);
    if (generation !== this.cacheGeneration) {
      await this.cache.invalidateBody(path);
    }
  }

  async applyHostInvalidation(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) {
      await this.invalidateCachePrefixes([]);
      return;
    }
    const relativePaths = paths.map((raw) => raw.replace(/^\/+/, ''));
    if (relativePaths.some((rel) => rel.length === 0 || rel === '.')) {
      await this.invalidateCachePrefixes([]);
      return;
    }
    await this.invalidateCachePrefixes(relativePaths);
  }

  getCache(): RemoteMountCache {
    return this.cache;
  }

  private url(op: string, path: string, extra?: Record<string, string>): string {
    const params = new URLSearchParams({ mount: this.targetPath, path: path.replace(/^\/+/, '') });
    for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
    return resolveApiUrl(`/api/hostfs/${op}?${params.toString()}`);
  }

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

  private async request<T>(
    op: string,
    path: string,
    consume: (response: Response) => Promise<T>,
    init?: RequestInit & { extra?: Record<string, string> }
  ): Promise<T> {
    this.assertOpen(path);
    return this.limiter.run(() => this.attemptRequest(op, path, consume, init));
  }

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

  private async routeAndConsume<T>(
    op: string,
    path: string,
    consume: (response: Response) => Promise<T>,
    init?: RequestInit & { extra?: Record<string, string> }
  ): Promise<T> {
    const usedStableEndpoint = this.stableEndpoint && STABLE_OPS.has(op);
    const plan = this.buildRequest(op, path, init);
    const response = await this.fetchImpl(plan.url, plan.init);

    if (response.ok || response.status === 304) return await consume(response);

    const { error, rawCode } = await this.errorFromResponse(op, path, response);

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
    } catch {}
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
    this.assertOpen(path);
    const generation = this.cacheGeneration;
    const rel = this.bodyKey(path);
    const cached = await this.cache.getBody(rel);
    if (cached && !this.cache.isStale(cached.cachedAt)) {
      return cached.body;
    }

    const headers: Record<string, string> = {};
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    const result = await this.request(
      'read',
      path,
      async (response) => {
        if (response.status === 304) return { kind: 'not-modified' as const };
        return {
          kind: 'body' as const,
          bytes: new Uint8Array(await response.arrayBuffer()),
          etag: response.headers.get('etag') ?? '',
        };
      },
      { cache: NO_STORE, headers }
    );

    if (result.kind === 'not-modified') {
      if (!cached) {
        throw new FsError('EIO', 'hostfs read got 304 without a cached body', path);
      }
      await this.cacheBodyIfCurrent(generation, rel, cached.body, cached.etag);
      return cached.body;
    }

    if (result.bytes.byteLength > HOSTFS_MAX_BODY_BYTES) {
      throw new FsError('EFBIG', 'file exceeds the hostfs body cap', path);
    }
    await this.cacheBodyIfCurrent(generation, rel, result.bytes, result.etag);
    return result.bytes;
  }

  async readFileRange(path: string, start: number, end: number): Promise<Uint8Array> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new FsError('EINVAL', `invalid byte range ${start}-${end}`, path);
    }
    if (end === start) return new Uint8Array(0);
    if (end - start > HOSTFS_MAX_BODY_BYTES) {
      throw new FsError('EFBIG', 'byte range exceeds the hostfs body cap', path);
    }
    const { partial, body } = await this.request('read', path, readRangedBytes, {
      cache: NO_STORE,
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

      body: new Uint8Array(body),
    });
    const rel = this.bodyKey(path);
    const generation = ++this.cacheGeneration;

    if (body.byteLength <= this.maxCachedBodyBytes) {
      await this.cacheBodyIfCurrent(generation, rel, new Uint8Array(body), '');
    } else {
      await this.cache.invalidateBody(rel);
    }
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

  async rename(fromPath: string, toPath: string): Promise<{ noop?: boolean }> {
    const body = (await this.request('rename', fromPath, readJson, {
      method: 'POST',
      extra: { to: toPath.replace(/^\/+/, '') },
    })) as { noop?: unknown };
    const fromRel = this.bodyKey(fromPath);
    const toRel = this.bodyKey(toPath);

    await this.invalidateCachePrefixes([fromRel, toRel]);
    return body.noop === true ? { noop: true } : {};
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.request('remove', path, drainBody, {
      method: 'DELETE',
      extra: opts?.recursive ? { recursive: '1' } : undefined,
    });
    const rel = this.bodyKey(path);
    if (opts?.recursive) {
      await this.invalidateCachePrefixes([rel]);
    } else {
      this.cacheGeneration += 1;
      await this.cache.invalidateBody(rel);
    }
  }

  async refresh(opts?: { bodies?: boolean }): Promise<RefreshReport> {
    this.assertOpen(this.targetPath);
    const report: RefreshReport = {
      added: [],
      removed: [],
      changed: [],
      unchanged: 0,
      errors: [],
    };
    const seenFiles = new Set<string>();
    const seenDirs = new Set<string>();
    try {
      const rootStat = await this.stat('');
      const rootId = this.dirIdentity(rootStat, '');
      if (rootId) seenDirs.add(rootId);
    } catch {}
    const stack: string[] = [''];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      try {
        await this.refreshDir(dir, report, stack, seenDirs, seenFiles);
      } catch (err) {
        report.errors.push({
          path: dir || '/',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await this.purgeAbsentBodies(seenFiles, report);
    if (opts?.bodies) await this.refreshBodies(report);
    return report;
  }

  private etagsFromListing(entry: MountDirEntry): string[] | undefined {
    if (
      typeof entry.size !== 'number' ||
      typeof entry.lastModified !== 'number' ||
      typeof entry.ino !== 'number'
    ) {
      return undefined;
    }
    const sizeHex = entry.size.toString(16);
    const inoHex = entry.ino.toString(16);
    const node = `"${sizeHex}-${entry.lastModified.toString(16)}-${inoHex}"`;
    const mtimeMicros = Math.floor(Math.max(0, entry.lastModified * 1000));
    const swift = `"${sizeHex}-${mtimeMicros.toString(16)}-${inoHex}"`;
    return node === swift ? [node] : [node, swift];
  }

  private dirIdentity(
    stat: { dev?: number; ino?: number },
    pathFallback: string
  ): string | undefined {
    if (typeof stat.dev === 'number' && typeof stat.ino === 'number') {
      return `${stat.dev}:${stat.ino}`;
    }

    return pathFallback === '' ? undefined : `path:${pathFallback}`;
  }

  private async markChanged(filePath: string, report: RefreshReport): Promise<void> {
    this.cacheGeneration += 1;
    await this.cache.invalidateBody(filePath);
    report.changed.push(filePath);
  }

  private async classifyFile(
    filePath: string,
    entry: MountDirEntry,
    report: RefreshReport
  ): Promise<void> {
    const cached = await this.cache.getBody(filePath);
    const remoteEtags = this.etagsFromListing(entry);
    if (cached) {
      if (!remoteEtags?.includes(cached.etag)) {
        await this.markChanged(filePath, report);
        return;
      }
    }

    report.unchanged++;
  }

  private async refreshDir(
    dir: string,
    report: RefreshReport,
    stack: string[],
    seenDirs: Set<string>,
    seenFiles: Set<string>
  ): Promise<void> {
    const entries = await this.readDir(dir);
    for (const entry of entries) {
      const childPath = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        try {
          const st = await this.stat(childPath);
          const id = this.dirIdentity(st, childPath);
          if (id && seenDirs.has(id)) continue;
          if (id) seenDirs.add(id);
          stack.push(childPath);
        } catch (err) {
          report.errors.push({
            path: childPath,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        seenFiles.add(childPath);
        await this.classifyFile(childPath, entry, report);
      }
    }
  }

  private async purgeAbsentBodies(seenFiles: Set<string>, report: RefreshReport): Promise<void> {
    const cachedPaths = await this.cache.listBodyPaths();
    let bumped = false;
    for (const path of cachedPaths) {
      if (seenFiles.has(path)) continue;
      if (!bumped) {
        this.cacheGeneration += 1;
        bumped = true;
      }
      await this.cache.invalidateBody(path);
      report.removed.push(path);
    }
  }

  private async refreshBodies(report: RefreshReport): Promise<void> {
    for (const path of report.changed) {
      try {
        await this.readFile(path);
      } catch (err) {
        report.errors.push({
          path,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
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

  getHostPath(): string {
    return this.hostPath;
  }

  getTargetPath(): string {
    return this.targetPath;
  }
}
