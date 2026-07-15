/**
 * Encapsulates the orchestrator's memory-persistence surface:
 *
 * - `/shared/CLAUDE.md` (the global, scoop-visible file) — read/written by
 *   `get/setGlobalMemory`; the orchestrator's `update_global_memory` tool sits
 *   on top of this.
 * - `/workspace/CLAUDE.md` (the cone's auto-extracted memory) — appended via
 *   {@link appendConeMemory}; serialized through `memoryWriteChain` so
 *   concurrent compaction + "New session" passes can't race.
 * - One-shot migration of legacy `## Auto-extracted` blocks from the shared
 *   file into the cone file; sentinel at `/workspace/.cone-memory-migrated`.
 *
 * Extracted from Orchestrator to keep that class focused on scoop lifecycle.
 * The shared-FS handle is supplied lazily because the orchestrator initializes
 * it inside `init()`, after the store has been constructed.
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import { createLogger } from '../core/logger.js';
import { FsError, type VirtualFS } from '../fs/index.js';
import { applyConeMemoryBudget, CONE_MEMORY_PATH } from './cone-memory-budget.js';
import { createDefaultSharedFiles } from './skills.js';

const log = createLogger('cone-memory-store');

export interface ConeMemoryStoreDeps {
  /** Live shared VFS handle; `null` before orchestrator `init()` resolves. */
  getSharedFs(): VirtualFS | null;
}

export interface AppendConeMemoryMeta {
  source: string;
  model?: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class ConeMemoryStore {
  private globalMemoryCache: string = '';
  private memoryWriteChain: Promise<void> = Promise.resolve();
  private readonly deps: ConeMemoryStoreDeps;

  constructor(deps: ConeMemoryStoreDeps) {
    this.deps = deps;
  }

  /** Ensure /shared/CLAUDE.md exists with default content and prime the cache. */
  async ensureGlobalMemory(): Promise<void> {
    const fs = this.deps.getSharedFs();
    if (!fs) return;

    await createDefaultSharedFiles(fs);

    try {
      const content = await fs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' });
      this.globalMemoryCache =
        typeof content === 'string' ? content : new TextDecoder().decode(content);
    } catch {
      log.warn('Global memory file not found after creating defaults');
    }
  }

  /** Get global memory content, populating the cache on first hit. */
  async getGlobalMemory(): Promise<string> {
    if (this.globalMemoryCache) return this.globalMemoryCache;

    const fs = this.deps.getSharedFs();
    if (fs) {
      try {
        const content = await fs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' });
        this.globalMemoryCache =
          typeof content === 'string' ? content : new TextDecoder().decode(content);
      } catch {
        // No global memory yet
      }
    }

    return this.globalMemoryCache;
  }

  /** Replace global memory content. No-op when the shared FS isn't ready. */
  async setGlobalMemory(content: string): Promise<void> {
    const fs = this.deps.getSharedFs();
    if (!fs) return;
    await fs.writeFile('/shared/CLAUDE.md', content);
    this.globalMemoryCache = content;
    log.info('Global memory updated');
  }

  /**
   * Append a dated `## Auto-extracted` block of memory bullets to
   * `/workspace/CLAUDE.md` (the cone's memory). Serializes writes through an
   * internal promise chain so concurrent compaction + "New session" passes
   * cannot race. After each append, runs the logarithmic-budget restructure
   * pass best-effort.
   */
  async appendConeMemory(bullets: string, meta: AppendConeMemoryMeta): Promise<void> {
    if (!this.deps.getSharedFs()) return;
    const trimmed = bullets.trim();
    if (!trimmed) return;

    const next = this.memoryWriteChain.then(async () => {
      const fs = this.deps.getSharedFs();
      if (!fs) return;
      let current = '';
      try {
        const raw = await fs.readFile(CONE_MEMORY_PATH, { encoding: 'utf-8' });
        current = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      } catch (err) {
        // Only treat "file doesn't exist yet" as empty. Anything else (transient
        // OPFS fault, RestrictedFS EACCES, mount-backed I/O error) MUST propagate
        // up to the outer memoryWriteChain `.catch` — otherwise the unconditional
        // writeFile below would clobber existing durable memory with just the
        // new bullets. Mirrors the ENOENT-only pattern from `readIfPresent` in
        // packages/cloud-core/src/operations/resume.ts (PR #1357).
        if (!(err instanceof FsError) || err.code !== 'ENOENT') throw err;
        // Parent may still be missing on a truly-fresh cone; `recursive: true`
        // makes this a no-op when the directory already exists.
        await fs.mkdir('/workspace', { recursive: true });
      }
      const date = new Date().toISOString().slice(0, 10);
      const heading = `## Auto-extracted (${date}, ${meta.source})`;
      const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
      const block = `${separator}\n${heading}\n\n${trimmed}\n`;
      await fs.writeFile(CONE_MEMORY_PATH, current + block);
      log.info('Cone memory appended', { source: meta.source, length: trimmed.length });

      try {
        await applyConeMemoryBudget({
          vfs: fs,
          model: meta.model,
          apiKey: meta.apiKey,
          headers: meta.headers,
          signal: meta.signal,
        });
      } catch (err) {
        log.warn('applyConeMemoryBudget threw — ignored', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    this.memoryWriteChain = next.catch((err) => {
      log.warn('Cone memory append failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    await next;
  }

  /**
   * One-shot migration of pre-existing `## Auto-extracted` blocks from
   * `/shared/CLAUDE.md` into `/workspace/CLAUDE.md`. Drops a sentinel at
   * `/workspace/.cone-memory-migrated` so subsequent boots are no-ops.
   * Preserves any user-authored header/footer in the shared file verbatim.
   */
  async migrateLegacyConeMemory(): Promise<void> {
    const fs = this.deps.getSharedFs();
    if (!fs) return;
    const sentinelPath = '/workspace/.cone-memory-migrated';
    try {
      await fs.stat(sentinelPath);
      return;
    } catch {
      // No sentinel yet — proceed with the migration check.
    }

    let sharedContent = '';
    try {
      const raw = await fs.readFile('/shared/CLAUDE.md', { encoding: 'utf-8' });
      sharedContent = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch {
      // No shared memory file — nothing to migrate. Drop the sentinel below.
    }

    const autoBlockRegex = /^## Auto-extracted[^\n]*$/m;
    if (!autoBlockRegex.test(sharedContent)) {
      await this.writeMigrationSentinel(sentinelPath);
      return;
    }

    const lines = sharedContent.split('\n');
    const blocks: string[] = [];
    const kept: string[] = [];
    let i = 0;
    while (i < lines.length) {
      if (/^## Auto-extracted/.test(lines[i])) {
        const start = i;
        i++;
        while (i < lines.length && !/^#{1,2}\s/.test(lines[i])) i++;
        blocks.push(lines.slice(start, i).join('\n').trimEnd());
      } else {
        kept.push(lines[i]);
        i++;
      }
    }

    if (blocks.length === 0) {
      await this.writeMigrationSentinel(sentinelPath);
      return;
    }

    let coneContent = '';
    try {
      const raw = await fs.readFile('/workspace/CLAUDE.md', { encoding: 'utf-8' });
      coneContent = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch {
      try {
        await fs.mkdir('/workspace', { recursive: true });
      } catch {
        // Already exists
      }
    }
    const separator = coneContent.length === 0 || coneContent.endsWith('\n') ? '' : '\n';
    const merged = coneContent + separator + '\n' + blocks.join('\n\n') + '\n';
    await fs.writeFile('/workspace/CLAUDE.md', merged);

    let endIdx = kept.length;
    while (endIdx > 0 && kept[endIdx - 1] === '') endIdx--;
    const newShared = endIdx === 0 ? '' : kept.slice(0, endIdx).join('\n') + '\n';
    await fs.writeFile('/shared/CLAUDE.md', newShared);
    this.globalMemoryCache = newShared;

    await this.writeMigrationSentinel(sentinelPath);
    log.info('Migrated legacy cone memory from /shared/CLAUDE.md to /workspace/CLAUDE.md', {
      blockCount: blocks.length,
    });
  }

  private async writeMigrationSentinel(sentinelPath: string): Promise<void> {
    const fs = this.deps.getSharedFs();
    if (!fs) return;
    try {
      await fs.mkdir('/workspace', { recursive: true });
    } catch {
      // Already exists
    }
    await fs.writeFile(sentinelPath, `Migration completed at ${new Date().toISOString()}\n`);
  }
}
