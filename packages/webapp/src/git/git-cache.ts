/**
 * Cross-command isomorphic-git object/pack cache (issue #2710).
 *
 * isomorphic-git keeps its parsed `.idx` files (`PackfileCache`) and the read
 * `.pack` buffers on the `cache` object the CALLER passes in. SLICC used to
 * pass none (only `clone` did), so every `git` invocation re-read the whole
 * packfile off the VFS — over a `--mount`ed host repo that is a 92 MB HTTP
 * body — re-parsed all 30 `.idx` files, and re-ran isomorphic-git's deep
 * SHA-1 integrity check over the pack payload. On the slicc checkout a warm
 * `ls-files` spent 47 % of the worker's CPU (5.2 s) hashing that pack.
 *
 * This module owns ONE cache object per `GitCommands` instance and the
 * bookkeeping that makes it safe to keep across commands:
 *
 * - **Invalidation.** The pack directory listing and `packed-refs` mtime are
 *   re-sampled before a command — but only for a repository this cache is
 *   already holding packs for, so a command that never reads a packfile never
 *   goes near `objects/pack` (#2713). When either moved (a `fetch` landed a
 *   new pack, an outside writer repacked) the cached pack entries for that
 *   gitdir are dropped. isomorphic-git's index cache self-invalidates on
 *   `lstat`, so it is deliberately left alone.
 * - **A memory bound.** A pack buffer is the single largest thing a git
 *   command allocates, so at most {@link DEFAULT_MAX_RESIDENT_PACKS} of them
 *   stay resident; the least recently used ones are unloaded (their parsed
 *   `.idx` stays — that is the expensive part to rebuild) and re-read on
 *   demand.
 * - **The verification switch.** `skipDeepPackVerification` is read by the
 *   `patches/isomorphic-git+1.41.9.patch` hunk: it keeps the O(1) trailer
 *   check and skips the full-payload SHA-1, which is what canonical git does
 *   on a normal object read (it verifies packs on `fsck` / `index-pack`).
 *
 * The cache is per-instance, never module-global: two shells can hold
 * different VirtualFS instances where the same absolute path is a different
 * repository.
 */

import { createLogger } from '../base/logger.js';
import type { IsoGitFsPromises } from './vfs-fs-adapter.js';

const logger = createLogger('git-cache');

/**
 * The cache object handed to isomorphic-git. Its real contents are
 * symbol-keyed and owned by isomorphic-git (`PackfileCache`, `IndexCache`);
 * the one string-keyed field is SLICC's, read by our isomorphic-git patch.
 */
export interface GitCache {
  /**
   * Skip the deep (full payload) SHA-1 verification of a packfile on read.
   * The trailer check still runs. Honored by the SLICC isomorphic-git patch.
   */
  skipDeepPackVerification?: boolean;
}

/**
 * Max number of packfile BUFFERS kept in memory at once. Four covers the
 * "one big pack plus the recent incremental ones" shape of a real checkout
 * without pinning a 30-pack repo's worth of bytes in the worker.
 */
export const DEFAULT_MAX_RESIDENT_PACKS = 4;

/** The shape of a cached `GitPackIndex`, as far as this module needs it. */
interface CachedPackIndex {
  /** The packfile bytes (or the in-flight read), `null` once unloaded. */
  pack?: Promise<Uint8Array | null> | Uint8Array | null;
  /** Monotonic use stamp written by the SLICC isomorphic-git patch. */
  _lastUsedAt?: number;
}

/** isomorphic-git's `Symbol('PackfileCache')` map: absolute .idx path → index. */
type PackfileCacheMap = Map<string, Promise<CachedPackIndex | undefined>>;

/**
 * Reach isomorphic-git's packfile map on a cache object. The key is a
 * non-registered symbol, so it is matched by description — a miss (nothing
 * packed has been read yet) is normal and returns undefined.
 */
function packfileCacheMap(cache: GitCache): PackfileCacheMap | undefined {
  for (const sym of Object.getOwnPropertySymbols(cache)) {
    if (sym.description !== 'PackfileCache') continue;
    const value = (cache as unknown as Record<symbol, unknown>)[sym];
    if (value instanceof Map) return value as PackfileCacheMap;
  }
  return undefined;
}

/** `<dir>/.git`, matching how isomorphic-git derives a gitdir from `dir`. */
function gitdirOf(dir: string): string {
  return `${dir.replace(/\/+$/, '')}/.git`;
}

/**
 * Owns the single isomorphic-git cache object of a `GitCommands` instance.
 *
 * Call {@link beforeCommand} before dispatching a subcommand and
 * {@link afterCommand} when it settles; everything else (invalidation,
 * eviction) follows from those two.
 */
export class GitCacheManager {
  /** The object passed as `cache:` to every isomorphic-git call. */
  readonly cache: GitCache = {};

  /** Last observed `<pack dir listing>|<packed-refs mtime>` per gitdir. */
  private readonly signatures = new Map<string, string>();

  /** Commands currently in flight; pack buffers are only evicted at zero. */
  private inFlight = 0;

  private readonly maxResidentPacks: number;

  constructor(
    private readonly fs: IsoGitFsPromises,
    options: { maxResidentPacks?: number } = {}
  ) {
    this.maxResidentPacks = Math.max(1, options.maxResidentPacks ?? DEFAULT_MAX_RESIDENT_PACKS);
  }

  /**
   * Turn the deep pack SHA-1 verification on or off for subsequent reads.
   * Verified packs stay verified — the flag only gates work not yet done.
   */
  setDeepVerification(enabled: boolean): void {
    this.cache.skipDeepPackVerification = !enabled;
  }

  /**
   * Re-sample the repository's pack state and drop the cached packs when it
   * moved. Costs one directory listing plus one stat — and only for a
   * repository this cache is actually holding packs for, so a command that
   * never touches a packfile (`git rev-parse` on a loose-object repo, #2713)
   * still never goes near `objects/pack`.
   */
  async beforeCommand(dir: string): Promise<void> {
    this.inFlight++;
    const gitdir = gitdirOf(dir);
    const previous = this.signatures.get(gitdir);
    if (previous === undefined) return;
    const signature = await this.packSignature(gitdir);
    if (previous !== signature) this.invalidate(dir);
    this.signatures.set(gitdir, signature);
  }

  /**
   * Settle a command: commands that write packs drop the repo's cached packs
   * outright, a repository whose packs are now cached gets the fingerprint
   * that `beforeCommand` will check next time, and the resident-buffer bound
   * is re-applied once nothing is in flight.
   */
  async afterCommand(dir: string, options: { wrotePacks?: boolean } = {}): Promise<void> {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const gitdir = gitdirOf(dir);
    if (options.wrotePacks) {
      this.invalidate(dir);
      this.signatures.delete(gitdir);
    }
    // Fingerprint the repo the first time it has cached packs to protect, so
    // the sample describes the state those packs were read from.
    if (!this.signatures.has(gitdir) && this.hasCachedPacks(gitdir)) {
      this.signatures.set(gitdir, await this.packSignature(gitdir));
    }
    if (this.inFlight === 0) await this.trimResidentPacks();
  }

  /** Whether any pack index of this gitdir is currently cached. */
  private hasCachedPacks(gitdir: string): boolean {
    const map = packfileCacheMap(this.cache);
    if (!map) return false;
    const packDir = `${gitdir}/objects/pack/`;
    for (const key of map.keys()) {
      if (key.startsWith(packDir)) return true;
    }
    return false;
  }

  /** Drop every cached pack index belonging to `dir`'s repository. */
  invalidate(dir: string): void {
    const packDir = `${gitdirOf(dir)}/objects/pack/`;
    const map = packfileCacheMap(this.cache);
    if (!map) return;
    for (const key of [...map.keys()]) {
      if (key.startsWith(packDir)) map.delete(key);
    }
  }

  /** Number of packfile buffers currently held in memory (tests + logging). */
  async residentPackCount(): Promise<number> {
    return (await this.residentPacks()).length;
  }

  /**
   * A repository's pack fingerprint: the sorted `objects/pack` listing plus
   * the `packed-refs` mtime. Pack FILES are immutable under their name, so a
   * changed listing is the only way cached packs can go stale; `packed-refs`
   * is sampled because a repack rewrites both together.
   */
  private async packSignature(gitdir: string): Promise<string> {
    let names: string[] = [];
    try {
      names = (await this.fs.readdir(`${gitdir}/objects/pack`))
        .filter((name) => name.endsWith('.idx') || name.endsWith('.pack'))
        .sort();
    } catch {
      // No pack directory (fresh repo, or `dir` is not a repository at all).
    }
    let packedRefs = '-';
    try {
      packedRefs = String((await this.fs.lstat(`${gitdir}/packed-refs`)).mtimeMs);
    } catch {
      // No packed-refs file; loose refs only.
    }
    return `${names.join(',')}|${packedRefs}`;
  }

  /** The cached pack indexes that currently hold a buffer, oldest use first. */
  private async residentPacks(): Promise<Array<{ key: string; index: CachedPackIndex }>> {
    const map = packfileCacheMap(this.cache);
    if (!map) return [];
    const resident: Array<{ key: string; index: CachedPackIndex; usedAt: number }> = [];
    for (const [key, entry] of map) {
      let index: CachedPackIndex | undefined;
      try {
        index = await entry;
      } catch {
        // A failed .idx parse is isomorphic-git's problem, not the cache's.
        continue;
      }
      if (!index?.pack) continue;
      resident.push({ key, index, usedAt: index._lastUsedAt ?? 0 });
    }
    resident.sort((a, b) => a.usedAt - b.usedAt);
    return resident.map(({ key, index }) => ({ key, index }));
  }

  /**
   * Unload the least recently used pack buffers past the bound. Only ever
   * runs with no command in flight: `GitPackIndex.readSlice` awaits
   * `this.pack` once per read, so clearing it under a live reader would fail
   * that read instead of merely costing it a re-read.
   */
  private async trimResidentPacks(): Promise<void> {
    const resident = await this.residentPacks();
    if (resident.length <= this.maxResidentPacks) return;
    const victims = resident.slice(0, resident.length - this.maxResidentPacks);
    for (const { index } of victims) index.pack = null;
    logger.debug('unloaded packfile buffers past the resident bound', {
      unloaded: victims.length,
      resident: this.maxResidentPacks,
    });
  }
}
