/**
 * DaMountBackend — HTTP + IMS bearer against da.live (Adobe Document Authoring).
 *
 * URL scheme:
 *   - readFile / writeFile: GET/POST https://admin.da.live/source/<org>/<repo>/<path>
 *   - readDir / refresh:    GET     https://admin.da.live/list/<org>/<repo>/<path>
 *
 * Auth via IMS bearer token from DaProfile.getBearerToken(). On 401, the
 * backend re-fetches the token and retries once.
 *
 * See spec §"Behavior → Caching" and §"Data flow → Read/Write" for the
 * contract; this is the same TTL+ETag pattern as S3MountBackend.
 */

import { FsError } from '../types.js';
import type {
  MountBackend,
  MountDirEntry,
  MountStat,
  MountDescription,
  MountApprovalCopy,
  RefreshReport,
} from './backend.js';
import type { DaProfile } from './profile.js';
import { fetchWithBudget } from './fetch-with-budget.js';
import { RemoteMountCache } from './remote-cache.js';

export interface DaMountBackendOptions {
  source: string;
  profile: string;
  profileResolved: DaProfile;
  cache: RemoteMountCache;
  maxBodyBytes?: number;
  signal?: AbortSignal;
  /** Test-only override. */
  apiBase?: string;
  mountId?: string;
}

interface ParsedDaSource {
  org: string;
  repo: string;
  path: string; // no leading or trailing '/'
}

function parseDaSource(source: string): ParsedDaSource {
  const m = /^da:\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(source);
  if (!m) throw new Error(`invalid DA source '${source}' — expected da://org/repo[/path]`);
  return {
    org: m[1],
    repo: m[2],
    path: (m[3] ?? '').replace(/^\/+/, '').replace(/\/+$/, ''),
  };
}

const DEFAULT_API_BASE = 'https://admin.da.live';
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // DA docs are small

export class DaMountBackend implements MountBackend {
  readonly kind = 'da' as const;
  readonly source: string;
  readonly profile: string;
  readonly mountId: string;

  private readonly parsed: ParsedDaSource;
  private readonly profileResolved: DaProfile;
  private readonly cache: RemoteMountCache;
  private readonly maxBodyBytes: number;
  private readonly apiBase: string;
  private readonly internalCtl: AbortController;
  private closed = false;

  constructor(opts: DaMountBackendOptions) {
    this.source = opts.source;
    this.profile = opts.profile;
    this.mountId = opts.mountId ?? crypto.randomUUID();
    this.parsed = parseDaSource(opts.source);
    this.profileResolved = opts.profileResolved;
    this.cache = opts.cache;
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.internalCtl = new AbortController();
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => this.internalCtl.abort(), { once: true });
    }
  }

  private assertOpen(path: string): void {
    if (this.closed) throw new FsError('EBADF', 'mount closed', path);
  }

  private toMountRelative(path: string): string {
    return path.replace(/^\/+/, '');
  }

  private buildSourceUrl(rel: string): URL {
    const cleanRel = rel.replace(/^\/+/, '').replace(/\/+$/, '');
    const segments = [this.parsed.path, cleanRel].filter((s) => s.length > 0).join('/');
    return new URL(
      `${this.apiBase}/source/${this.parsed.org}/${this.parsed.repo}${segments ? `/${segments}` : ''}`
    );
  }

  private buildListUrl(rel: string): URL {
    const cleanRel = rel.replace(/^\/+/, '').replace(/\/+$/, '');
    const segments = [this.parsed.path, cleanRel].filter((s) => s.length > 0).join('/');
    return new URL(
      `${this.apiBase}/list/${this.parsed.org}/${this.parsed.repo}${segments ? `/${segments}` : ''}`
    );
  }

  private async authedFetch(req: {
    method: string;
    url: URL;
    headers?: Record<string, string>;
    body?: Uint8Array;
  }): Promise<Response> {
    let token = await this.profileResolved.getBearerToken();
    const buildRequest = () =>
      new Request(req.url.toString(), {
        method: req.method,
        headers: { ...(req.headers ?? {}), authorization: `Bearer ${token}` },
        body: req.body ? new Uint8Array(req.body) : undefined,
      });
    let res = await fetchWithBudget(buildRequest(), {
      maxAttempts: 3,
      perAttemptMs: 15_000,
      totalBudgetMs: 30_000,
      signal: this.internalCtl.signal,
    });
    if (res.status === 401) {
      // Token may have expired between resolution and the call; refresh once.
      token = await this.profileResolved.getBearerToken();
      res = await fetchWithBudget(buildRequest(), {
        maxAttempts: 1,
        perAttemptMs: 15_000,
        totalBudgetMs: 15_000,
        signal: this.internalCtl.signal,
      });
    }
    return res;
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertOpen(path);
    const rel = this.toMountRelative(path);

    const cached = await this.cache.getBody(rel);
    if (cached && !this.cache.isStale(cached.cachedAt)) {
      return cached.body;
    }

    const headers: Record<string, string> = {};
    if (cached) headers['if-none-match'] = cached.etag;
    const url = this.buildSourceUrl(rel);
    const res = await this.authedFetch({ method: 'GET', url, headers });

    if (res.status === 304 && cached) {
      await this.cache.putBody(rel, cached.body, cached.etag);
      return cached.body;
    }
    if (res.status === 404) {
      await this.cache.invalidateBody(rel);
      throw new FsError('ENOENT', 'no such file', path);
    }
    if (res.status === 401 || res.status === 403) {
      throw new FsError('EACCES', 'da access denied', path);
    }
    if (res.status >= 400) {
      throw new FsError('EIO', `da readFile failed: ${res.status}`, path);
    }

    const sizeHeader = res.headers.get('content-length');
    const size = sizeHeader ? Number(sizeHeader) : undefined;
    if (size !== undefined && size > this.maxBodyBytes) {
      throw new FsError('EFBIG', `body exceeds maxBodyBytes`, path);
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > this.maxBodyBytes) {
      throw new FsError('EFBIG', `body exceeds maxBodyBytes`, path);
    }
    const etag = res.headers.get('etag') ?? '';
    await this.cache.putBody(rel, body, etag);
    return body;
  }

  async writeFile(path: string, body: Uint8Array): Promise<void> {
    this.assertOpen(path);
    if (body.byteLength > this.maxBodyBytes) {
      throw new FsError('EFBIG', `body exceeds maxBodyBytes`, path);
    }
    const rel = this.toMountRelative(path);
    const cached = await this.cache.getBody(rel);
    const url = this.buildSourceUrl(rel);
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength),
    };
    if (cached) headers['if-match'] = cached.etag;
    else headers['if-none-match'] = '*';

    // DA's write verb is POST per their docs. If live API confirms a different
    // verb (PUT), adjust this line. The contract from our side is "send body,
    // set conditional headers".
    //
    // 412 dual-semantics retry — same shape as S3MountBackend.writeFile.
    // First-attempt 412 = external conflict → EBUSY. Retry-attempt 412
    // (after a transient on attempt 1) = our duplicate POST actually
    // landed → silent reconcile via HEAD.
    const tryOnce = (): Promise<Response> =>
      this.authedFetch({ method: 'POST', url, headers, body });

    let res: Response;
    let attempt = 1;
    try {
      res = await tryOnce();
    } catch {
      // Network error / timeout on attempt 1 — duplicate is safe under
      // ETag conditionals. (Catch parameter unused; we only retry, we
      // don't inspect the cause.)
      attempt = 2;
      res = await tryOnce();
    }

    if (res.status === 412) {
      if (attempt === 2) {
        // Our first POST landed; learn the new etag.
        const headRes = await this.authedFetch({ method: 'HEAD', url });
        const newEtag = headRes.headers.get('etag') ?? '';
        await this.cache.putBody(rel, body, newEtag);
        const parent = rel.split('/').slice(0, -1).join('/') || '/';
        await this.cache.invalidateListing(parent);
        return;
      }
      await this.cache.invalidateBody(rel);
      try {
        await this.readFile(path);
      } catch {
        /* best-effort */
      }
      throw new FsError('EBUSY', 'remote modified since last read — re-read and retry', path);
    }
    if (res.status === 401 || res.status === 403) {
      throw new FsError('EACCES', 'da write denied', path);
    }
    if (res.status >= 400) {
      throw new FsError('EIO', `da writeFile failed: ${res.status}`, path);
    }
    const newEtag = res.headers.get('etag') ?? '';
    await this.cache.putBody(rel, body, newEtag);
    const parent = rel.split('/').slice(0, -1).join('/') || '/';
    await this.cache.invalidateListing(parent);
  }

  async readDir(path: string): Promise<MountDirEntry[]> {
    this.assertOpen(path);
    const rel = this.toMountRelative(path).replace(/\/+$/, '');
    const listing = await this.cache.getListing(rel);
    if (listing && !this.cache.isStale(listing.cachedAt)) {
      return listing.entries;
    }
    const url = this.buildListUrl(rel);
    const res = await this.authedFetch({ method: 'GET', url });
    if (res.status === 404) throw new FsError('ENOENT', 'no such directory', path);
    if (res.status >= 400) {
      throw new FsError('EIO', `da list failed: ${res.status}`, path);
    }
    const json = (await res.json()) as Array<{
      name: string;
      ext?: string;
      path?: string;
      etag?: string;
      lastModified?: number;
    }>;
    const entries: MountDirEntry[] = json.map((item) => {
      if (item.ext) {
        return {
          name: `${item.name}.${item.ext}`,
          kind: 'file',
          etag: item.etag,
          lastModified: item.lastModified,
        };
      }
      return { name: item.name, kind: 'directory', lastModified: item.lastModified };
    });
    await this.cache.putListing(rel, entries);
    return entries;
  }

  async stat(path: string): Promise<MountStat> {
    this.assertOpen(path);
    const rel = this.toMountRelative(path);
    const cached = await this.cache.getBody(rel);
    if (cached) {
      return { kind: 'file', size: cached.size, mtime: cached.cachedAt, etag: cached.etag };
    }
    // Fall back to a HEAD on /source.
    const url = this.buildSourceUrl(rel);
    const res = await this.authedFetch({ method: 'HEAD', url });
    if (res.status === 200) {
      const size = Number(res.headers.get('content-length') ?? '0');
      const etag = res.headers.get('etag') ?? '';
      return { kind: 'file', size, mtime: 0, etag };
    }
    if (res.status === 404) {
      const listing = await this.cache.getListing(rel);
      if (listing) return { kind: 'directory', size: 0, mtime: listing.cachedAt };
      throw new FsError('ENOENT', 'no such file or directory', path);
    }
    throw new FsError('EIO', `da stat failed: ${res.status}`, path);
  }

  async mkdir(_path: string): Promise<void> {
    // DA materializes paths on first write. No-op.
  }

  async remove(path: string): Promise<void> {
    this.assertOpen(path);
    const rel = this.toMountRelative(path);
    const url = this.buildSourceUrl(rel);
    const res = await this.authedFetch({ method: 'DELETE', url });
    if (res.status === 404) throw new FsError('ENOENT', 'no such file', path);
    if (res.status === 401 || res.status === 403) {
      throw new FsError('EACCES', 'da delete denied', path);
    }
    if (res.status >= 400) {
      throw new FsError('EIO', `da delete failed: ${res.status}`, path);
    }
    await this.cache.invalidateBody(rel);
    const parent = rel.split('/').slice(0, -1).join('/') || '/';
    await this.cache.invalidateListing(parent);
  }

  async refresh(opts?: { bodies?: boolean }): Promise<RefreshReport> {
    this.assertOpen('/');
    // Recursive walk: start at root, list each dir, recurse into directory entries.
    const report: RefreshReport = { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
    const stack: string[] = [''];
    const seenPaths = new Set<string>();
    while (stack.length > 0) {
      const dir = stack.pop()!;
      try {
        const url = this.buildListUrl(dir);
        const res = await this.authedFetch({ method: 'GET', url });
        if (res.status >= 400) {
          report.errors.push({ path: dir, message: `list failed: ${res.status}` });
          continue;
        }
        const json = (await res.json()) as Array<{
          name: string;
          ext?: string;
          etag?: string;
          lastModified?: number;
        }>;
        const entries: MountDirEntry[] = [];
        for (const item of json) {
          if (item.ext) {
            const filePath = dir ? `${dir}/${item.name}.${item.ext}` : `${item.name}.${item.ext}`;
            seenPaths.add(filePath);
            entries.push({
              name: `${item.name}.${item.ext}`,
              kind: 'file',
              etag: item.etag,
              lastModified: item.lastModified,
            });
            const cached = await this.cache.getBody(filePath);
            if (!cached) report.added.push(filePath);
            else if (item.etag && cached.etag !== item.etag) {
              await this.cache.invalidateBody(filePath);
              report.changed.push(filePath);
            } else {
              report.unchanged++;
            }
          } else {
            entries.push({ name: item.name, kind: 'directory' });
            const subDir = dir ? `${dir}/${item.name}` : item.name;
            stack.push(subDir);
          }
        }
        await this.cache.putListing(dir, entries);
      } catch (err) {
        report.errors.push({
          path: dir,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (opts?.bodies) {
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
    return report;
  }

  describe(): MountDescription {
    return {
      displayName: `${this.parsed.org}/${this.parsed.repo}${this.parsed.path ? `/${this.parsed.path}` : ''}`,
      source: this.source,
      profile: this.profile,
    };
  }

  describeForApproval(): MountApprovalCopy {
    return {
      summary: `Approve mount of \`${this.source}\` using your IMS identity`,
      needsPicker: false,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.internalCtl.abort();
  }
}
