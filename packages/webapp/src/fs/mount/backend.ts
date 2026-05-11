/**
 * MountBackend interface — the central seam of the mount system.
 *
 * Three implementations live alongside this file: backend-local.ts (FS Access
 * API, wraps a FileSystemDirectoryHandle), backend-s3.ts (HTTP + SigV4),
 * backend-da.ts (HTTP + IMS bearer). VirtualFS.mount() takes any of them.
 *
 * See docs/superpowers/specs/2026-04-30-s3-da-mounts-design.md for the
 * design rationale; this file only declares the shapes.
 */

export type MountKind = 'local' | 's3' | 'da' | 'proc';

/** A single entry returned by readDir() — file or synthesized directory. */
export interface MountDirEntry {
  name: string;
  kind: 'file' | 'directory';
  size?: number;
  /** Present on remote backends only — local entries don't expose etags. */
  etag?: string;
  /** ms since epoch. */
  lastModified?: number;
}

/** Result of a stat() call. */
export interface MountStat {
  kind: 'file' | 'directory';
  size: number;
  /** ms since epoch. */
  mtime: number;
  etag?: string;
}

/** Summary returned by refresh(). */
export interface RefreshReport {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  errors: { path: string; message: string }[];
}

/**
 * Description for non-interactive output paths — `mount list`, log lines,
 * recovery prompts, telemetry, the `Mounted '<displayName>' → <path>` line.
 *
 * `displayName` is always present; backends derive it as follows:
 *   - local: picked directory's `name`
 *   - s3:    '<bucket>/<prefix>' (or just '<bucket>' if no prefix)
 *   - da:    '<org>/<repo>'
 */
export interface MountDescription {
  displayName: string;
  source?: string;
  profile?: string;
  /** Optional extra info for `mount list` (e.g. index status). */
  extra?: string;
}

export interface MountBackend {
  readonly kind: MountKind;
  /** URL form: 's3://bucket/prefix', 'da://org/repo', undefined for local. */
  readonly source: string | undefined;
  readonly profile?: string;
  readonly mountId: string;

  readDir(path: string): Promise<MountDirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, body: Uint8Array): Promise<void>;
  stat(path: string): Promise<MountStat>;
  /** Always a no-op on S3 / DA — both APIs materialize paths on first write. */
  mkdir(path: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;

  /**
   * Re-walk the source and reconcile cache. With opts.bodies, also
   * conditional-GET each changed file's body to refresh the body cache.
   */
  refresh(opts?: { bodies?: boolean }): Promise<RefreshReport>;

  describe(): MountDescription;

  /**
   * Lifecycle: marks the backend closed (subsequent ops throw EBADF), aborts
   * in-flight requests via the internal AbortController, drains pending
   * promises, releases listeners. Cache entries persist in IDB until natural
   * TTL eviction or a `mount unmount --clear-cache`.
   */
  close(): Promise<void>;
}
