/**
 * MountBackend interface — the central seam of the mount system.
 *
 * Four implementations live alongside this file: backend-local.ts (FS Access
 * API, wraps a FileSystemDirectoryHandle), backend-s3.ts (HTTP + SigV4),
 * backend-da.ts (HTTP + IMS bearer, Helix 5 da.live), and backend-aem.ts
 * (HTTP + IMS bearer, Helix 6 Source Bus). VirtualFS.mount() takes any of
 * them.
 *
 * See docs/superpowers/specs/2026-04-30-s3-da-mounts-design.md for the
 * design rationale; this file only declares the shapes.
 */

export type MountKind = 'local' | 'hostfs' | 's3' | 'da' | 'aem' | 'proc';

/**
 * Host-filesystem identity fields, when the backend has a real inode behind
 * the entry (hostfs only — the remote backends have no such thing).
 *
 * They exist for isomorphic-git: `compareStats` decides that a working-tree
 * file still matches its index entry by comparing mode/mtime/ctime/uid/gid/
 * ino/size, so a backend that reports only `{kind,size,mtime}` is stale for
 * every file and every read-only git command rewrites `.git/index` once per
 * file (issue #2708). Every field is optional; consumers must fall back to
 * the historical synthesized values when a backend omits them.
 */
export interface MountStatIdentity {
  /** Inode-change time, ms since epoch. Distinct from mtime on POSIX. */
  ctime?: number;
  /** Inode number. */
  ino?: number;
  uid?: number;
  gid?: number;
  /** Full POSIX `st_mode`, type bits included — carries the executable bit. */
  mode?: number;
}

/** A single entry returned by readDir() — file or synthesized directory. */
export interface MountDirEntry extends MountStatIdentity {
  name: string;
  kind: 'file' | 'directory';
  size?: number;
  /** Present on remote backends only — local entries don't expose etags. */
  etag?: string;
  /** ms since epoch. */
  lastModified?: number;
}

/** Result of a stat() call. */
export interface MountStat extends MountStatIdentity {
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
 *   - aem:   '<org>/<site>'
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
  /** URL form: 's3://bucket/prefix', 'da://org/repo', 'aem://org/site', undefined for local. */
  readonly source: string | undefined;
  readonly profile?: string;
  readonly mountId: string;

  readDir(path: string): Promise<MountDirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, body: Uint8Array): Promise<void>;
  stat(path: string): Promise<MountStat>;
  /** Always a no-op on S3 / DA / AEM — all three materialize paths on first write. */
  mkdir(path: string): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;

  /**
   * Optional native rename within this mount. VirtualFS.rename() routes a
   * same-mount rename here when present (currently hostfs only); backends
   * without it keep the historical behavior (rename inside a mount fails —
   * callers fall back to copy+delete).
   */
  rename?(fromPath: string, toPath: string): Promise<void>;

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
