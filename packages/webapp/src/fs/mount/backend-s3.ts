/**
 * S3MountBackend — signing-naive HTTP mount implementation.
 *
 * Implements MountBackend for S3-compatible services (AWS S3, Cloudflare R2,
 * MinIO, etc.). The backend never holds credentials and never computes
 * signatures. It builds *logical* requests (`{bucket, key, method, query,
 * headers, body}`) and hands them to an injected `SignedFetchS3` transport,
 * which is wired at runtime to:
 *
 *   - CLI/Electron: HTTP POST to node-server's `/api/s3-sign-and-forward`
 *   - Extension: `chrome.runtime.sendMessage` to the service worker
 *   - Tests: a helper that signs locally with a fake profile + mocked fetch
 *
 * URL construction (virtual-hosted vs path-style, region/endpoint resolution)
 * lives entirely in the transport. The backend supplies bucket + S3 key only.
 *
 * Auth retry was previously handled here by re-resolving the profile and
 * retrying once on 401/403. With server-side signing, the server reads from
 * its secret store fresh on every call — there is no stale cached profile to
 * retry against. 401/403 from upstream surfaces as `EACCES` directly.
 */

import { FsError } from '../types.js';
import type {
  MountBackend,
  MountDirEntry,
  MountStat,
  MountDescription,
  RefreshReport,
} from './backend.js';
import { type RemoteMountCache } from './remote-cache.js';

/**
 * A logical S3 request handed to the transport. The transport decides on
 * virtual-hosted vs path-style URL construction, region/endpoint resolution,
 * and SigV4 signing.
 */
export interface SignedFetchS3Request {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  bucket: string;
  /** Full S3 key including any prefix. Empty string for bucket-root operations. */
  key: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

/**
 * Transport function: signs and executes a logical S3 request, returns the
 * upstream Response. Throws `FsError` for envelope-level failures (profile
 * not configured, network failure to localhost / SW, etc.) — successful
 * upstream responses (including 4xx/5xx from S3 itself) are returned as
 * Responses so the backend can branch on status.
 */
export type SignedFetchS3 = (req: SignedFetchS3Request) => Promise<Response>;

export interface S3MountBackendOptions {
  /** Original 's3://bucket/prefix' source URI (for describe()). */
  source: string;
  /** Profile name (display only — credentials live server-side). */
  profile: string;
  cache: RemoteMountCache;
  /** Reasonable defaults: 25 MiB. */
  maxBodyBytes?: number;
  /** Required: signs and forwards each request. */
  signedFetch: SignedFetchS3;
}

interface ParsedSource {
  bucket: string;
  prefix: string; // no leading or trailing '/'
}

function parseS3Source(source: string): ParsedSource {
  const m = source.match(/^s3:\/\/([^/]+)(?:\/(.*))?$/);
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
  private readonly cache: RemoteMountCache;
  private readonly maxBodyBytes: number;
  private readonly transport: SignedFetchS3;
  private closed = false;

  constructor(opts: S3MountBackendOptions & { mountId?: string }) {
    this.source = opts.source;
    this.profile = opts.profile;
    this.mountId = opts.mountId ?? crypto.randomUUID();
    this.parsed = parseS3Source(opts.source);
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

  /** Map a mount-relative path to the full S3 key (with the mount's prefix). */
  private toS3Key(mountRelative: string): string {
    const clean = mountRelative.replace(/^\/+/, '').replace(/\/+$/, '');
    return [this.parsed.prefix, clean].filter((s) => s.length > 0).join('/');
  }

  /** Inverse of toS3Key — strip the mount prefix from a full S3 key. */
  private toMountRelativeKey(s3Key: string): string {
    return this.parsed.prefix ? s3Key.slice(this.parsed.prefix.length + 1) : s3Key;
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
      bucket: this.parsed.bucket,
      key: this.toS3Key(rel),
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
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength),
    };
    if (cached) {
      headers['if-match'] = cached.etag;
    } else {
      headers['if-none-match'] = '*';
    }

    const tryOnce = (): Promise<Response> =>
      this.transport({
        method: 'PUT',
        bucket: this.parsed.bucket,
        key: this.toS3Key(rel),
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
        // 412 inside the bounded retry window: our prior PUT may have already
        // landed; reconcile the cache silently. HEAD to learn the new etag.
        const headRes = await this.transport({
          method: 'HEAD',
          bucket: this.parsed.bucket,
          key: this.toS3Key(rel),
        });
        if (headRes.status >= 400) {
          throw new FsError('EIO', `s3 reconcile HEAD failed: ${headRes.status}`, path);
        }
        const newEtag = headRes.headers.get('etag') ?? '';
        await this.cache.putBody(rel, body, newEtag);
        const parent = rel.split('/').slice(0, -1).join('/');
        await this.cache.invalidateListing(parent);
        return;
      }
      // First-attempt 412: external writer changed the file. Refresh cache and
      // surface EBUSY so the agent's edit loop can re-read.
      await this.cache.invalidateBody(rel);
      try {
        await this.readFile(path);
      } catch {
        // Cache refresh is best-effort; the EBUSY below is the actionable signal.
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
    const parent = rel.split('/').slice(0, -1).join('/');
    await this.cache.invalidateListing(parent);
  }

  private async listObjectsV2(): Promise<
    { key: string; etag: string; size: number; lastModified: number }[]
  > {
    const all: { key: string; etag: string; size: number; lastModified: number }[] = [];
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2' };
      if (this.parsed.prefix) {
        query.prefix = `${this.parsed.prefix}/`;
      }
      if (continuationToken) {
        query['continuation-token'] = continuationToken;
      }
      const res = await this.transport({
        method: 'GET',
        bucket: this.parsed.bucket,
        key: '',
        query,
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
      const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1] ?? '';
      const etag = block.match(/<ETag>([^<]+)<\/ETag>/)?.[1] ?? '';
      const sizeStr = block.match(/<Size>([^<]+)<\/Size>/)?.[1] ?? '0';
      const lmStr = block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? '';
      contents.push({
        key,
        etag,
        size: Number(sizeStr),
        lastModified: lmStr ? Date.parse(lmStr) : 0,
      });
    }
    const truncated = xml.match(/<IsTruncated>([^<]+)<\/IsTruncated>/)?.[1] === 'true';
    const nextContinuationToken = truncated
      ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
      : undefined;
    return { contents, nextContinuationToken };
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

    // 1. Body cache — instant return when the file was read recently.
    const cached = await this.cache.getBody(rel);
    if (cached) {
      return {
        kind: 'file',
        size: cached.body.byteLength,
        mtime: cached.cachedAt,
        etag: cached.etag,
      };
    }

    // 2. Parent listing cache — `ListObjectsV2` includes size/etag/
    //    lastModified per key, so if the parent directory was walked
    //    recently we can answer stat() without a network HEAD. Avoids
    //    per-file HEAD spam after a `readDir` (e.g. `ls -l` stat()s
    //    every entry it just listed).
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
        // Fresh authoritative listing without this entry → ENOENT.
        throw new FsError('ENOENT', 'no such file or directory', path);
      }
      // Else: listing has the file but lacks size (defensive — shouldn't
      // happen with ListObjectsV2 but covers future server changes).
      // Fall through to HEAD.
    }

    // 3. Last resort — network HEAD.
    const res = await this.transport({
      method: 'HEAD',
      bucket: this.parsed.bucket,
      key: this.toS3Key(rel),
    });
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

    const report: RefreshReport = {
      added: [],
      removed: [],
      changed: [],
      unchanged: 0,
      errors: [],
    };

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
    const res = await this.transport({
      method: 'DELETE',
      bucket: this.parsed.bucket,
      key: this.toS3Key(rel),
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
    const parent = rel.split('/').slice(0, -1).join('/');
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
  }
}
