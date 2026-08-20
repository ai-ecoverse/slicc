/**
 * AemMountBackend — signing-naive HTTP mount for the Helix 6 Source Bus on
 * `api.aem.live`.
 *
 * Sites upgraded to the Helix 6 architecture no longer keep their content in
 * `admin.da.live`; it lives behind
 * `https://api.aem.live/<org>/sites/<site>/source/...`. This backend speaks
 * that API. It shares the `SignedFetchDa` transport with `DaMountBackend` —
 * both authenticate with the same Adobe IMS bearer token — and selects the
 * upstream by setting `origin` on every logical request. The allow-list that
 * decides which origins a DA envelope may reach lives in
 * `executeDaSignAndForward` (`@slicc/shared-ts`).
 *
 * Wire contract (verified against `adobe/aem-website` on 2026-08-20):
 *
 *   - `GET  /<org>/sites/<site>/source/<path>`   → 200 + document bytes
 *   - `GET  /<org>/sites/<site>/source/<dir>/`   → 200 + JSON listing. The
 *     **trailing slash** is what makes it a listing; without it the same
 *     path 404s. Files come back as `{name, size, content-type,
 *     last-modified}`, folders as `{name: "blog/", content-type:
 *     "application/folder"}`.
 *   - `PUT  /<org>/sites/<site>/source/<path>`   → 201 on create *and* on
 *     overwrite, raw body. The stored content type is derived from the path
 *     extension server-side: a `.json` PUT declared `text/html` still reads
 *     back as `application/json`, and a PUT with no `Content-Type` at all
 *     succeeds. So we send none — one less header, and one less chance to
 *     disagree with the server about what a file is.
 *   - `DELETE …`                                 → 204, or 404 when absent.
 *
 * Two properties shape the implementation:
 *
 *   1. **No ETags.** The Source Bus returns `last-modified` and nothing else,
 *      so the cache's `etag` slot holds a *surrogate*: the modification time
 *      normalized to epoch-ms (`String(Date.parse(...))`). Listings report
 *      ISO-8601 and responses report RFC 1123; normalizing through
 *      `Date.parse` is what lets `refresh()` compare the two.
 *   2. **No conditional requests.** `If-Match`/`If-None-Match` are not part of
 *      the contract, and extra request headers trip a CORS preflight the
 *      endpoint rejects. `writeFile` therefore guards with an explicit HEAD
 *      when it holds a cached surrogate — a read-modify-write whose remote
 *      moved underneath it fails `EBUSY` rather than clobbering silently.
 */

import { FsError } from '../types.js';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  RefreshReport,
} from './backend.js';
import type { SignedFetchDa } from './backend-da.js';
import type { RemoteMountCache } from './remote-cache.js';

/** The Helix 6 Source Bus origin. */
export const AEM_SOURCE_BUS_ORIGIN = 'https://api.aem.live';

/** Content type the Source Bus uses to mark a listing entry as a folder. */
const FOLDER_CONTENT_TYPE = 'application/folder';

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // AEM documents are small

/** One entry of a Source Bus directory listing, as returned on the wire. */
interface SourceBusEntry {
  name: string;
  size?: number;
  'content-type'?: string;
  'last-modified'?: string;
}

export interface AemMountBackendOptions {
  source: string;
  profile: string;
  cache: RemoteMountCache;
  maxBodyBytes?: number;
  /** Required: attaches the IMS bearer and forwards each request. */
  signedFetch: SignedFetchDa;
  mountId?: string;
}

interface ParsedAemSource {
  org: string;
  site: string;
  path: string; // no leading or trailing '/'
}

export function parseAemSource(source: string): ParsedAemSource {
  const m = source.match(/^aem:\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!m) throw new Error(`invalid AEM source '${source}' — expected aem://org/site[/path]`);
  return {
    org: m[1],
    site: m[2],
    path: (m[3] ?? '').replace(/^\/+/, '').replace(/\/+$/, ''),
  };
}

/**
 * Normalize a modification timestamp into the cache's surrogate ETag. Accepts
 * both wire formats — ISO-8601 (listings) and RFC 1123 (`last-modified`
 * headers) — and returns `''` for anything unparseable, which callers treat
 * as "version unknown" rather than as a match.
 */
function surrogateEtag(lastModified: string | null | undefined): string {
  if (!lastModified) return '';
  const ms = Date.parse(lastModified);
  return Number.isNaN(ms) ? '' : String(ms);
}

/** Epoch-ms for a `MountStat.mtime`, or 0 when the wire gave us nothing. */
function toMtime(lastModified: string | null | undefined): number {
  const ms = Date.parse(lastModified ?? '');
  return Number.isNaN(ms) ? 0 : ms;
}

/** Map a listing payload onto `MountDirEntry`s. */
function toDirEntries(json: SourceBusEntry[]): MountDirEntry[] {
  return json.map((item) => {
    if (item['content-type'] === FOLDER_CONTENT_TYPE || item.name.endsWith('/')) {
      return { name: item.name.replace(/\/+$/, ''), kind: 'directory' as const };
    }
    return {
      name: item.name,
      kind: 'file' as const,
      size: item.size,
      etag: surrogateEtag(item['last-modified']),
      lastModified: toMtime(item['last-modified']),
    };
  });
}

export class AemMountBackend implements MountBackend {
  readonly kind = 'aem' as const;
  readonly source: string;
  readonly profile: string;
  readonly mountId: string;

  private readonly parsed: ParsedAemSource;
  private readonly cache: RemoteMountCache;
  private readonly maxBodyBytes: number;
  private readonly transport: SignedFetchDa;
  private closed = false;

  constructor(opts: AemMountBackendOptions) {
    this.source = opts.source;
    this.profile = opts.profile;
    this.mountId = opts.mountId ?? crypto.randomUUID();
    this.parsed = parseAemSource(opts.source);
    this.cache = opts.cache;
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.transport = opts.signedFetch;
  }

  private assertOpen(path: string): void {
    if (this.closed) throw new FsError('EBADF', 'mount closed', path);
  }

  private toMountRelative(path: string): string {
    return path.replace(/^\/+/, '');
  }

  /** `/<org>/sites/<site>/source[/<path>]` for a mount-relative file path. */
  private toSourcePath(mountRelative: string): string {
    const cleanRel = mountRelative.replace(/^\/+/, '').replace(/\/+$/, '');
    const segments = [this.parsed.path, cleanRel].filter((s) => s.length > 0).join('/');
    const base = `/${this.parsed.org}/sites/${this.parsed.site}/source`;
    return segments ? `${base}/${segments}` : base;
  }

  /**
   * Same as `toSourcePath`, plus the trailing slash that turns the request
   * into a directory listing. The root listing is `/…/source/`.
   */
  private toListPath(mountRelative: string): string {
    return `${this.toSourcePath(mountRelative)}/`;
  }

  private request(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    path: string,
    init?: { headers?: Record<string, string>; body?: Uint8Array }
  ): Promise<Response> {
    return this.transport({
      method,
      path,
      origin: AEM_SOURCE_BUS_ORIGIN,
      headers: init?.headers,
      body: init?.body,
    });
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertOpen(path);
    const rel = this.toMountRelative(path);

    const cached = await this.cache.getBody(rel);
    if (cached && !this.cache.isStale(cached.cachedAt)) {
      return cached.body;
    }

    // No conditional GET: the Source Bus has no ETags, and `If-Modified-Since`
    // would be an extra header for no benefit. The TTL above is the only
    // revalidation lever.
    const res = await this.request('GET', this.toSourcePath(rel));

    if (res.status === 404) {
      await this.cache.invalidateBody(rel);
      throw new FsError('ENOENT', 'no such file', path);
    }
    if (res.status === 401 || res.status === 403) {
      throw new FsError('EACCES', 'aem access denied', path);
    }
    if (res.status >= 400) {
      throw new FsError('EIO', `aem readFile failed: ${res.status}`, path);
    }

    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > this.maxBodyBytes) {
      throw new FsError('EFBIG', 'body exceeds maxBodyBytes', path);
    }
    await this.cache.putBody(rel, body, surrogateEtag(res.headers.get('last-modified')));
    return body;
  }

  /**
   * Optimistic-concurrency guard. The Source Bus has no `If-Match`, so when we
   * hold a body we previously read, HEAD the remote and compare modification
   * times before overwriting. A moved remote throws `EBUSY` — the same signal
   * `DaMountBackend` raises on a 412 — so the agent re-reads and retries
   * instead of silently discarding someone else's edit.
   *
   * With no cached body there is nothing to lose an update against, so the
   * write proceeds unguarded (and pays no extra round trip).
   */
  private async assertUnchanged(path: string, rel: string, knownEtag: string): Promise<void> {
    if (!knownEtag) return;
    const head = await this.request('HEAD', this.toSourcePath(rel));
    if (head.status === 404) return; // Deleted remotely — recreating is fine.
    if (head.status >= 400) {
      throw new FsError('EIO', `aem precondition HEAD failed: ${head.status}`, path);
    }
    const remoteEtag = surrogateEtag(head.headers.get('last-modified'));
    if (remoteEtag && remoteEtag !== knownEtag) {
      await this.cache.invalidateBody(rel);
      throw new FsError('EBUSY', 'remote modified since last read — re-read and retry', path);
    }
  }

  async writeFile(path: string, body: Uint8Array): Promise<void> {
    this.assertOpen(path);
    if (body.byteLength > this.maxBodyBytes) {
      throw new FsError('EFBIG', 'body exceeds maxBodyBytes', path);
    }
    const rel = this.toMountRelative(path);

    const cached = await this.cache.getBody(rel);
    await this.assertUnchanged(path, rel, cached?.etag ?? '');

    // Raw body, no Content-Type — unlike da-admin, the Source Bus takes no
    // multipart envelope and types the stored object from the path extension.
    const res = await this.request('PUT', this.toSourcePath(rel), { body });

    if (res.status === 401 || res.status === 403) {
      throw new FsError('EACCES', 'aem write denied', path);
    }
    if (res.status >= 400) {
      throw new FsError('EIO', `aem writeFile failed: ${res.status}`, path);
    }

    // The 201 carries no `last-modified`, so there is no surrogate to cache
    // the body under. Drop it rather than store a version-less entry that
    // would disable the guard above on the next write; the following read
    // re-establishes it.
    await this.cache.invalidateBody(rel);
    const parent = rel.split('/').slice(0, -1).join('/');
    await this.cache.invalidateListing(parent);
  }

  async readDir(path: string): Promise<MountDirEntry[]> {
    this.assertOpen(path);
    const rel = this.toMountRelative(path).replace(/\/+$/, '');
    const listing = await this.cache.getListing(rel);
    if (listing && !this.cache.isStale(listing.cachedAt)) {
      return listing.entries;
    }
    const res = await this.request('GET', this.toListPath(rel));
    // Folders are virtual: an empty (or absent) one 404s rather than
    // returning `[]`.
    if (res.status === 404) throw new FsError('ENOENT', 'no such directory', path);
    if (res.status === 401 || res.status === 403) {
      throw new FsError('EACCES', 'aem access denied', path);
    }
    if (res.status >= 400) {
      throw new FsError('EIO', `aem list failed: ${res.status}`, path);
    }
    const entries = toDirEntries((await res.json()) as SourceBusEntry[]);
    await this.cache.putListing(rel, entries);
    return entries;
  }

  async stat(path: string): Promise<MountStat> {
    this.assertOpen(path);
    const rel = this.toMountRelative(path);
    if (rel === '') return { kind: 'directory', size: 0, mtime: 0 };

    // 1. Body cache — the only source of a *decoded* size. Listings report the
    //    stored (compressed) size, which is what the API exposes and what
    //    everything else here has to live with.
    const cached = await this.cache.getBody(rel);
    if (cached) {
      return { kind: 'file', size: cached.size, mtime: cached.cachedAt, etag: cached.etag };
    }

    // 2. Parent listing. Unlike da-admin's `/list`, a Source Bus listing
    //    carries size and mtime per entry and marks folders explicitly, so one
    //    listing answers stat() for every child — no per-file HEAD fan-out.
    const parts = rel.split('/');
    const fileName = parts.pop() ?? '';
    const parentDir = parts.join('/');
    const parentListing = await this.cache.getListing(parentDir);
    const entries =
      parentListing && !this.cache.isStale(parentListing.cachedAt)
        ? parentListing.entries
        : await this.readDirQuietly(parentDir);

    const entry = entries?.find((e) => e.name === fileName);
    if (!entry) throw new FsError('ENOENT', 'no such file or directory', path);
    if (entry.kind === 'directory') {
      return { kind: 'directory', size: 0, mtime: entry.lastModified ?? 0 };
    }
    return {
      kind: 'file',
      size: entry.size ?? 0,
      mtime: entry.lastModified ?? 0,
      etag: entry.etag ?? '',
    };
  }

  /** `readDir` that yields `null` instead of throwing on a missing parent. */
  private async readDirQuietly(dir: string): Promise<MountDirEntry[] | null> {
    try {
      return await this.readDir(dir);
    } catch {
      return null;
    }
  }

  async mkdir(_path: string): Promise<void> {
    // Folders are virtual — they exist exactly as long as they hold a file.
  }

  async remove(path: string): Promise<void> {
    this.assertOpen(path);
    const rel = this.toMountRelative(path);
    const res = await this.request('DELETE', this.toSourcePath(rel));
    if (res.status === 404) throw new FsError('ENOENT', 'no such file', path);
    if (res.status === 401 || res.status === 403) {
      throw new FsError('EACCES', 'aem delete denied', path);
    }
    if (res.status >= 400) {
      throw new FsError('EIO', `aem delete failed: ${res.status}`, path);
    }
    await this.cache.invalidateBody(rel);
    const parent = rel.split('/').slice(0, -1).join('/');
    await this.cache.invalidateListing(parent);
  }

  async refresh(opts?: { bodies?: boolean }): Promise<RefreshReport> {
    this.assertOpen('/');
    const report: RefreshReport = {
      added: [],
      removed: [],
      changed: [],
      unchanged: 0,
      errors: [],
    };
    const stack: string[] = [''];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      try {
        await this.refreshDir(dir, report, stack);
      } catch (err) {
        report.errors.push({
          path: dir,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (opts?.bodies) await this.refreshBodies(report);
    return report;
  }

  private async classifyFile(
    filePath: string,
    remoteEtag: string,
    report: RefreshReport
  ): Promise<void> {
    const cached = await this.cache.getBody(filePath);
    if (!cached) {
      report.added.push(filePath);
    } else if (remoteEtag && cached.etag !== remoteEtag) {
      await this.cache.invalidateBody(filePath);
      report.changed.push(filePath);
    } else {
      report.unchanged++;
    }
  }

  private async refreshDir(dir: string, report: RefreshReport, stack: string[]): Promise<void> {
    const res = await this.request('GET', this.toListPath(dir));
    // A folder that has just lost its last file 404s. During a walk that is
    // "empty", not an error — recording it would make every refresh of a
    // freshly-emptied tree look like a failure.
    if (res.status === 404) {
      await this.cache.putListing(dir, []);
      return;
    }
    if (res.status >= 400) {
      report.errors.push({ path: dir, message: `list failed: ${res.status}` });
      return;
    }
    const entries = toDirEntries((await res.json()) as SourceBusEntry[]);
    for (const entry of entries) {
      const childPath = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        stack.push(childPath);
      } else {
        await this.classifyFile(childPath, entry.etag ?? '', report);
      }
    }
    await this.cache.putListing(dir, entries);
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
    return {
      displayName: `${this.parsed.org}/${this.parsed.site}${this.parsed.path ? `/${this.parsed.path}` : ''}`,
      source: this.source,
      profile: this.profile,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
  }
}
