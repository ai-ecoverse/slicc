import { getMimeType } from '../../base/mime-types.js';
import { encodeMultipartParts } from '../../base/multipart-form-data.js';
import { FsError } from '../types.js';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  RefreshReport,
} from './backend.js';
import type { RemoteMountCache } from './remote-cache.js';

function buildMultipartFormData(
  filename: string,
  contentType: string,
  body: Uint8Array
): { contentType: string; body: Uint8Array } {
  const encoded = encodeMultipartParts([
    { name: 'data', file: { bytes: body, filename, contentType } },
  ]);
  return { contentType: encoded.contentType, body: encoded.bytes };
}

function basenameOf(path: string): string {
  return path.split('/').pop() || 'data';
}

export interface SignedFetchDaRequest {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';

  path: string;

  origin?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export type SignedFetchDa = (req: SignedFetchDaRequest) => Promise<Response>;

export interface DaMountBackendOptions {
  source: string;
  profile: string;
  cache: RemoteMountCache;
  maxBodyBytes?: number;

  signedFetch: SignedFetchDa;
  mountId?: string;
}

interface ParsedDaSource {
  org: string;
  repo: string;
  path: string;
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

const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

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

  private toSourcePath(mountRelative: string): string {
    const cleanRel = mountRelative.replace(/^\/+/, '').replace(/\/+$/, '');
    const segments = [this.parsed.path, cleanRel].filter((s) => s.length > 0).join('/');
    return `/source/${this.parsed.org}/${this.parsed.repo}${segments ? `/${segments}` : ''}`;
  }

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

    const rawEtag = res.headers.get('etag') ?? '';
    const etag = rawEtag.startsWith('W/') ? rawEtag.slice(2) : rawEtag;
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

    const filename = basenameOf(path);
    const innerContentType = getMimeType(path);
    const wrapped = buildMultipartFormData(filename, innerContentType, body);

    const headers: Record<string, string> = {
      'content-type': wrapped.contentType,
      'content-length': String(wrapped.body.byteLength),
    };

    if (cached?.etag) {
      const strongEtag = cached.etag.startsWith('W/') ? cached.etag.slice(2) : cached.etag;
      headers['if-match'] = strongEtag;
    } else if (!cached) {
      headers['if-none-match'] = '*';
    }

    const tryOnce = (): Promise<Response> =>
      this.transport({
        method: 'POST',
        path: this.toSourcePath(rel),
        headers,
        body: wrapped.body,
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
        const parent = rel.split('/').slice(0, -1).join('/');
        await this.cache.invalidateListing(parent);
        return;
      }
      await this.cache.invalidateBody(rel);
      try {
        await this.readFile(path);
      } catch {}
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

    const parts = rel.split('/');
    const fileName = parts.pop() ?? '';
    const parentDir = parts.join('/');
    const parentListing = await this.cache.getListing(parentDir);
    if (parentListing && !this.cache.isStale(parentListing.cachedAt)) {
      const entry = parentListing.entries.find((e) => e.name === fileName);
      if (entry?.kind === 'file' && entry.size !== undefined) {
        return {
          kind: 'file',
          size: entry.size,
          mtime: entry.lastModified ?? parentListing.cachedAt,
          etag: entry.etag ?? '',
        };
      }
      if (entry?.kind === 'directory') {
        return {
          kind: 'directory',
          size: 0,
          mtime: entry.lastModified ?? parentListing.cachedAt,
        };
      }
      if (!entry) {
        throw new FsError('ENOENT', 'no such file or directory', path);
      }
    }

    const res = await this.transport({ method: 'HEAD', path: this.toSourcePath(rel) });
    if (res.status === 200) {
      const size = Number(res.headers.get('content-length') ?? '0');
      const etag = res.headers.get('etag') ?? '';
      const lm = res.headers.get('last-modified');
      const mtime = lm ? Date.parse(lm) : 0;

      if (parentListing) {
        const updatedEntries = parentListing.entries.map((e) =>
          e.name === fileName && e.kind === 'file' ? { ...e, size, etag, lastModified: mtime } : e
        );
        await this.cache.putListing(parentDir, updatedEntries);
      }

      return { kind: 'file', size, mtime, etag };
    }
    if (res.status === 404) {
      const listing = await this.cache.getListing(rel);
      if (listing) return { kind: 'directory', size: 0, mtime: listing.cachedAt };
      throw new FsError('ENOENT', 'no such file or directory', path);
    }
    throw new FsError('EIO', `da stat failed: ${res.status}`, path);
  }

  async mkdir(_path: string): Promise<void> {}

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
    remoteEtag: string | undefined,
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
    const res = await this.transport({ method: 'GET', path: this.toListPath(dir) });
    if (res.status >= 400) {
      report.errors.push({ path: dir, message: `list failed: ${res.status}` });
      return;
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
        await this.classifyFile(filePath, item.etag, report);
      } else {
        entries.push({ name: item.name, kind: 'directory' });
        stack.push(dir ? `${dir}/${item.name}` : item.name);
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
      displayName: `${this.parsed.org}/${this.parsed.repo}${this.parsed.path ? `/${this.parsed.path}` : ''}`,
      source: this.source,
      profile: this.profile,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
  }
}
