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

/**
 * A single entry returned by readDir() — file or synthesized directory.
 *
 * Every field beyond `name`/`kind` is optional and a consumer must be able to
 * work without it. Which of them arrive depends on the backend *and* on
 * `ReadDirOptions.includeStats`: the HTTP backends get size/mtime for free in
 * the listing response and always report them, while the File System Access
 * backend has to spend one `getFile()` IPC per entry and therefore reports
 * them only when they were asked for (issue #2733).
 */
export interface MountDirEntry extends MountStatIdentity {
  name: string;
  kind: 'file' | 'directory';
  size?: number;
  /** Present on remote backends only — local entries don't expose etags. */
  etag?: string;
  /** ms since epoch. */
  lastModified?: number;
}

/** Options for `MountBackend.readDir`. */
export interface ReadDirOptions {
  /**
   * Ask the backend to fill `size`/`lastModified` on file entries.
   *
   * Off by default because the largest caller — isomorphic-git's `readdir`,
   * whose contract is names-only — throws them away, and on an FSA mount
   * gathering them costs one IPC per entry: `git log --all` over the slicc
   * checkout listed `objects/pack` (91 entries) ~25,000 times for 2.29 M
   * `getFile()` calls / 370 s of pure metadata (#2733).
   *
   * A backend that already has the stats may ignore this and report them
   * anyway; a backend that does not must omit the fields when it is unset,
   * never substitute zeros — a zeroed size/mtime makes isomorphic-git's
   * `compareStats` call every file stale and rewrite `.git/index` (#2708).
   */
  includeStats?: boolean;
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
  /**
   * Opt-in: when this backend's `readDir` *does* report `size`/`lastModified`
   * (and related identity fields), those numbers equal what its `stat`
   * would return for the same path — so `VirtualFS` may promote them onto
   * the `DirEntry` and consumers may use them in place of a stat (#2716).
   *
   * Presence of the fields is per-call (see {@link ReadDirOptions.includeStats}):
   * FSA listings omit them unless asked, HTTP listings carry them for free.
   * This flag only answers "when present, are they trustworthy?", not
   * "will every listing carry them?".
   *
   * Default (absent/false) keeps the historical `{name, type}` listing. The
   * flag exists because two backends deliberately answer `stat` from a
   * different source than their listing, and promoting their listing fields
   * would silently change what `stat` reports:
   *   - S3 answers `stat` from the body cache when it has one, whose `mtime`
   *     is `cachedAt` — when the body was cached, not the object's mtime.
   *   - AEM does the same AND reports the *decoded* size there, while a
   *     Source Bus listing carries the stored (compressed) size.
   *
   * `hostfs` (both bridges stat each dirent server-side) and `local` (both
   * paths read `FileSystemFileHandle.getFile()`) do guarantee equivalence
   * and set it. Aligning S3/AEM's two sources is a separate change; until
   * then they keep costing a stat rather than answering a different number.
   */
  readonly listingStatsMatchStat?: boolean;
  /** URL form: 's3://bucket/prefix', 'da://org/repo', 'aem://org/site', undefined for local. */
  readonly source: string | undefined;
  readonly profile?: string;
  readonly mountId: string;

  readDir(path: string, opts?: ReadDirOptions): Promise<MountDirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, body: Uint8Array): Promise<void>;

  /**
   * Optional native byte-range read of `[start, end)` — half-open, like
   * `subarray`, so `end - start` is the length. Present on hostfs only, where
   * it becomes an HTTP `Range` request.
   *
   * It exists for git: isomorphic-git wants a packfile as one buffer, so a
   * repo whose largest pack exceeds the bridge's whole-file cap was entirely
   * unreadable, and even a pack under the cap cost its full size in kernel-
   * worker memory on every object lookup (issue #2711). `VirtualFS
   * .readFileRange` falls back to reading the whole file and slicing for
   * backends that omit this, so callers never have to branch — but only a
   * backend that implements it actually saves the bytes.
   */
  readFileRange?(path: string, start: number, end: number): Promise<Uint8Array>;
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
