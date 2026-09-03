/**
 * RestrictedFS — wraps VirtualFS with path access control.
 * Used to restrict scoops to their own directories + /shared/.
 *
 * Read operations (stat, exists, readFile, readDir, readTextFile, walk)
 * return "not found" / empty for paths outside allowed areas. This lets
 * the shell probe freely (PATH resolution, command lookup) without errors.
 *
 * Write operations come in two flavors selected at construction:
 *   - `writeEnforcement: 'hard'` (default) — throw EACCES for any write
 *     outside the writable prefixes. Used in standalone tests and any
 *     code path that does not stack a `SudoFS` on top.
 *   - `writeEnforcement: 'sudo-delegated'` — pass non-symlink writes
 *     through to the underlying VFS so an outer `SudoFS` can escalate
 *     out-of-sandbox writes to a cone-mediated approval instead of a
 *     hard wall. The symlink-escape EACCES (a security invariant
 *     against `/scoops/<f>/link -> /etc/sudoers` style escapes) stays
 *     in place either way.
 */

import { EphemeralFdStore } from './ephemeral-fd-store.js';
import type { FsWatchCallback, FsWatchFilter } from './fs-watcher.js';
import type { MountBackend, ReadDirOptions, RefreshReport } from './mount/backend.js';
import type { MountIndexEnv } from './mount-index.js';
import { normalizePath, pathGlobToRegExp } from './path-utils.js';
import type {
  DirEntry,
  FileContent,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Stats,
} from './types.js';
import { FsError } from './types.js';
import { DEV_NULL } from './virtual-device-paths.js';
import type { VirtualFS } from './virtual-fs.js';

export type RestrictedFsWriteEnforcement = 'hard' | 'sudo-delegated';

/**
 * Construction options beyond the path lists and write-enforcement mode.
 *
 * `includeMounts` defaults to `true` so existing call sites (and today's
 * `shared-readonly` scoops) keep seeing every VFS mount as a readable
 * prefix. `private` isolation turns it off so a mount cannot silently
 * expand a child's authority (#2277).
 */
export interface RestrictedFsOptions {
  includeMounts?: boolean;
}

// ── Virtual device files (/dev/*) ─────────────────────────────────────
//
// Device files are always accessible regardless of sandbox ACLs. To add a
// new device, add an entry to VIRTUAL_DEVICES keyed by its full path. Paths
// whose write is a no-op live in `virtual-device-paths.ts` (the single source
// of truth shared with the sudoers matcher) so the key never drifts.

interface VirtualDevice {
  stat(): Stats;
  read(options?: ReadFileOptions): FileContent;
  readText(): string;
  write(content: FileContent): void;
}

const VIRTUAL_DEVICES: Record<string, VirtualDevice> = {
  [DEV_NULL]: {
    stat: () => ({ type: 'file', size: 0, mtime: 0, ctime: 0 }),
    read: (options?) => ((options?.encoding ?? 'utf-8') === 'utf-8' ? '' : new Uint8Array(0)),
    readText: () => '',
    write: () => {},
  },
};

/**
 * Prefixes every sandbox may read AND write regardless of its configured
 * ACLs. `/tmp` is global scratch space in SLICC the same way it is on Unix:
 * tooling hardcodes `/tmp/<file>` rather than discovering a scratch dir, and
 * a scoop must not need a sudo escalation to do the obvious thing.
 *
 * This space is deliberately SHARED, not per-scoop — scoops can read and
 * overwrite each other's scratch files, and the cone sees all of them, so
 * nothing secret or trust-bearing belongs here.
 *
 * SudoFS gates independently of this class, so the sandbox surface has to
 * agree in both layers: the matching unconditional `NOPASSWD Read/Write`
 * grants live in `builtinScoopGrants()` (`base/sudoers.ts`), merged in by
 * `SudoManager.getPolicyForScoop`. Changing one without the other either
 * re-introduces the approval prompt or walls the write underneath it.
 *
 * They are deliberately NOT part of the per-scoop config grants — those are
 * compiled from each scoop's own `ScoopConfig`, while `/tmp` applies to every
 * scoop unconditionally.
 *
 * This list is for TREE locations only. The shell's `/dev/fd/<n>` descriptors
 * are also writable in every sandbox, but they are not here and must not be:
 * see {@link RestrictedFS.ephemeralFds} for why they are answered beside the
 * tree instead, and why widening this list to `/dev/` would be the wrong fix.
 */
const ALWAYS_WRITABLE_PREFIXES = ['/tmp/'];

export class RestrictedFS {
  /**
   * Private backing for the shell's `/dev/fd/<n>` process-substitution
   * descriptors. They are answered here — beside the tree, never in it —
   * rather than through the ACL, because a descriptor is minted by the shell
   * for one command and its bytes are read straight back by the consuming
   * command in the same pipeline (#2502).
   *
   * Deliberately NOT an `ALWAYS_WRITABLE_PREFIXES` entry: widening that list
   * to `/dev/` would permit writes to every future device path, including ones
   * with observable effects, and would resolve them against the SHARED tree,
   * where a scoop's descriptor is visible to the cone and to sibling scoops.
   * Deliberately not a `VIRTUAL_DEVICES` entry either — a no-op write would
   * discard a payload that is about to be read back.
   *
   * The matching sudoers exemption is `isEphemeralFdPath` in `matchPath`
   * (`base/sudoers.ts`). Both layers gate independently, so both have to agree:
   * granting only here leaves a scoop write escalating to a cone approval
   * prompt no "Always" grant can pre-empt (the fd number changes per
   * invocation); exempting only there leaves the consumer's open walled to
   * `ENOENT` while the write silently lands outside the sandbox.
   */
  private readonly ephemeralFds = new EphemeralFdStore();
  private vfs: VirtualFS;
  private allowedPrefixes: string[];
  private readOnlyPrefixes: string[];
  private readGrantPatterns: Array<{ pattern: string; regex: RegExp; ancestorRegexes: RegExp[] }> =
    [];
  private writeEnforcement: RestrictedFsWriteEnforcement;
  private includeMounts: boolean;

  constructor(
    vfs: VirtualFS,
    allowedPaths: string[],
    readOnlyPaths: string[] = [],
    writeEnforcement: RestrictedFsWriteEnforcement = 'hard',
    options: RestrictedFsOptions = {}
  ) {
    this.vfs = vfs;
    const normalize = (p: string) => {
      const n = normalizePath(p);
      return n.endsWith('/') ? n : n + '/';
    };
    this.allowedPrefixes = allowedPaths.map(normalize);
    this.readOnlyPrefixes = readOnlyPaths.map(normalize);
    this.writeEnforcement = writeEnforcement;
    this.includeMounts = options.includeMounts !== false;
  }

  /** Get all prefixes, optionally including dynamic mount paths (as read-only). */
  private getAllPrefixes(): string[] {
    const mountPrefixes = this.includeMounts
      ? this.vfs.listMounts().map((p) => (p.endsWith('/') ? p : p + '/'))
      : [];
    return [
      ...this.allowedPrefixes,
      ...this.readOnlyPrefixes,
      ...mountPrefixes,
      ...ALWAYS_WRITABLE_PREFIXES,
    ];
  }

  /**
   * Replace dynamic read grants from the current sudoers policy. Ancestor
   * matchers let directory traversal and filtered `readDir` calls reach
   * matching files without exposing non-matching siblings.
   */
  setReadGrants(patterns: readonly string[]): void {
    this.readGrantPatterns = [];
    for (const pattern of new Set(patterns)) {
      this.addReadGrant(pattern);
    }
  }

  private addReadGrant(pattern: string): void {
    const segments = pattern.split('/');
    const ancestorRegexes: RegExp[] = [];
    for (let i = 1; i < segments.length; i++) {
      ancestorRegexes.push(pathGlobToRegExp(segments.slice(0, i).join('/') || '/'));
    }
    this.readGrantPatterns.push({
      pattern,
      regex: pathGlobToRegExp(pattern),
      ancestorRegexes,
    });
  }

  private matchesReadGrant(path: string): boolean {
    return this.readGrantPatterns.some((grant) => grant.regex.test(path));
  }

  private leadsToReadGrant(path: string): boolean {
    return this.readGrantPatterns.some((grant) =>
      grant.ancestorRegexes.some((regex) => regex.test(path))
    );
  }

  /** Check if a path is within or is a parent of allowed or read-only prefixes. */
  private isAllowed(path: string): boolean {
    const normalized = normalizePath(path);
    const allPrefixes = this.getAllPrefixes();
    return (
      this.matchesReadGrant(normalized) ||
      this.leadsToReadGrant(normalized) ||
      allPrefixes.some(
        (prefix) =>
          normalized === prefix.slice(0, -1) ||
          normalized.startsWith(prefix) ||
          normalized === '/' ||
          prefix.startsWith(normalized + '/')
      )
    );
  }

  /** Check if a path is within allowed or read-only prefixes (strict — no parent access). */
  private isAllowedStrict(path: string): boolean {
    const normalized = normalizePath(path);
    const allPrefixes = this.getAllPrefixes();
    return (
      this.matchesReadGrant(normalized) ||
      allPrefixes.some(
        (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
      )
    );
  }

  /** Check if a path is within read-write prefixes only (excludes read-only). */
  private isWritable(path: string): boolean {
    const normalized = normalizePath(path);
    return [...this.allowedPrefixes, ...ALWAYS_WRITABLE_PREFIXES].some(
      (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
    );
  }

  /**
   * Public writability predicate. Returns `true` when this RestrictedFS
   * would accept a write op at `path` under its current ACL (mirrors the
   * prefix check used internally by {@link checkWrite}, minus the thrown
   * error). Callers use this to validate intent BEFORE delegating an op
   * that the restricted fs itself cannot gate — e.g., the `agent` shell
   * command must ensure the caller can write to `cwd` before handing it to
   * the orchestrator bridge, because `stat(cwd)` succeeds on parent dirs
   * of the sandbox (needed for PATH traversal) and would otherwise let a
   * scoop escape by passing `/scoops` as `cwd`.
   *
   * Symlink targets are NOT followed here; callers that need escape-proof
   * semantics should pair this with a `realpath` resolution first. For the
   * `agent` command's use case (validating a cwd token), prefix-level
   * matching is sufficient — the orchestrator builds a RestrictedFS with
   * the resolved cwd as a writable prefix anyway.
   */
  canWrite(path: string): boolean {
    // Ephemeral descriptors are writable without being part of the ACL — see
    // {@link ephemeralFds}. Reporting them as writable keeps this predicate
    // honest about what `writeFile` will actually accept.
    return EphemeralFdStore.handles(path) || this.isWritable(path);
  }

  /**
   * Gate a write at the ACL boundary. Under `'hard'` enforcement an
   * out-of-sandbox write throws `EACCES` synchronously. Under
   * `'sudo-delegated'` the check is a no-op — the outer `SudoFS` has
   * already gated the write via the per-scoop policy (with default
   * disposition `'require-approval'` so unmatched writes escalate to
   * the cone instead of failing closed here).
   */
  private checkWrite(path: string): void {
    if (this.writeEnforcement === 'sudo-delegated') return;
    if (!this.isWritable(path)) {
      throw new FsError('EACCES', 'permission denied', normalizePath(path));
    }
  }

  /** Resolve symlinks and verify the resolved path is still within allowed read areas. */
  private async resolveAndCheckRead(path: string): Promise<string> {
    try {
      const resolved = await this.vfs.realpath(path);
      if (!this.isAllowedStrict(resolved)) {
        throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
      }
      return resolved;
    } catch (err) {
      if (err instanceof FsError) throw err;
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
  }

  /**
   * Resolve symlinks and verify the resolved path is still within writable
   * areas. Symlink-escape detection stays active in both enforcement modes —
   * an in-sandbox symlink that resolves to (e.g.) `/etc/sudoers` is a
   * security escape, not a policy choice, and the outer SudoFS only sees
   * the un-resolved link path.
   */
  private async resolveAndCheckWrite(path: string): Promise<string> {
    try {
      const resolved = await this.vfs.realpath(path);
      if (!this.isWritable(resolved) && !this.isSymlinkEscapeAllowed(resolved)) {
        throw new FsError('EACCES', 'permission denied', normalizePath(path));
      }
      return resolved;
    } catch (err) {
      if (err instanceof FsError) throw err;
      throw new FsError('EACCES', 'permission denied', normalizePath(path));
    }
  }

  /**
   * Under `'sudo-delegated'` enforcement, an in-sandbox path that resolves
   * to an out-of-sandbox target is still rejected here — sudo gated the
   * link path, not the resolved one. This helper exists so the future
   * `RealpathAwareSudoFS` (if added) can opt the symlink-escape check out
   * by overriding the predicate; today it always returns `false`.
   */
  private isSymlinkEscapeAllowed(_resolved: string): boolean {
    return false;
  }

  /**
   * Verify the parent dir's realpath doesn't escape the sandbox. In hard
   * mode, throws `EACCES` whenever the resolved file path is not writable.
   * In sudo-delegated mode, the check fires ONLY when symlink resolution
   * actually changed the path — sudo has already gated the literal path,
   * so a plain out-of-sandbox write is the outer gate's call to escalate.
   * A realpath mismatch always means a symlink escape (e.g., the parent is
   * a symlink to `/etc/sudoers.d`), which is a security invariant.
   */
  private async checkParentRealpathEscape(path: string): Promise<void> {
    const dir = this.vfs.dirname(path);
    const base = this.vfs.basename(path);
    let resolvedDir: string;
    try {
      resolvedDir = await this.vfs.realpath(dir);
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
      // Parent doesn't exist yet — let the underlying write surface the error.
      return;
    }
    const resolvedPath = resolvedDir + '/' + base;
    if (this.isWritable(resolvedPath)) return;
    const symlinkChanged = normalizePath(resolvedDir) !== normalizePath(dir);
    if (this.writeEnforcement === 'sudo-delegated' && !symlinkChanged) return;
    throw new FsError('EACCES', 'permission denied', normalizePath(path));
  }

  /** Get the underlying unrestricted VirtualFS (cone-only escape hatch). */
  getUnderlyingFS(): VirtualFS {
    return this.vfs;
  }

  invalidatePaths(paths: string[]): void {
    this.vfs.invalidatePaths(paths);
  }

  /** Persist backend-owned metadata; this operation is not path-selected. */
  async flush(): Promise<void> {
    await this.vfs.flush();
  }

  /**
   * Mount-membership query — needed by the isomorphic-git fs adapter,
   * which routes mount-backed paths through the async VFS API instead of
   * raw LightningFS. Delegates to the underlying VirtualFS; this is a
   * read-only query with no sandbox security implications (scoops
   * typically have no mounts, so it returns `false` for all their paths).
   */
  isPathUnderMount(path: string): boolean {
    return this.vfs.isPathUnderMount(path);
  }

  // ── Read operations: return "not found" for outside paths ────────────

  async readFile(path: string, options?: ReadFileOptions): Promise<FileContent> {
    const devRead = VIRTUAL_DEVICES[normalizePath(path)];
    if (devRead) return devRead.read(options);
    if (EphemeralFdStore.handles(path)) return this.ephemeralFds.read(path, options);
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    const resolved = await this.resolveAndCheckRead(path);
    return this.vfs.readFile(resolved, options);
  }

  /**
   * Byte-window read, gated exactly like `readFile`.
   *
   * The shell hands its `fs` to the isomorphic-git adapter, and that `fs` is a
   * RestrictedFS for every scoop — so a surface that exists only on VirtualFS
   * would be a `TypeError` the moment git took the ranged path (#2711). No
   * virtual-device or ephemeral-fd cases: neither has a stable byte offset to
   * seek into, so a window over them is meaningless and they fall through to
   * the same ENOENT an out-of-sandbox path gets.
   */
  async readFileRange(path: string, start: number, end: number): Promise<Uint8Array> {
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    const resolved = await this.resolveAndCheckRead(path);
    return this.vfs.readFileRange(resolved, start, end);
  }

  async readDir(path: string, opts?: ReadDirOptions): Promise<DirEntry[]> {
    if (!this.isAllowed(path)) return [];
    // Resolve symlinks on the directory path itself when strictly allowed
    let resolvedPath = path;
    if (this.isAllowedStrict(path)) {
      try {
        resolvedPath = await this.resolveAndCheckRead(path);
      } catch {
        return [];
      }
    }
    const entries = await this.vfs.readDir(resolvedPath, opts);
    // If this is a parent dir (not strictly allowed), filter to only entries
    // that lead toward allowed paths
    if (!this.isAllowedStrict(path)) {
      const normalized = normalizePath(path);
      return entries.filter((e) => {
        const childPath = normalized === '/' ? `/${e.name}` : `${normalized}/${e.name}`;
        return this.isAllowed(childPath);
      });
    }
    return entries;
  }

  async stat(path: string): Promise<Stats> {
    const dev = VIRTUAL_DEVICES[normalizePath(path)];
    if (dev) return dev.stat();
    if (EphemeralFdStore.handles(path)) return this.ephemeralFds.stat(path);
    if (!this.isAllowed(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    if (this.isAllowedStrict(path)) {
      const resolved = await this.resolveAndCheckRead(path);
      return this.vfs.stat(resolved);
    }
    return this.vfs.stat(path);
  }

  // ── Synchronous fast-path methods (VfsAdapter contract) ─────────────
  //
  // `VfsAdapter` (shell/vfs-adapter.ts) calls `statSync`, `lstatSync`,
  // and `readDirSync` on its `vfs` field before falling back to the
  // async counterparts. Non-cone scoops pass a `RestrictedFS` as that
  // field (cast to `VirtualFS` in `scoop-context.ts`). These methods
  // must therefore exist here too, enforce the same ACL as the async
  // methods, and return `null` (matching `VirtualFS`'s null semantics)
  // for disallowed or fast-path-unavailable paths — never throw.

  /**
   * Walk each path segment via `vfs.lstatSync` and detect whether the
   * path traverses through (or ends at, when `includeLeaf` is true) a
   * symlink.
   *
   * Returns:
   *   - `true`  if a symlink was found in the scanned scope. Callers
   *     should return `null` so `VfsAdapter` falls back to the async
   *     path, which enforces symlink-escape ACL via
   *     `resolveAndCheckRead` (VAL-FS-019 semantics).
   *   - `false` if no symlink was found — safe to use the sync fast
   *     path.
   *   - `null`  if any segment could not be `lstatSync`-ed (e.g., the
   *     path is under a mount, CacheFS fast path is unavailable, or the
   *     segment does not exist). Callers should also return `null` to
   *     force the async fallback, which handles these cases cleanly.
   *
   * Without this scan, a symlink INSIDE an allowed prefix whose target
   * escapes every allowed prefix (e.g., `/shared/link-to-other-scoop`
   * → `/scoops/other-scoop`) would let callers enumerate or read the
   * escape target through the sync shell fast path — the exact
   * symlink-escape regression VAL-FS-019 guards against on the async
   * path.
   */
  private scanPathForSymlinks(path: string, includeLeaf: boolean): boolean | null {
    const normalized = normalizePath(path);
    if (normalized === '/') return false;
    const segs = normalized.slice(1).split('/');
    const limit = includeLeaf ? segs.length : segs.length - 1;
    let current = '';
    for (let i = 0; i < limit; i++) {
      current = current + '/' + segs[i];
      const s = this.vfs.lstatSync(current);
      if (s === null) {
        // Segment missing OR fast path unavailable — force async fallback
        // so the caller uses the safe async code path.
        return null;
      }
      if (s.type === 'symlink') return true;
    }
    return false;
  }

  /**
   * Synchronous stat (follows symlinks) — VfsAdapter fast path.
   * Returns null for disallowed paths (matches VirtualFS null semantics
   * so the adapter can fall back to the async path cleanly).
   *
   * Also returns null when the path traverses (or ends at) any symlink
   * — the async `stat()` path will then resolve + ACL-check the
   * canonical path through `resolveAndCheckRead` (VAL-FS-019).
   */
  statSync(path: string): Stats | null {
    const dev = VIRTUAL_DEVICES[normalizePath(path)];
    if (dev) return dev.stat();
    // An ephemeral descriptor lives outside the tree, so the sync fast path can
    // answer for it directly; `null` for one that was never written falls back
    // to the async `stat`, which raises the ENOENT the caller expects.
    if (EphemeralFdStore.handles(path)) {
      return this.ephemeralFds.has(path) ? this.ephemeralFds.stat(path) : null;
    }
    if (!this.isAllowedStrict(path)) return null;
    // Scan ancestors AND leaf: `statSync` follows symlinks (via
    // `resolveSymlinksSync`), so a symlink anywhere in the path can
    // escape the ACL. If any is found, force async fallback.
    const scan = this.scanPathForSymlinks(path, true);
    if (scan !== false) return null;
    return this.vfs.statSync(path);
  }

  /**
   * Synchronous lstat (does NOT follow symlinks) — VfsAdapter fast path.
   * Returns null for disallowed paths.
   *
   * `lstat` does not follow the leaf symlink, so the leaf being a
   * symlink is safe. However, ancestors ARE followed by CacheFS's
   * internal `_lookup`, so an ancestor symlink escaping the ACL would
   * still leak the resolved node. Scan ancestors only.
   */
  lstatSync(path: string): Stats | null {
    const dev = VIRTUAL_DEVICES[normalizePath(path)];
    if (dev) return dev.stat();
    if (EphemeralFdStore.handles(path)) {
      return this.ephemeralFds.has(path) ? this.ephemeralFds.stat(path) : null;
    }
    if (!this.isAllowed(path)) return null;
    const scan = this.scanPathForSymlinks(path, false);
    if (scan !== false) return null;
    return this.vfs.lstatSync(path);
  }

  /**
   * Synchronous readDir — VfsAdapter fast path.
   *
   * - Disallowed paths: return `null` (so the adapter falls back to the
   *   async `readDir`, which itself returns `[]` for disallowed paths).
   * - Strictly-allowed paths: delegate to the VFS fast path, but only
   *   after verifying no symlink in the path could make it escape the
   *   ACL (VAL-FS-019 parity). If a symlink is detected anywhere in the
   *   path (ancestor or leaf), return `null` to force async fallback —
   *   the async `readDir` uses `resolveAndCheckRead` to reject escape
   *   targets.
   * - Parent-only-allowed paths (e.g. `/`, `/scoops`): filter the
   *   returned entries to those whose child path is allowed, mirroring
   *   the async `readDir`.
   */
  readDirSync(path: string): DirEntry[] | null {
    if (!this.isAllowed(path)) return null;
    // `readDir` follows symlinks in the directory path (CacheFS.readdir
    // uses _lookup with follow=true), so a symlink anywhere in the
    // path — ancestor or leaf — can escape the ACL. Scan full path.
    const scan = this.scanPathForSymlinks(path, true);
    if (scan !== false) return null;
    const fast = this.vfs.readDirSync(path);
    if (fast === null) return null;
    if (this.isAllowedStrict(path)) return fast;
    // Parent dir — apply the same ACL filter as the async readDir.
    const base = normalizePath(path);
    return fast.filter((e) => {
      const child = base === '/' ? `/${e.name}` : `${base}/${e.name}`;
      return this.isAllowed(child);
    });
  }

  /**
   * Canonical path resolution — VfsAdapter contract.
   *
   * Resolves symlinks through the underlying VFS. If the resolved path
   * escapes every allowed prefix, throws `ENOENT` (consistent with
   * VAL-FS-019 symlink-escape semantics).
   */
  async realpath(path: string): Promise<string> {
    // A descriptor is its own canonical path — it is not a tree entry, so there
    // is no symlink to resolve and no ACL scope to escape.
    if (EphemeralFdStore.handles(path)) {
      const normalized = normalizePath(path);
      if (!this.ephemeralFds.has(normalized)) {
        throw new FsError('ENOENT', 'no such file or directory', normalized);
      }
      return normalized;
    }
    let resolved: string;
    try {
      resolved = await this.vfs.realpath(path);
    } catch (err) {
      if (err instanceof FsError) throw err;
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    if (!this.isAllowedStrict(resolved)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return resolved;
  }

  async exists(path: string): Promise<boolean> {
    if (VIRTUAL_DEVICES[normalizePath(path)]) return true;
    if (EphemeralFdStore.handles(path)) return this.ephemeralFds.has(path);
    if (!this.isAllowed(path)) return false;
    if (this.isAllowedStrict(path)) {
      try {
        await this.resolveAndCheckRead(path);
      } catch {
        return false;
      }
    }
    return this.vfs.exists(path);
  }

  async readTextFile(path: string): Promise<string> {
    const devText = VIRTUAL_DEVICES[normalizePath(path)];
    if (devText) return devText.readText();
    if (EphemeralFdStore.handles(path)) return this.ephemeralFds.readText(path);
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    const resolved = await this.resolveAndCheckRead(path);
    return this.vfs.readTextFile(resolved);
  }

  async *walk(path: string): AsyncGenerator<string> {
    if (!this.isAllowed(path)) return;
    let resolvedBase = path;
    if (this.isAllowedStrict(path)) {
      try {
        resolvedBase = await this.resolveAndCheckRead(path);
      } catch {
        return;
      }
    }
    for await (const filePath of this.vfs.walk(resolvedBase)) {
      if (this.isAllowed(filePath)) {
        yield filePath;
      }
    }
  }

  // ── Write operations: throw EACCES for outside paths ─────────────────

  async writeFile(
    path: string,
    content: FileContent,
    options?: { recursive?: boolean }
  ): Promise<void> {
    const devWrite = VIRTUAL_DEVICES[normalizePath(path)];
    if (devWrite) {
      devWrite.write(content);
      return;
    }
    // Ephemeral descriptor: keep the payload (it is read back by the consuming
    // command) but keep it out of the shared tree.
    if (EphemeralFdStore.handles(path)) {
      this.ephemeralFds.write(path, content);
      return;
    }
    this.checkWrite(path);
    await this.checkParentRealpathEscape(path);
    // Also check if destination itself is a symlink pointing outside sandbox
    try {
      const destStat = await this.vfs.lstat(path);
      if (destStat.type === 'symlink') {
        await this.resolveAndCheckWrite(path);
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
      // File doesn't exist yet — that's fine, no symlink to follow
    }
    return this.vfs.writeFile(path, content, options);
  }

  /**
   * Refuse a TREE-SHAPE op on a descriptor path.
   *
   * The descriptor exemption covers exactly the two things process substitution
   * needs — a content write and the read back — plus the release (`rm`). Every
   * other op names a tree node, and a descriptor is not one: it has no parent
   * directory, no siblings and no inode to relink. This is not merely
   * meaningless, it is load-bearing. Under `sudo-delegated` enforcement
   * `checkWrite` is a no-op, so without this refusal a `mkdir /dev/fd/63` or
   * `mv x /dev/fd/63` would fall through to the SHARED VirtualFS and
   * materialize the very cone-visible, cross-scoop `/dev/fd` entry the private
   * store exists to prevent — and the sudoers layer cannot stop it, because it
   * deliberately answers `nopasswd-allow` for these paths rather than raising
   * a prompt no "Always" grant could pre-empt.
   *
   * `EACCES` (not `ENOENT`) because the op is refused, not the path missing:
   * the shell owns these paths, the sandbox does not.
   */
  private refuseDescriptorTreeOp(path: string): void {
    if (EphemeralFdStore.handles(path)) {
      throw new FsError('EACCES', 'permission denied', normalizePath(path));
    }
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.refuseDescriptorTreeOp(path);
    this.checkWrite(path);
    await this.checkParentRealpathEscape(path);
    return this.vfs.mkdir(path, options);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    // Releasing a descriptor is how the shell ends a process substitution, so
    // it has to reach the store rather than the tree. A descriptor that was
    // never written raises ENOENT, exactly as the VFS does for a missing file:
    // the interpreter's own release swallows that, and `rm -f` is resolved by
    // the shell's `rm` command before it reaches this layer (the VFS `RmOptions`
    // carries no `force` flag).
    if (EphemeralFdStore.handles(path)) {
      if (!this.ephemeralFds.remove(path)) {
        throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
      }
      return;
    }
    this.checkWrite(path);
    // For symlinks, check only the link path (not target) — we're removing the link node
    try {
      const st = await this.vfs.lstat(path);
      if (st.type === 'symlink') {
        // Link itself is in a writable area (already confirmed by checkWrite above)
        // Don't resolve target — we're deleting the link, not the target
      } else {
        await this.resolveAndCheckWrite(path);
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
      // Path doesn't exist — let VFS handle the error
    }
    return this.vfs.rm(path, options);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.refuseDescriptorTreeOp(oldPath);
    this.refuseDescriptorTreeOp(newPath);
    this.checkWrite(oldPath);
    this.checkWrite(newPath);
    // Resolve symlinks in both paths to prevent escape
    await this.resolveAndCheckWrite(oldPath);
    await this.checkParentRealpathEscape(newPath);
    return this.vfs.rename(oldPath, newPath);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    // A descriptor is a legitimate end of a copy — `cp <(echo hi) out` reaches
    // here through `VfsAdapter.cp`, and `cp in >(consumer)` has to land in the
    // store so the writer body sees the bytes. Each end is resolved
    // independently: the descriptor end through the store (no ACL, it is not a
    // tree path), the tree end through the ordinary checks below.
    if (EphemeralFdStore.handles(src)) {
      const content = this.ephemeralFds.read(src, { encoding: 'binary' });
      await this.writeFile(dest, content);
      return;
    }
    if (EphemeralFdStore.handles(dest)) {
      if (!this.isAllowed(src)) {
        throw new FsError('ENOENT', 'no such file or directory', normalizePath(src));
      }
      const resolvedSource = await this.resolveAndCheckRead(src);
      this.ephemeralFds.write(
        dest,
        await this.vfs.readFile(resolvedSource, { encoding: 'binary' })
      );
      return;
    }
    // Read from anywhere allowed, write only to allowed
    if (!this.isAllowed(src)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(src));
    }
    this.checkWrite(dest);
    // Resolve symlinks in source path
    const resolvedSrc = await this.resolveAndCheckRead(src);
    await this.checkParentRealpathEscape(dest);
    // Also check if destination itself is a symlink pointing outside sandbox
    try {
      const destStat = await this.vfs.lstat(dest);
      if (destStat.type === 'symlink') {
        await this.resolveAndCheckWrite(dest);
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
      // File doesn't exist yet — that's fine, no symlink to follow
    }
    return this.vfs.copyFile(resolvedSrc, dest);
  }

  // ── Symlink operations ───────────────────────────────────────────────

  async symlink(target: string, linkPath: string): Promise<void> {
    this.refuseDescriptorTreeOp(linkPath);
    this.checkWrite(linkPath);
    await this.checkParentRealpathEscape(linkPath);
    return this.vfs.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    const target = await this.vfs.readlink(path);
    // Resolve the target relative to the link's parent to get the absolute path
    let absoluteTarget: string;
    if (target.startsWith('/')) {
      absoluteTarget = normalizePath(target);
    } else {
      const linkDir = this.vfs.dirname(path);
      absoluteTarget = normalizePath(linkDir + '/' + target);
    }
    if (!this.isAllowedStrict(absoluteTarget)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return target;
  }

  async lstat(path: string): Promise<Stats> {
    const dev = VIRTUAL_DEVICES[normalizePath(path)];
    if (dev) return dev.stat();
    // A descriptor can never be a symlink, so `lstat` answers exactly as `stat`.
    if (EphemeralFdStore.handles(path)) return this.ephemeralFds.stat(path);
    if (!this.isAllowed(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    // Resolve the PARENT directory only — `lstat` must NOT follow the leaf
    // symlink (regression: lstat on a valid in-sandbox symlink must still
    // return Stats with type === 'symlink'). But LightningFS follows
    // ancestor symlinks during lstat, so an escape symlink anywhere in the
    // path can leak sibling-scoop metadata through the async fallback
    // `VfsAdapter.lstat()` hits when the sync fast path returns null.
    //
    // Mirrors the parent-resolution pattern used in writeFile / mkdir /
    // symlink. See VAL-FS-019 parity.
    const normalized = normalizePath(path);
    const dir = this.vfs.dirname(normalized);
    const base = this.vfs.basename(normalized);
    let resolvedDir: string;
    if (dir === normalized) {
      // Root — no parent to resolve.
      resolvedDir = dir;
    } else {
      try {
        resolvedDir = await this.vfs.realpath(dir);
      } catch {
        throw new FsError('ENOENT', 'no such file or directory', normalized);
      }
    }
    const resolved = resolvedDir === '/' ? `/${base}` : `${resolvedDir}/${base}`;
    if (!this.isAllowed(resolved)) {
      throw new FsError('ENOENT', 'no such file or directory', normalized);
    }
    return this.vfs.lstat(resolved);
  }

  // ── Watcher operations ──────────────────────────────────────────────

  watch(basePath: string, filter: FsWatchFilter, callback: FsWatchCallback): () => void {
    if (!this.isAllowed(basePath)) {
      throw new FsError('EACCES', 'permission denied', normalizePath(basePath));
    }
    const watcher = this.vfs.getWatcher();
    if (!watcher) {
      throw new FsError('EINVAL', 'no watcher configured');
    }
    return watcher.watch(normalizePath(basePath), filter, callback);
  }

  // ── Path utilities (no access control) ───────────────────────────────

  dirname(path: string): string {
    return this.vfs.dirname(path);
  }

  basename(path: string): string {
    return this.vfs.basename(path);
  }

  // ---------------------------------------------------------------------------
  // Mount operations — delegate to VFS with writable-path enforcement.
  // ---------------------------------------------------------------------------

  async mount(
    absolutePath: string,
    backend: MountBackend,
    opts?: { env?: MountIndexEnv }
  ): Promise<void> {
    this.refuseDescriptorTreeOp(absolutePath);
    this.checkWrite(absolutePath);
    await this.checkParentRealpathEscape(absolutePath);
    return this.vfs.mount(absolutePath, backend, opts);
  }

  async unmount(absolutePath: string): Promise<void> {
    this.refuseDescriptorTreeOp(absolutePath);
    this.checkWrite(absolutePath);
    await this.checkParentRealpathEscape(absolutePath);
    return this.vfs.unmount(absolutePath);
  }

  listMounts(): string[] {
    const all = this.vfs.listMounts();
    if (this.includeMounts) return all;
    // Private isolation: only mounts the caller explicitly granted (inside
    // allowed / read-only prefixes) remain visible. `isAllowedStrict` does
    // not consult the mount list when `includeMounts` is false, so this
    // cannot re-admit a mount through the same silent path we just closed.
    return all.filter((p) => this.isAllowedStrict(p));
  }

  getMountIndex(): ReturnType<VirtualFS['getMountIndex']> {
    return this.vfs.getMountIndex();
  }

  async refreshMount(
    absolutePath: string,
    opts?: { bodies?: boolean; env?: MountIndexEnv }
  ): Promise<RefreshReport> {
    this.refuseDescriptorTreeOp(absolutePath);
    this.checkWrite(absolutePath);
    return this.vfs.refreshMount(absolutePath, opts);
  }

  /**
   * Dispose the underlying VirtualFS, closing IndexedDB connections.
   */
  async dispose(): Promise<void> {
    await this.vfs.dispose();
  }
}
