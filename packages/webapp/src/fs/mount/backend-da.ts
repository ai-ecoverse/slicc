/**
 * DaMountBackend — signing-naive HTTP mount for da.live (Adobe Document Authoring).
 *
 * Like S3MountBackend, the DA backend never holds the IMS bearer token. It
 * builds *logical* requests (`{method, path, query, headers, body}`) where
 * `path` is the full DA URL path (e.g. `/source/<org>/<repo>/<key>` for
 * reads/writes, `/list/<org>/<repo>/<dir>` for directory walks) and hands
 * them to an injected `SignedFetchDa` transport, which is wired at runtime to:
 *
 *   - CLI/Electron: HTTP POST to node-server's `/api/da-sign-and-forward`
 *     (browser sends the IMS token transiently in the envelope; v2 will move
 *     OAuth server-side and remove the browser-side exposure)
 *   - Extension: `chrome.runtime.sendMessage` to the service worker
 *     (which holds the IMS token in `chrome.storage.local`)
 *   - Tests: a helper that attaches a fake bearer + mocked fetch
 *
 * 412 dual-semantics retry (first-attempt = EBUSY, retry-attempt = silent
 * reconcile via HEAD) mirrors S3MountBackend.writeFile.
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
import { type RemoteMountCache } from './remote-cache.js';

/**
 * A logical DA request handed to the transport.
 */
export interface SignedFetchDaRequest {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  /** Full DA path starting with /, e.g. `/source/<org>/<repo>/<key>` or `/list/<org>/<repo>/<dir>`. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

/**
 * Transport function: attaches the IMS bearer token and forwards the request,
 * returns the upstream Response. Throws `FsError` for envelope-level
 * failures; upstream 4xx/5xx are returned as Responses.
 */
export type SignedFetchDa = (req: SignedFetchDaRequest) => Promise<Response>;

export interface DaMountBackendOptions {
  source: string;
  profile: string;
  cache: RemoteMountCache;
  maxBodyBytes?: number;
  /** Required: signs and forwards each request. */
  signedFetch: SignedFetchDa;
  mountId?: string;
}

interface ParsedDaSource {
  org: string;
  repo: string;
  path: string; // no leading or trailing '/'
}

function parseDaSource(source: string): ParsedDaSource {
  const m = source.match(/^da:\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (!m) throw new Error(`invalid DA source '${source}' — expected da://org/repo[/path]`);
  return {
    org: m[1],
    repo: m[2],
    path: (m[3] ?? '').replace(/^\/+/, '').replace(/\/+$/, ''),
  };
}

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // DA docs are small

export class DaMountBackend implements MountBackend {
  readonly kind = 'da' as const;
  readonly source: string;
  readonly profile: string;
  readonly mountId: string;

  private readonly parsed: ParsedDaSource;
  private readonly cache: RemoteMountCache;
  private readonly maxBodyBytes: number;
  private readonly transport: SignedFetchDa;
  private closed = false;

  constructor(opts: DaMountBackendOptions) {
    this.source = opts.source;
    this.profile = opts.profile;
    this.mountId = opts.mountId ?? crypto.randomUUID();
    this.parsed = parseDaSource(opts.source);
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

  /** Build the `/source/<org>/<repo>[/<path>]` DA path for a given mount-relative path. */
  private toSourcePath(mountRelative: string): string {
    const cleanRel = mountRelative.replace(/^\/+/, '').replace(/\/+$/, '');
    const segments = [this.parsed.path, cleanRel].filter((s) => s.length > 0).join('/');
    return `/source/${this.parsed.org}/${this.parsed.repo}${segments ? `/${segments}` : ''}`;
  }

  /** Build the `/list/<org>/<repo>[/<dir>]` DA path. */
  private toListPath(mountRelative: string): string {
    const cleanRel = mountRelative.replace(/^\/+/, '').replace(/\/+$/, '');
    const segments = [this.parsed.path, cleanRel].filter((s) => s.length > 0).join('/');
    return `/list/${this.parsed.org}/${this.parsed.repo}${segments ? `/${segments}` : ''}`;
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

    const res = await this.transport({
      method: 'GET',
      path: this.toSourcePath(rel),
      headers,
    });

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
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength),
    };
    if (cached) headers['if-match'] = cached.etag;
    else headers['if-none-match'] = '*';

    // 412 dual-semantics retry — see backend-s3.ts for the full rationale.
    const tryOnce = (): Promise<Response> =>
      this.transport({
        method: 'POST',
        path: this.toSourcePath(rel),
        headers,
        body,
      });

    let res: Response;
    let attempt = 1;
    try {
      res = await tryOnce();
    } catch {
      attempt = 2;
      res = await tryOnce();
    }

    if (res.status === 412) {
      if (attempt === 2) {
        const headRes = await this.transport({
          method: 'HEAD',
          path: this.toSourcePath(rel),
        });
        if (headRes.status >= 400) {
          throw new FsError('EIO', `da reconcile HEAD failed: ${headRes.status}`, path);
        }
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
        // Cache refresh is best-effort; the EBUSY below is the actionable signal.
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
    const res = await this.transport({ method: 'GET', path: this.toListPath(rel) });
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
    const res = await this.transport({ method: 'HEAD', path: this.toSourcePath(rel) });
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
    const res = await this.transport({ method: 'DELETE', path: this.toSourcePath(rel) });
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
        const res = await this.transport({ method: 'GET', path: this.toListPath(dir) });
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
  }
}
