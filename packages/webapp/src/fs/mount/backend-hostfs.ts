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
 * Requests address the mount by its SLICC target (`?mount=/mnt/project`)
 * plus a mount-relative path; the server refuses anything outside the
 * mapped root (traversal, symlink escapes). There is no client-side cache:
 * the bridge is loopback-fast and host files can change under us at any
 * time, so every operation is a live passthrough — which also means
 * external edits are visible immediately, unlike picker mounts.
 */

import { apiHeaders, resolveApiUrl } from '../../base/api-endpoint.js';
import { FsError, type FsErrorCode } from '../types.js';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  RefreshReport,
} from './backend.js';

/** Matches the server-side cap (node-server `HOSTFS_MAX_BODY_BYTES`). */
const HOSTFS_MAX_BODY_BYTES = 100 * 1024 * 1024;

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

export interface HostFsMountBackendOptions {
  /** SLICC target path this backend is mounted at, e.g. `/mnt/project`. */
  targetPath: string;
  /** OS folder as reported by the server (display only). */
  hostPath: string;
  mountId?: string;
  /** Injectable for tests; production uses the realm's fetch. */
  fetchImpl?: typeof fetch;
}

export class HostFsMountBackend implements MountBackend {
  readonly kind = 'hostfs' as const;
  readonly source: string;
  readonly mountId: string;

  private readonly targetPath: string;
  private readonly hostPath: string;
  private readonly fetchImpl: typeof fetch;
  private closed = false;

  constructor(opts: HostFsMountBackendOptions) {
    this.targetPath = opts.targetPath;
    this.hostPath = opts.hostPath;
    this.source = `hostfs://${opts.hostPath}`;
    this.mountId = opts.mountId ?? crypto.randomUUID();
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
   * Execute one bridge request. Non-2xx responses carry `{ code, message }`
   * which is rethrown as a faithful FsError; envelope failures (server not
   * running, network refused) surface as EIO so callers can distinguish
   * "file missing" from "bridge missing".
   */
  private async request(
    op: string,
    path: string,
    init?: RequestInit & { extra?: Record<string, string> }
  ): Promise<Response> {
    this.assertOpen(path);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(op, path, init?.extra), {
        ...init,
        headers: apiHeaders(init?.headers as Record<string, string> | undefined),
      });
    } catch (err) {
      throw new FsError(
        'EIO',
        `hostfs bridge unreachable: ${err instanceof Error ? err.message : String(err)}`,
        path
      );
    }
    if (!response.ok) {
      let code: FsErrorCode = 'EIO';
      let message = `hostfs ${op} failed with HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { code?: unknown; message?: unknown };
        if (typeof body.code === 'string' && KNOWN_CODES.has(body.code)) {
          code = body.code as FsErrorCode;
        }
        if (typeof body.message === 'string') message = body.message;
      } catch {
        /* non-JSON error body — keep the HTTP-status message */
      }
      throw new FsError(code, message, path);
    }
    return response;
  }

  async readDir(path: string): Promise<MountDirEntry[]> {
    const response = await this.request('list', path);
    const body = (await response.json()) as { entries?: unknown };
    if (!Array.isArray(body.entries)) return [];
    const entries: MountDirEntry[] = [];
    for (const raw of body.entries) {
      const e = raw as { name?: unknown; kind?: unknown; size?: unknown; lastModified?: unknown };
      if (typeof e.name !== 'string' || (e.kind !== 'file' && e.kind !== 'directory')) continue;
      entries.push({
        name: e.name,
        kind: e.kind,
        ...(typeof e.size === 'number' ? { size: e.size } : {}),
        ...(typeof e.lastModified === 'number' ? { lastModified: e.lastModified } : {}),
      });
    }
    return entries;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const response = await this.request('read', path);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > HOSTFS_MAX_BODY_BYTES) {
      throw new FsError('EFBIG', 'file exceeds the hostfs body cap', path);
    }
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, body: Uint8Array): Promise<void> {
    if (body.byteLength > HOSTFS_MAX_BODY_BYTES) {
      throw new FsError('EFBIG', 'body exceeds the hostfs body cap', path);
    }
    await this.request('write', path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      // Copy into a plain ArrayBuffer-backed view so fetch never sees a
      // SharedArrayBuffer-backed slice (kernel worker buffers can be).
      body: new Uint8Array(body),
    });
  }

  async stat(path: string): Promise<MountStat> {
    const response = await this.request('stat', path);
    const body = (await response.json()) as { kind?: unknown; size?: unknown; mtime?: unknown };
    return {
      kind: body.kind === 'directory' ? 'directory' : 'file',
      size: typeof body.size === 'number' ? body.size : 0,
      mtime: typeof body.mtime === 'number' ? body.mtime : 0,
    };
  }

  async mkdir(path: string): Promise<void> {
    await this.request('mkdir', path, { method: 'POST' });
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    await this.request('rename', fromPath, {
      method: 'POST',
      extra: { to: toPath.replace(/^\/+/, '') },
    });
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await this.request('remove', path, {
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
