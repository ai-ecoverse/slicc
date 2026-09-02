/**
 * isomorphic-git facade with a persistent object/pack cache per repository.
 *
 * The upstream API creates a new cache object whenever a caller omits one.
 * GitCommands binds its per-repository cache to the filesystem view for each
 * invocation; cache-aware calls below then receive it automatically.
 */

import * as upstream from 'isomorphic-git';
import { normalizePath } from '../fs/path-utils.js';
import type { IsoGitFsPromises } from './vfs-fs-adapter.js';

export * from 'isomorphic-git';

const cacheForFs = new WeakMap<object, () => Promise<object>>();

interface CacheEntry {
  fingerprint: string;
  cache: object;
}

/** Stable missing-file errors; any other failure disables reuse for safety. */
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

async function statFingerprint(fs: IsoGitFsPromises, path: string): Promise<string | null> {
  try {
    const stat = await fs.stat(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    return MISSING_CODES.has(errorCodeOf(error) ?? '') ? '-' : null;
  }
}

async function directoryFingerprint(fs: IsoGitFsPromises, path: string): Promise<string | null> {
  try {
    return (await fs.readdir(path)).slice().sort().join('\u0000');
  } catch (error) {
    return MISSING_CODES.has(errorCodeOf(error) ?? '') ? '-' : null;
  }
}

async function repositoryFingerprint(
  fs: IsoGitFsPromises,
  dir: string
): Promise<string | undefined> {
  const root = normalizePath(dir);
  const gitdir = root === '/' ? '/.git' : `${root}/.git`;
  const packDir = `${gitdir}/objects/pack`;
  const parts = await Promise.all([
    directoryFingerprint(fs, packDir),
    statFingerprint(fs, packDir),
    statFingerprint(fs, `${gitdir}/packed-refs`),
  ]);
  return parts.some((part) => part === null) ? undefined : parts.join('\n');
}

/**
 * Owns cache lifetime for one GitCommands instance.
 *
 * Pack/index filenames are content-addressed. Their directory listing and
 * metadata, plus packed-refs metadata, cheaply detect repository changes. If
 * validation itself fails, a fresh unretained cache preserves correctness.
 */
export class GitObjectCache {
  private readonly entries = new Map<string, CacheEntry>();

  /** Bind lazily: commands that only resolve a ref never inspect objects/pack. */
  bind(fs: IsoGitFsPromises, dir: string): void {
    let pending: Promise<object> | undefined;
    cacheForFs.set(fs, () => {
      pending ??= this.resolve(fs, dir);
      return pending;
    });
  }

  private async resolve(fs: IsoGitFsPromises, dir: string): Promise<object> {
    const key = normalizePath(dir);
    const fingerprint = await repositoryFingerprint(fs, key);
    if (fingerprint === undefined) {
      this.entries.delete(key);
      return {};
    }

    const current = this.entries.get(key);
    if (current?.fingerprint === fingerprint) return current.cache;

    const next = { fingerprint, cache: {} };
    this.entries.set(key, next);
    return next.cache;
  }
}

async function withPersistentCache<T extends { fs: unknown; cache?: object }>(
  options: T
): Promise<T> {
  if ((typeof options.fs !== 'object' && typeof options.fs !== 'function') || !options.fs) {
    return options;
  }
  const cache = await cacheForFs.get(options.fs)?.();
  return cache ? { ...options, cache } : options;
}

function cached<TOptions extends { fs: unknown; cache?: object }, TResult>(
  operation: () => (options: TOptions) => Promise<TResult>
): (options: TOptions) => Promise<TResult> {
  return async (options) => operation()(await withPersistentCache(options));
}

// Resolve the upstream property at call time so Vitest spies installed after
// module evaluation still observe command calls.
export const abortMerge = cached(() => upstream.abortMerge);
export const add = cached(() => upstream.add);
export const addNote = cached(() => upstream.addNote);
export const annotatedTag = cached(() => upstream.annotatedTag);
export const checkout = cached(() => upstream.checkout);
export const cherryPick = cached(() => upstream.cherryPick);
export const clone = cached(() => upstream.clone);
export const commit = cached(() => upstream.commit);
export const expandOid = cached(() => upstream.expandOid);
export const fastForward = cached(() => upstream.fastForward);
export const fetch = cached(() => upstream.fetch);
export const findMergeBase = cached(() => upstream.findMergeBase);
export const indexPack = cached(() => upstream.indexPack);
export const isDescendent = cached(() => upstream.isDescendent);
export const listFiles = cached(() => upstream.listFiles);
export const listNotes = cached(() => upstream.listNotes);
export const log = cached(() => upstream.log);
export const merge = cached(() => upstream.merge);
export const packObjects = cached(() => upstream.packObjects);
export const pull = cached(() => upstream.pull);
export const push = cached(() => upstream.push);
export const readBlob = cached(() => upstream.readBlob);
export const readCommit = cached(() => upstream.readCommit);
export const readNote = cached(() => upstream.readNote);
export const readObject = cached(() => upstream.readObject);
export const readTag = cached(() => upstream.readTag);
export const readTree = cached(() => upstream.readTree);
export const remove = cached(() => upstream.remove);
export const removeNote = cached(() => upstream.removeNote);
export const resetIndex = cached(() => upstream.resetIndex);
export const status = cached(() => upstream.status);
export const statusMatrix = cached(() => upstream.statusMatrix);
export const tag = cached(() => upstream.tag);
export const walk = cached(() => upstream.walk);
