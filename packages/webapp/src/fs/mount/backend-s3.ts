/**
 * S3MountBackend — HTTP + SigV4 mount implementation.
 *
 * Implements the MountBackend interface for S3-compatible services (AWS S3,
 * Cloudflare R2, MinIO, etc.). Uses:
 *   - signSigV4 for request signing (no AWS SDK dependency)
 *   - RemoteMountCache for TTL+ETag content cache
 *   - fetchWithBudget for timeout / retry / abort signal threading
 *   - resolveS3Profile output (passed in at construction)
 *
 * See spec §"Data flow → Read" / "Data flow → Write" for the contract.
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
import type { S3Profile } from './profile.js';
import { signSigV4, type SigV4Request } from './signing-s3.js';
import { fetchWithBudget } from './fetch-with-budget.js';
import { RemoteMountCache } from './remote-cache.js';

export interface S3MountBackendOptions {
  /** Original 's3://bucket/prefix' source URI. */
  source: string;
  /** Profile name (for `mount list` / display). */
  profile: string;
  /** Already-resolved S3Profile (creds + region + endpoint). */
  profileResolved: S3Profile;
  cache: RemoteMountCache;
  /** Reasonable defaults: 25 MiB. */
  maxBodyBytes?: number;
  /** Override for tests. */
  signal?: AbortSignal;
  /**
   * Re-resolve the profile from the secret store. Called once on 401/403 to
   * pick up rotated credentials before retrying the request. The backend
   * stops the auth retry loop after one re-resolve to avoid masking real
   * permission errors. Optional — when omitted, 401/403 throws EACCES on
   * first hit (used by tests that pre-bake profiles).
   */
  reresolveProfile?: () => Promise<S3Profile>;
}

interface ParsedSource {
  bucket: string;
  prefix: string; // no leading or trailing '/'
}

function parseS3Source(source: string): ParsedSource {
  const m = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(source);
  if (!m) throw new Error(`invalid S3 source '${source}' — expected s3://bucket[/prefix]`);
  const bucket = m[1];
  const prefix = (m[2] ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  return { bucket, prefix };
}

const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

export class S3MountBackend implements MountBackend {
  readonly kind = 's3' as const;
  readonly source: string;
  readonly profile: string;
  readonly mountId: string;

  private readonly parsed: ParsedSource;
  private profileResolved: S3Profile;
  private readonly cache: RemoteMountCache;
  private readonly maxBodyBytes: number;
  private readonly internalCtl: AbortController;
  private readonly reresolveProfile?: () => Promise<S3Profile>;
  private closed = false;

  constructor(opts: S3MountBackendOptions & { mountId?: string }) {
    this.source = opts.source;
    this.profile = opts.profile;
    this.mountId = opts.mountId ?? crypto.randomUUID();
    this.parsed = parseS3Source(opts.source);
    this.profileResolved = opts.profileResolved;
    this.cache = opts.cache;
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.internalCtl = new AbortController();
    this.reresolveProfile = opts.reresolveProfile;
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => this.internalCtl.abort(), { once: true });
    }
  }

  private endpointHost(): string {
    if (this.profileResolved.endpoint) {
      return new URL(this.profileResolved.endpoint).host;
    }
    return `s3.${this.profileResolved.region}.amazonaws.com`;
  }

  private buildUrl(mountRelativePath: string): URL {
    const cleanRel = mountRelativePath.replace(/^\/+/, '').replace(/\/+$/, '');
    const segments = [this.parsed.prefix, cleanRel].filter((s) => s.length > 0).join('/');
    return new URL(`https://${this.parsed.bucket}.${this.endpointHost()}/${segments}`);
  }

  private assertOpen(path: string): void {
    if (this.closed) throw new FsError('EBADF', 'mount closed', path);
  }

  private toMountRelative(path: string): string {
    return path.replace(/^\/+/, '');
  }

  private async signedFetch(
    req: SigV4Request,
    opts?: { maxAttempts?: number; perAttemptMs?: number; totalBudgetMs?: number }
  ): Promise<Response> {
    const doFetch = async (): Promise<Response> => {
      const signed = await signSigV4(
        req,
        {
          accessKeyId: this.profileResolved.accessKeyId,
          secretAccessKey: this.profileResolved.secretAccessKey,
          sessionToken: this.profileResolved.sessionToken,
        },
        this.profileResolved.region
      );
      return fetchWithBudget(
        new Request(signed.url.toString(), {
          method: signed.method,
          headers: signed.headers,
          body: signed.body ? new Uint8Array(signed.body) : undefined,
        }),
        {
          maxAttempts: opts?.maxAttempts ?? 3,
          perAttemptMs: opts?.perAttemptMs ?? 15_000,
          totalBudgetMs: opts?.totalBudgetMs ?? 30_000,
          signal: this.internalCtl.signal,
        }
      );
    };

    let res = await doFetch();
    if ((res.status === 401 || res.status === 403) && this.reresolveProfile) {
      this.profileResolved = await this.reresolveProfile();
      res = await doFetch();
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

    const url = this.buildUrl(rel);
    const headers: Record<string, string> = { host: url.host };
    if (cached) headers['if-none-match'] = cached.etag;

    const res = await this.signedFetch({ method: 'GET', url, headers });

    if (res.status === 304 && cached) {
      await this.cache.putBody(rel, cached.body, cached.etag);
      return cached.body;
    }
    if (res.status === 404) {
      await this.cache.invalidateBody(rel);
      throw new FsError('ENOENT', 'no such file', path);
    }
    if (res.status === 401 || res.status === 403) {
      throw new FsError('EACCES', 's3 access denied', path);
    }
    if (res.status >= 400) {
      throw new FsError('EIO', `s3 readFile failed: ${res.status}`, path);
    }

    const sizeHeader = res.headers.get('content-length');
    const size = sizeHeader ? Number(sizeHeader) : undefined;
    if (size !== undefined && size > this.maxBodyBytes) {
      throw new FsError(
        'EFBIG',
        `body exceeds maxBodyBytes (${size} > ${this.maxBodyBytes})`,
        path
      );
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
    const rel = this.toMountRelative(path);

    if (body.byteLength > this.maxBodyBytes) {
      throw new FsError('EFBIG', `body exceeds maxBodyBytes`, path);
    }

    const cached = await this.cache.getBody(rel);
    const url = this.buildUrl(rel);
    const baseHeaders: Record<string, string> = {
      host: url.host,
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength),
    };
    if (cached) {
      baseHeaders['if-match'] = cached.etag;
    } else {
      baseHeaders['if-none-match'] = '*';
    }

    const tryOnce = (): Promise<Response> =>
      this.signedFetch(
        { method: 'PUT', url, headers: baseHeaders, body },
        { maxAttempts: 1, perAttemptMs: 30_000, totalBudgetMs: 30_000 }
      );

    let res: Response;
    let attempt = 1;
    try {
      res = await tryOnce();
    } catch (err) {
      attempt = 2;
      res = await tryOnce();
    }

    if (res.status === 412) {
      if (attempt === 2) {
        const headRes = await this.signedFetch({
          method: 'HEAD',
          url,
          headers: { host: url.host },
        });
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
      throw new FsError('EACCES', 's3 write denied', path);
    }
    if (res.status >= 400) {
      throw new FsError('EIO', `s3 writeFile failed: ${res.status}`, path);
    }

    const newEtag = res.headers.get('etag') ?? '';
    await this.cache.putBody(rel, body, newEtag);
    const parent = rel.split('/').slice(0, -1).join('/') || '/';
    await this.cache.invalidateListing(parent);
  }

  private async listObjectsV2(): Promise<
    { key: string; etag: string; size: number; lastModified: number }[]
  > {
    const all: { key: string; etag: string; size: number; lastModified: number }[] = [];
    let continuationToken: string | undefined;
    do {
      const url = new URL(`https://${this.parsed.bucket}.${this.endpointHost()}/`);
      url.searchParams.set('list-type', '2');
      if (this.parsed.prefix) {
        url.searchParams.set('prefix', `${this.parsed.prefix}/`);
      }
      if (continuationToken) {
        url.searchParams.set('continuation-token', continuationToken);
      }
      const res = await this.signedFetch({
        method: 'GET',
        url,
        headers: { host: url.host },
      });
      if (res.status >= 400) {
        throw new FsError('EIO', `s3 list failed: ${res.status}`, '/');
      }
      const xml = await res.text();
      const parsed = this.parseListingXml(xml);
      all.push(...parsed.contents);
      continuationToken = parsed.nextContinuationToken;
    } while (continuationToken);
    return all;
  }

  private parseListingXml(xml: string): {
    contents: { key: string; etag: string; size: number; lastModified: number }[];
    nextContinuationToken: string | undefined;
  } {
    const contents: { key: string; etag: string; size: number; lastModified: number }[] = [];
    const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
    for (const match of xml.matchAll(contentRegex)) {
      const block = match[1];
      const key = /<Key>([^<]+)<\/Key>/.exec(block)?.[1] ?? '';
      const etag = /<ETag>([^<]+)<\/ETag>/.exec(block)?.[1] ?? '';
      const sizeStr = /<Size>([^<]+)<\/Size>/.exec(block)?.[1] ?? '0';
      const lmStr = /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1] ?? '';
      contents.push({
        key,
        etag,
        size: Number(sizeStr),
        lastModified: lmStr ? Date.parse(lmStr) : 0,
      });
    }
    const truncated = /<IsTruncated>([^<]+)<\/IsTruncated>/.exec(xml)?.[1] === 'true';
    const nextContinuationToken = truncated
      ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
      : undefined;
    return { contents, nextContinuationToken };
  }

  private toMountRelativeKey(s3Key: string): string {
    return this.parsed.prefix ? s3Key.slice(this.parsed.prefix.length + 1) : s3Key;
  }

  async readDir(path: string): Promise<MountDirEntry[]> {
    this.assertOpen(path);
    const dirRel = this.toMountRelative(path).replace(/\/+$/, '');

    const listing = await this.cache.getListing(dirRel);
    if (listing && !this.cache.isStale(listing.cachedAt)) {
      return listing.entries;
    }

    const all = await this.listObjectsV2();
    const entriesByDir = this.groupByDir(all);

    for (const [dir, entries] of entriesByDir) {
      await this.cache.putListing(dir, entries);
    }
    return entriesByDir.get(dirRel) ?? [];
  }

  private groupByDir(
    all: { key: string; etag: string; size: number; lastModified: number }[]
  ): Map<string, MountDirEntry[]> {
    const out = new Map<string, MountDirEntry[]>();
    const ensureDir = (dir: string) => {
      if (!out.has(dir)) out.set(dir, []);
      return out.get(dir)!;
    };
    ensureDir('');

    for (const obj of all) {
      const rel = this.toMountRelativeKey(obj.key);
      const segments = rel.split('/');
      const fileName = segments.pop()!;
      const dir = segments.join('/');
      ensureDir(dir).push({
        name: fileName,
        kind: 'file',
        size: obj.size,
        etag: obj.etag,
        lastModified: obj.lastModified,
      });
      let cursor = '';
      for (const seg of segments) {
        const parent = cursor;
        cursor = cursor ? `${cursor}/${seg}` : seg;
        const parentEntries = ensureDir(parent);
        if (!parentEntries.find((e) => e.name === seg && e.kind === 'directory')) {
          parentEntries.push({ name: seg, kind: 'directory' });
        }
        ensureDir(cursor);
      }
    }
    return out;
  }

  async stat(path: string): Promise<MountStat> {
    this.assertOpen(path);
    const rel = this.toMountRelative(path);
    const cached = await this.cache.getBody(rel);
    if (cached) {
      return {
        kind: 'file',
        size: cached.body.byteLength,
        mtime: cached.cachedAt,
        etag: cached.etag,
      };
    }
    const url = this.buildUrl(rel);
    const res = await this.signedFetch({ method: 'HEAD', url, headers: { host: url.host } });
    if (res.status === 200) {
      const size = Number(res.headers.get('content-length') ?? '0');
      const etag = res.headers.get('etag') ?? '';
      const lm = res.headers.get('last-modified');
      return { kind: 'file', size, mtime: lm ? Date.parse(lm) : 0, etag };
    }
    if (res.status === 404) {
      const listing = await this.cache.getListing(rel);
      if (listing) return { kind: 'directory', size: 0, mtime: listing.cachedAt };
      throw new FsError('ENOENT', 'no such file or directory', path);
    }
    throw new FsError('EIO', `s3 stat failed: ${res.status}`, path);
  }

  async refresh(opts?: { bodies?: boolean }): Promise<RefreshReport> {
    this.assertOpen('/');
    const all = await this.listObjectsV2();
    const remotePaths = new Set(all.map((o) => this.toMountRelativeKey(o.key)));
    const remoteEtags = new Map(all.map((o) => [this.toMountRelativeKey(o.key), o.etag]));

    const report: RefreshReport = { added: [], removed: [], changed: [], unchanged: 0, errors: [] };

    for (const path of remotePaths) {
      const cached = await this.cache.getBody(path);
      const remoteEtag = remoteEtags.get(path)!;
      if (!cached) {
        report.added.push(path);
      } else if (cached.etag !== remoteEtag) {
        await this.cache.invalidateBody(path);
        report.changed.push(path);
      } else {
        report.unchanged++;
      }
    }

    const grouped = this.groupByDir(all);
    for (const [dir, entries] of grouped) {
      await this.cache.putListing(dir, entries);
    }

    if (opts?.bodies) {
      for (const path of report.changed) {
        try {
          await this.readFile(path);
        } catch (err) {
          report.errors.push({ path, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return report;
  }

  async mkdir(_p: string): Promise<void> {}

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    this.assertOpen(path);
    const rel = this.toMountRelative(path);
    if (opts?.recursive) {
      throw new FsError('EINVAL', 'recursive remove not yet supported on S3', path);
    }
    const url = this.buildUrl(rel);
    const res = await this.signedFetch({
      method: 'DELETE',
      url,
      headers: { host: url.host },
    });
    if (res.status === 404) {
      throw new FsError('ENOENT', 'no such file', path);
    }
    if (res.status === 401 || res.status === 403) {
      throw new FsError('EACCES', 's3 delete denied', path);
    }
    if (res.status >= 400) {
      throw new FsError('EIO', `s3 delete failed: ${res.status}`, path);
    }
    await this.cache.invalidateBody(rel);
    const parent = rel.split('/').slice(0, -1).join('/') || '/';
    await this.cache.invalidateListing(parent);
  }

  describe(): MountDescription {
    return {
      displayName: this.parsed.prefix
        ? `${this.parsed.bucket}/${this.parsed.prefix}`
        : this.parsed.bucket,
      source: this.source,
      profile: this.profile,
    };
  }

  describeForApproval(): MountApprovalCopy {
    return {
      summary: `Approve mount of \`${this.source}\` (profile \`${this.profile}\`)`,
      needsPicker: false,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.internalCtl.abort();
  }
}
