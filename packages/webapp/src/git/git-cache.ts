import { createLogger } from '../base/logger.js';
import type { IsoGitFsPromises } from './vfs-fs-adapter.js';

const logger = createLogger('git-cache');

export interface GitCache {
  skipDeepPackVerification?: boolean;
}

export const DEFAULT_MAX_RESIDENT_PACKS = 4;

interface CachedPackIndex {
  pack?: Promise<Uint8Array | null> | Uint8Array | null;

  _lastUsedAt?: number;
}

type PackfileCacheMap = Map<string, Promise<CachedPackIndex | undefined>>;

function packfileCacheMap(cache: GitCache): PackfileCacheMap | undefined {
  for (const sym of Object.getOwnPropertySymbols(cache)) {
    if (sym.description !== 'PackfileCache') continue;
    const value = (cache as unknown as Record<symbol, unknown>)[sym];
    if (value instanceof Map) return value as PackfileCacheMap;
  }
  return undefined;
}

function gitdirOf(dir: string): string {
  return `${dir.replace(/\/+$/, '')}/.git`;
}

export class GitCacheManager {
  readonly cache: GitCache = {};

  private readonly signatures = new Map<string, string>();

  private inFlight = 0;

  private readonly maxResidentPacks: number;

  constructor(
    private readonly fs: IsoGitFsPromises,
    options: { maxResidentPacks?: number } = {}
  ) {
    this.maxResidentPacks = Math.max(1, options.maxResidentPacks ?? DEFAULT_MAX_RESIDENT_PACKS);
  }

  setDeepVerification(enabled: boolean): void {
    this.cache.skipDeepPackVerification = !enabled;
  }

  async beforeCommand(dir: string): Promise<void> {
    this.inFlight++;
    const gitdir = gitdirOf(dir);
    const previous = this.signatures.get(gitdir);
    if (previous === undefined) return;
    const signature = await this.packSignature(gitdir);
    if (previous !== signature) this.invalidate(dir);
    this.signatures.set(gitdir, signature);
  }

  async afterCommand(dir: string, options: { wrotePacks?: boolean } = {}): Promise<void> {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const gitdir = gitdirOf(dir);
    if (options.wrotePacks) {
      this.invalidate(dir);
      this.signatures.delete(gitdir);
    }
    if (this.inFlight === 0) {
      await this.evictFailedPacks();
      await this.trimResidentPacks();
    }

    if (!this.signatures.has(gitdir) && this.hasCachedPacks(gitdir)) {
      this.signatures.set(gitdir, await this.packSignature(gitdir));
    }
  }

  private async evictFailedPacks(): Promise<void> {
    const map = packfileCacheMap(this.cache);
    if (!map) return;
    for (const [key, entry] of [...map]) {
      let index: CachedPackIndex | undefined;
      try {
        index = await entry;
      } catch {
        map.delete(key);
        continue;
      }

      if (!index) {
        map.delete(key);
        continue;
      }

      if (index.pack) {
        try {
          if (!(await index.pack)) index.pack = null;
        } catch {
          index.pack = null;
        }
      }
    }
  }

  private hasCachedPacks(gitdir: string): boolean {
    const map = packfileCacheMap(this.cache);
    if (!map) return false;
    const packDir = `${gitdir}/objects/pack/`;
    for (const key of map.keys()) {
      if (key.startsWith(packDir)) return true;
    }
    return false;
  }

  invalidate(dir: string): void {
    const packDir = `${gitdirOf(dir)}/objects/pack/`;
    const map = packfileCacheMap(this.cache);
    if (!map) return;
    for (const key of [...map.keys()]) {
      if (key.startsWith(packDir)) map.delete(key);
    }
  }

  async residentPackCount(): Promise<number> {
    return (await this.residentPacks()).length;
  }

  private async packSignature(gitdir: string): Promise<string> {
    let names: string[] = [];
    try {
      names = (await this.fs.readdir(`${gitdir}/objects/pack`))
        .filter((name) => name.endsWith('.idx') || name.endsWith('.pack'))
        .sort();
    } catch {}
    let packedRefs = '-';
    try {
      packedRefs = String((await this.fs.lstat(`${gitdir}/packed-refs`)).mtimeMs);
    } catch {}
    return `${names.join(',')}|${packedRefs}`;
  }

  private async residentPacks(): Promise<Array<{ key: string; index: CachedPackIndex }>> {
    const map = packfileCacheMap(this.cache);
    if (!map) return [];
    const resident: Array<{ key: string; index: CachedPackIndex; usedAt: number }> = [];
    for (const [key, entry] of map) {
      let index: CachedPackIndex | undefined;
      try {
        index = await entry;
      } catch {
        continue;
      }
      if (!index?.pack) continue;
      resident.push({ key, index, usedAt: index._lastUsedAt ?? 0 });
    }
    resident.sort((a, b) => a.usedAt - b.usedAt);
    return resident.map(({ key, index }) => ({ key, index }));
  }

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
