/**
 * VirtualFS adapter for just-bash's IFileSystem interface.
 *
 * Wraps our VirtualFS (OPFS/IndexedDB backed) so that just-bash
 * can use it as its filesystem backend.
 */

import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';
import * as justBash from 'just-bash';
import type { DirEntry, Stats, VirtualFS } from '../fs/index.js';
import { FsError, joinPath, normalizePath, statsFromDirEntry } from '../fs/index.js';
import { consumeCachedBinary } from './binary-cache.js';

// just-bash v3 ships `DefenseInDepthBox` from `security/index.js` (re-exported
// at the package root for the Node bundle, but NOT from the browser bundle).
// Resolve via `Reflect.get` so Rolldown's namespace-import analysis cannot
// statically prove the property is undefined (which would emit
// `[IMPORT_IS_UNDEFINED]` and break the IIFE bundle warning budget) — the
// access still resolves correctly at runtime against the Node bundle and
// falls through to `undefined` in the browser bundle. The browser bundle
// also skips sandbox enforcement when `defenseInDepth` isn't explicitly
// enabled on `new Bash({...})`, so a no-op fallback is safe there.
type RunTrustedAsync = <T>(fn: () => Promise<T> | T) => Promise<T>;
const DefenseInDepthBox = Reflect.get(justBash, 'DefenseInDepthBox') as
  | { runTrustedAsync?: RunTrustedAsync }
  | undefined;

// These types are defined in just-bash's fs/interface.d.ts but not re-exported
// from the package root. Define locally to match IFileSystem's method signatures.
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
  encoding?: BufferEncoding;
}
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/**
 * Map a VFS inode onto just-bash's optional `FsStat.identity` — the token it
 * uses to decide whether two stats name the same file rather than the same path.
 *
 * Commands that mutate through a staging file re-identify their inputs and
 * outputs before committing, and `identitiesMatch()` fails closed for an
 * EXISTING entry whose identity is `undefined`:
 *
 *     e.existence === "existing"
 *       ? e.stableIdentity !== undefined && e.stableIdentity === t.stableIdentity
 *       : ...
 *
 * With no identity that comparison is `undefined !== undefined` → `false`, so
 * `split FILE PREFIX` threw `input identity changed during split` against a
 * file nothing had touched, rolled its staged chunks back, and reported the
 * generic `split: failed to write output`. It could never succeed in SLICC.
 * (`split - PREFIX` reading stdin was unaffected: no input file to re-identify.)
 *
 * `identity` rather than `dev`/`ino`: just-bash only accepts the inode pair
 * when BOTH halves are present, and one VfsAdapter can span several backends
 * whose inode spaces are unrelated — there is no honest single `dev`. Only
 * positive inodes qualify: ZenFS pins `/` to 0, and a sidecar poisoned the way
 * #2146 describes can hand out 0 for many entries before the pre-boot repair
 * re-numbers them. A collided identity is worse than none, so 0 stays absent.
 */
function toIdentity(ino: number | undefined): string | undefined {
  return typeof ino === 'number' && Number.isInteger(ino) && ino > 0 ? `vfs-ino:${ino}` : undefined;
}

/**
 * How long a directory listing may answer a `stat` of an entry it just
 * reported (issue #2716).
 *
 * `ls -l` is one `readdir` followed by a `stat` per name, and `du` one
 * `readdir` followed by an `lstat` per name — just-bash's `DirentEntry`
 * carries no size, so there is no way to hand the sizes over except through
 * the filesystem surface it calls next. Over a hostfs mount each of those
 * stats is a bridge round trip for numbers the `list` response already
 * carried (a 91-entry directory cost 91 of them).
 *
 * A second is far longer than the microseconds between the listing and the
 * stats that follow it, and far shorter than a person's next command — and
 * any write through this adapter drops the whole table anyway. It bounds the
 * one case the adapter cannot see: a change made outside it (the host
 * filesystem, another realm) between the listing and the stat.
 */
const LISTING_STAT_TTL_MS = 1000;

/**
 * Hard cap on primed entries — a memory budget, not a soft target.
 *
 * The TTL alone bounds how long an entry may be REUSED, not how long it is
 * RETAINED: expiry is only noticed when that exact path is looked up again,
 * so a `du -sh` or `ls -R` over a big mount would pile every directory it
 * ever walked into a map that lives as long as the shell does. Priming
 * therefore sweeps what has expired and, when the cap would still be
 * exceeded, drops the table instead of growing it.
 *
 * 20,000 entries is far more than the listing-plus-stats burst this exists
 * to serve, and small enough that the worst case is a few MB.
 */
const MAX_LISTING_STATS = 20_000;

/** Injection points for the listing cache — tests pin small ones. */
export interface VfsAdapterOptions {
  /** Hard cap on primed entries (default 20,000). */
  listingStatsMax?: number;
  /** How long a listing may answer a stat, in ms (default 1000). */
  listingStatsTtlMs?: number;
}

export class VfsAdapter implements IFileSystem {
  private registeredCommandsFn: (() => string[]) | null = null;
  /**
   * Stat answers primed by the last `readdir`/`readdirWithFileTypes`, keyed
   * by normalized absolute path. Only entries whose listing carried the full
   * set land here — see {@link statsFromDirEntry}.
   *
   * Insertion order is age order: priming DELETES a key before re-setting it
   * (a plain `set` on an existing key keeps its old position), which is what
   * lets {@link sweepExpiredListingStats} stop at the first live entry
   * instead of walking the whole map.
   */
  private readonly listingStats = new Map<string, { stats: Stats; at: number }>();
  private readonly listingStatsMax: number;
  private readonly listingStatsTtlMs: number;

  constructor(
    private vfs: VirtualFS,
    opts?: VfsAdapterOptions
  ) {
    this.listingStatsMax = Math.max(1, opts?.listingStatsMax ?? MAX_LISTING_STATS);
    this.listingStatsTtlMs = opts?.listingStatsTtlMs ?? LISTING_STAT_TTL_MS;
  }

  /** Entries primed right now. A diagnostic — an unbounded cache and a
   * bounded one behave identically until the worker runs out of memory, so
   * this is what makes the cap assertable. */
  get listingStatsSize(): number {
    return this.listingStats.size;
  }

  /**
   * Remember what a listing reported about each entry.
   *
   * Entries the listing did not fully describe (a directory over hostfs, a
   * symlink, a raced entry the bridge could not stat) are DROPPED rather
   * than half-cached, so a later `stat` of one goes to the filesystem.
   */
  private primeListingStats(dir: string, entries: DirEntry[]): void {
    const at = Date.now();
    // One listing bigger than the whole budget: drop everything and prime
    // nothing. Making room first and then inserting would still leave
    // `entries.length` entries behind — no cap at all for exactly the
    // directory that needs one.
    if (entries.length > this.listingStatsMax) {
      this.listingStats.clear();
      return;
    }
    this.sweepExpiredListingStats(at);
    if (this.listingStats.size + entries.length > this.listingStatsMax) {
      this.listingStats.clear();
    }
    const prefix = dir === '/' ? '/' : `${dir}/`;
    for (const entry of entries) {
      const stats = statsFromDirEntry(entry);
      const path = `${prefix}${entry.name}`;
      // Delete first either way: it drops a half-described entry's stale
      // answer AND keeps insertion order equal to age order for the sweep.
      this.listingStats.delete(path);
      if (stats) this.listingStats.set(path, { stats, at });
    }
  }

  /**
   * Evict everything already past the TTL. Cheap because insertion order is
   * age order — the first live entry ends the scan, so the walk costs one
   * step per entry actually removed.
   */
  private sweepExpiredListingStats(now: number): void {
    for (const [path, hit] of this.listingStats) {
      if (now - hit.at <= this.listingStatsTtlMs) break;
      this.listingStats.delete(path);
    }
  }

  /** The primed stats for `path`, if a recent listing reported them. */
  private primedStats(path: string): Stats | undefined {
    const hit = this.listingStats.get(path);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.listingStatsTtlMs) {
      this.listingStats.delete(path);
      return undefined;
    }
    return hit.stats;
  }

  /**
   * Forget every primed listing. Called by every mutation this adapter
   * performs — blunt on purpose: a shell command that writes is not the one
   * paying the N+1, so there is nothing to lose by starting over.
   */
  private dropListingStats(): void {
    this.listingStats.clear();
  }

  /**
   * Set a function that returns the list of registered command names.
   * Used to populate the virtual /usr/bin directory.
   */
  setRegisteredCommandsFn(fn: () => string[]): void {
    this.registeredCommandsFn = fn;
  }

  private getVirtualBinCommands(): string[] {
    return this.registeredCommandsFn?.() ?? [];
  }

  /**
   * Stats for the synthetic `/usr` tree, or `null` when the path is not part
   * of it. `/usr`, `/usr/bin`, and `/usr/bin/<command>` are synthesized from
   * the command registry — they have no VFS entry at all, so every
   * metadata surface has to answer for them itself.
   *
   * This exists because `exists()` and `stat()` each carried their own copy
   * of the branch and `lstat()` carried none, so it fell through to the VFS
   * and raised ENOENT for the whole virtual bin tree. Anything that lstats
   * — `du`, `find -type`, `tar` — could not see `/usr`, and because `du`
   * reports any throw during its walk as `cannot access '<argument>'`, even
   * `du -sh /` failed: the walk reached `/usr` and gave up on the whole
   * root. One shared helper so the three surfaces cannot drift again.
   *
   * `stat` and `lstat` share one answer: none of these paths can be a
   * symlink, so following links changes nothing.
   */
  private virtualUsrStat(normalized: string): FsStat | null {
    if (normalized === '/usr' || normalized === '/usr/bin') {
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: 0o755,
        size: 0,
        mtime: new Date(0),
      };
    }
    if (normalized.startsWith('/usr/bin/')) {
      const cmdName = normalized.slice('/usr/bin/'.length);
      if (
        cmdName.length > 0 &&
        !cmdName.includes('/') &&
        this.getVirtualBinCommands().includes(cmdName)
      ) {
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: 0o755,
          size: 0,
          mtime: new Date(0),
        };
      }
    }
    return null;
  }

  /**
   * Writability predicate — delegates to the wrapped `VirtualFS` /
   * `RestrictedFS`. Exposed so shell commands can check whether a path
   * is writable under the current sandbox (if any) BEFORE delegating an
   * op to a lower layer that can't see the caller's ACL. `VirtualFS`
   * always returns `true`; `RestrictedFS` checks its writable prefixes.
   *
   * Not part of the `IFileSystem` contract; callers that need this must
   * feature-detect (`'canWrite' in ctx.fs`) or cast. See the `agent`
   * supplemental command for a concrete use.
   */
  canWrite(path: string): boolean {
    const wrapped = this.vfs as unknown as { canWrite?: (p: string) => boolean };
    return typeof wrapped.canWrite === 'function' ? wrapped.canWrite(path) : true;
  }

  /**
   * Expose the underlying VFS's user-visible mount points
   * (`{ path, kind }[]`) so shell commands can route mount-overlapping
   * paths through the appropriate backend instead of the raw OPFS
   * fast path. Used today by the `python` command to materialize
   * mount subtrees into the Pyodide realm via the `vfs` RPC channel.
   * Returns an empty array when the wrapped FS doesn't expose mount
   * metadata (e.g. test stubs).
   */
  listMountPoints(): { path: string; kind: 'local' | 'hostfs' | 's3' | 'da' | 'aem' | 'proc' }[] {
    const wrapped = this.vfs as unknown as {
      listMountPoints?: () => {
        path: string;
        kind: 'local' | 'hostfs' | 's3' | 'da' | 'aem' | 'proc';
      }[];
    };
    return typeof wrapped.listMountPoints === 'function' ? wrapped.listMountPoints() : [];
  }

  /**
   * Run an async FS operation inside `DefenseInDepthBox.runTrustedAsync` so
   * the just-bash v3 sandbox permits LightningFS / fake-indexeddb's internal
   * `setTimeout`, `Promise.then`, and friends. The trusted scope is bounded
   * to the duration of the wrapped operation — same pattern just-bash uses
   * internally for `fetch` and command-module loaders. When `DefenseInDepthBox`
   * is unavailable (e.g. the browser bundle strips it), fall through to
   * direct invocation — the sandbox guard is not active in that build either.
   */
  private trusted<T>(fn: () => Promise<T>): Promise<T> {
    const runTrustedAsync = DefenseInDepthBox?.runTrustedAsync;
    return runTrustedAsync ? runTrustedAsync(fn) : Promise.resolve().then(fn);
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      const raw = await this.vfs.readFile(normalized, { encoding: 'binary' });
      const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw as string);
      // Try UTF-8 first — valid text files decode cleanly.
      // Binary files (PNG, JPEG, etc.) contain invalid UTF-8 sequences;
      // fall back to latin1 which maps each byte to a char, preserving all values.
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        // Don't use TextDecoder('iso-8859-1') — browsers treat it as windows-1252
        // per WHATWG spec, remapping bytes 0x80-0x9F to different codepoints.
        // String.fromCharCode maps each byte directly to its Unicode codepoint.
        const chars = new Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) chars[i] = String.fromCharCode(bytes[i]);
        return chars.join('');
      }
    });
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      const content = await this.vfs.readFile(normalized, { encoding: 'binary' });
      if (content instanceof Uint8Array) return content;
      return new TextEncoder().encode(content as string);
    });
  }

  /**
   * Lazy native `File` for a VFS path, or `null` when the backend has no
   * handle for it (see `VirtualFS.getNativeFile`). Not part of just-bash's
   * `IFileSystem`; media commands duck-type for it and fall back to
   * {@link readFileBuffer}.
   */
  async getNativeFile(path: string): Promise<File | null> {
    return this.trusted(() => this.vfs.getNativeFile(normalizePath(path)));
  }

  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      if (typeof content === 'string') {
        // Check binary cache first — createProxiedFetch stores original bytes
        // here for binary responses so we can bypass string encoding entirely.
        const cachedBytes = consumeCachedBinary(content);
        if (cachedBytes) {
          await this.vfs.writeFile(normalized, cachedBytes);
          return;
        }
        // Detect whether the string contains characters above U+00FF.
        // If so, it's definitely Unicode text (from resp.text()) — use UTF-8 encoding.
        // If all chars are ≤ 0xFF, it may be latin1-encoded binary data (from curl
        // fetching images/archives) — use charCodeAt to preserve raw bytes.
        // ASCII text (all chars ≤ 0x7F) is identical in both encodings.
        let hasHighCodepoints = false;
        for (let i = 0; i < content.length; i++) {
          if (content.charCodeAt(i) > 0xff) {
            hasHighCodepoints = true;
            break;
          }
        }
        if (hasHighCodepoints) {
          // Unicode text — encode as proper UTF-8
          await this.vfs.writeFile(normalized, new TextEncoder().encode(content));
        } else {
          // ASCII or latin1-encoded binary — charCodeAt preserves byte values
          const bytes = new Uint8Array(content.length);
          for (let i = 0; i < content.length; i++) {
            bytes[i] = content.charCodeAt(i);
          }
          await this.vfs.writeFile(normalized, bytes);
        }
      } else {
        await this.vfs.writeFile(normalized, content);
      }
    });
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      // Enforce POSIX EISDIR for the append target — ZenFS' InMemory backend
      // (used in tests) silently overwrites a directory entry with file bytes
      // on writeFile/appendFile rather than rejecting, so the contract is
      // enforced here at the shell-facing surface.
      try {
        const s = await this.vfs.stat(normalized);
        if (s.type === 'directory') {
          throw new FsError('EISDIR', 'is a directory', normalized);
        }
      } catch (err) {
        if (err instanceof FsError && err.code === 'EISDIR') throw err;
        // Any other stat failure (most importantly ENOENT) means the target
        // is writable as a new file — fall through to the read+concat path.
      }
      // Read existing content as binary to avoid encoding corruption
      let existingBytes = new Uint8Array(0);
      try {
        const existing = await this.vfs.readFile(normalized, { encoding: 'binary' });
        existingBytes =
          existing instanceof Uint8Array
            ? new Uint8Array(existing)
            : new TextEncoder().encode(existing as string);
      } catch (err) {
        // Only treat ENOENT as "file doesn't exist yet" — re-throw other errors
        if (err instanceof FsError && err.code === 'ENOENT') {
          // File doesn't exist yet, start empty
        } else {
          throw err;
        }
      }
      // Convert new content to bytes
      let newBytes: Uint8Array;
      if (typeof content === 'string') {
        newBytes = new Uint8Array(content.length);
        for (let i = 0; i < content.length; i++) {
          newBytes[i] = content.charCodeAt(i) & 0xff;
        }
      } else {
        newBytes = content instanceof Uint8Array ? content : new Uint8Array(content);
      }
      // Concatenate and write
      const combined = new Uint8Array(existingBytes.length + newBytes.length);
      combined.set(existingBytes);
      combined.set(newBytes, existingBytes.length);
      await this.vfs.writeFile(normalized, combined);
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      if (this.virtualUsrStat(normalized)) return true;
      return this.vfs.exists(normalized);
    });
  }

  async stat(path: string): Promise<FsStat> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      // Virtual /usr, /usr/bin, and /usr/bin/<command> entries
      const virtual = this.virtualUsrStat(normalized);
      if (virtual) return virtual;
      // Fast path: synchronous CacheFS stat for non-mounted paths
      const fast = this.vfs.statSync(normalized);
      if (fast) {
        return {
          isFile: fast.type === 'file',
          isDirectory: fast.type === 'directory',
          isSymbolicLink: !!fast.isSymlink,
          mode: fast.type === 'directory' ? 0o755 : 0o644,
          size: fast.size,
          mtime: new Date(fast.mtime),
          identity: toIdentity(fast.ino),
        };
      }
      // What the directory listing just reported, when it reported it
      // (#2716) — never a symlink, so `stat` and `lstat` share the answer.
      const s = this.primedStats(normalized) ?? (await this.vfs.stat(normalized));
      return {
        isFile: s.type === 'file',
        isDirectory: s.type === 'directory',
        isSymbolicLink: !!s.isSymlink,
        mode: s.type === 'directory' ? 0o755 : 0o644,
        size: s.size,
        mtime: new Date(s.mtime),
        identity: toIdentity(s.ino),
      };
    });
  }

  async lstat(path: string): Promise<FsStat> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      // Virtual /usr entries — none of them can be a symlink, so `lstat`
      // answers exactly as `stat` does. Omitting this is what made `du`,
      // `find -type`, and `tar` blind to the virtual bin tree.
      const virtual = this.virtualUsrStat(normalized);
      if (virtual) return virtual;
      // Fast path: synchronous CacheFS lstat for non-mounted paths
      const fast = this.vfs.lstatSync(normalized);
      if (fast) {
        return {
          isFile: fast.type === 'file',
          isDirectory: fast.type === 'directory',
          isSymbolicLink: fast.type === 'symlink',
          mode: fast.type === 'directory' ? 0o755 : fast.type === 'symlink' ? 0o777 : 0o644,
          size: fast.size,
          mtime: new Date(fast.mtime),
          identity: toIdentity(fast.ino),
        };
      }
      const s = this.primedStats(normalized) ?? (await this.vfs.lstat(normalized));
      return {
        isFile: s.type === 'file',
        isDirectory: s.type === 'directory',
        isSymbolicLink: s.type === 'symlink',
        mode: s.type === 'directory' ? 0o755 : s.type === 'symlink' ? 0o777 : 0o644,
        size: s.size,
        mtime: new Date(s.mtime),
        identity: toIdentity(s.ino),
      };
    });
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      await this.vfs.mkdir(normalizePath(path), options);
    });
  }

  async readdir(path: string): Promise<string[]> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      if (normalized === '/usr') return ['bin'];
      if (normalized === '/usr/bin') return this.getVirtualBinCommands().slice().sort();
      // Fast path: synchronous CacheFS read for non-mounted paths
      const fast = this.vfs.readDirSync(normalized);
      if (fast !== null) return fast.map((e) => e.name);
      // `ls -l` stats every name this just returned (#2716); ask the backend
      // for listing stats so an FSA mount pays one getFile per entry instead
      // of a follow-up stat (#2765).
      const entries = await this.vfs.readDir(normalized, { includeStats: true });
      this.primeListingStats(normalized, entries);
      return entries.map((e) => e.name);
    });
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return this.trusted(async () => {
      const normalized = normalizePath(path);
      if (normalized === '/usr') {
        return [{ name: 'bin', isFile: false, isDirectory: true, isSymbolicLink: false }];
      }
      if (normalized === '/usr/bin') {
        return this.getVirtualBinCommands()
          .slice()
          .sort()
          .map((name) => ({
            name,
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
          }));
      }

      // Fast path: synchronous CacheFS read for non-mounted paths.
      // readDirSync returns null when the path is under a mount or
      // the CacheFS internal isn't available.
      const fastEntries = this.vfs.readDirSync(normalized);
      if (fastEntries !== null) {
        return this.mapFastEntriesToDirents(fastEntries);
      }

      // Slow path: async VirtualFS readDir for mounted paths. Always ask
      // for stats — every consumer of Dirents that cares about size/mtime
      // (du, find -ls, …) stats each entry right after listing (#2765).
      const entries = await this.vfs.readDir(normalized, { includeStats: true });
      this.primeListingStats(normalized, entries);
      return this.mapAsyncEntriesToDirents(entries);
    });
  }

  /** Map synchronous CacheFS entries to DirentEntry[]. */
  private mapFastEntriesToDirents(fastEntries: { name: string; type: string }[]): DirentEntry[] {
    return fastEntries.map((e) => this.entryToDirent(e));
  }

  /** Map async VirtualFS entries to DirentEntry[]. */
  private mapAsyncEntriesToDirents(entries: { name: string; type: string }[]): DirentEntry[] {
    return entries.map((e) => this.entryToDirent(e));
  }

  /**
   * Convert a readdir entry to a `DirentEntry`. A `Dirent` reflects `lstat`
   * (the link itself), NOT `stat` (the resolved target) — so a symlink is
   * reported with `isSymbolicLink: true` and `isFile`/`isDirectory` BOTH false,
   * exactly like Node's `fs.Dirent`. This is load-bearing: the shell's
   * recursive walkers (`find`, `grep -r`, `ls -R`) decide whether to descend
   * from `isDirectory`. Resolving the target here (the previous behavior) made
   * a symlink-to-directory look like a plain directory, so the walkers followed
   * it — and a symlink CYCLE recursed forever, allocating millions of path
   * objects in the kernel worker until V8 OOM'd (~4GB). POSIX `find`/`grep -r`
   * do not follow symlinks by default; not resolving the target here restores
   * that contract and is also far cheaper (no per-entry stat).
   */
  private entryToDirent(e: { name: string; type: string }): DirentEntry {
    if (e.type === 'symlink') {
      return { name: e.name, isFile: false, isDirectory: false, isSymbolicLink: true };
    }
    return {
      name: e.name,
      isFile: e.type === 'file',
      isDirectory: e.type === 'directory',
      isSymbolicLink: false,
    };
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      await this.vfs.rm(normalizePath(path), options);
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      const normalizedSrc = normalizePath(src);
      const normalizedDest = normalizePath(dest);
      const stat = await this.vfs.stat(normalizedSrc);

      if (stat.type === 'directory') {
        if (!options?.recursive) {
          throw new FsError('EISDIR', 'is a directory', normalizedSrc);
        }
        await this.cpDir(normalizedSrc, normalizedDest);
      } else {
        await this.vfs.copyFile(normalizedSrc, normalizedDest);
      }
    });
  }

  /** Recursively copy a directory tree. */
  private async cpDir(src: string, dest: string): Promise<void> {
    await this.vfs.mkdir(dest, { recursive: true });
    const entries = await this.vfs.readDir(src);
    for (const entry of entries) {
      const srcChild = joinPath(src, entry.name);
      const destChild = joinPath(dest, entry.name);
      if (entry.type === 'directory') {
        await this.cpDir(srcChild, destChild);
      } else {
        await this.vfs.copyFile(srcChild, destChild);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      await this.vfs.rename(normalizePath(src), normalizePath(dest));
    });
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return normalizePath(path);
    return normalizePath(joinPath(base, path));
  }

  getAllPaths(): string[] {
    // Our VFS doesn't support synchronous listing; just-bash uses this
    // for glob matching but can fall back to readdir-based walking.
    return [];
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // Our VFS doesn't track permissions — no-op
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.dropListingStats();
    return this.trusted(async () => {
      await this.vfs.symlink(target, normalizePath(linkPath));
    });
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error('Hard links not supported in VirtualFS');
  }

  async readlink(path: string): Promise<string> {
    return this.trusted(async () => {
      return this.vfs.readlink(normalizePath(path));
    });
  }

  async realpath(path: string): Promise<string> {
    return this.trusted(async () => {
      return this.vfs.realpath(normalizePath(path));
    });
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    // Our VFS doesn't support setting times — no-op
  }

  invalidatePaths(paths: string[]): void {
    this.dropListingStats();
    const vfs = this.vfs as { invalidatePaths?: (paths: string[]) => void };
    if (vfs.invalidatePaths) {
      vfs.invalidatePaths(paths);
    }
  }
}
