import { createLogger } from '../../core/logger.js';
import type { AddItem } from './add-item.js';

const log = createLogger('add-menu-search');

export interface AddSearchProvider {
  /** Identifies the provider in debug logs; not constrained to AddItemKind
   *  because a single provider can emit multiple kinds (e.g. 'file-folder'). */
  kind: string;
  search(query: string, limit: number): Promise<AddItem[]>;
}

export interface AddSearchAggregator {
  search(query: string, perKindLimit: number): Promise<AddItem[]>;
}

/**
 * Minimal VFS surface the file/folder + skill providers need. Only
 * `readDir` is required so the providers work against both the page-side
 * `VirtualFS` (non-OPFS) and the worker-backed `RemoteVfsClient` (OPFS,
 * the browser default) — the latter does not expose a `walk` generator.
 */
interface VfsLike {
  readDir(path: string): Promise<{ name: string; type: string }[]>;
}

const WALK_LIMIT = 500;
const WALK_CACHE_TTL_MS = 3000;

const NOISY_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__']);

function isNoisyDir(name: string): boolean {
  return name.startsWith('.') || NOISY_DIR_NAMES.has(name);
}

function rank(query: string, hay: string): number {
  const q = query.toLowerCase();
  const h = hay.toLowerCase();
  if (!q) return 0;
  if (h === q) return 3;
  if (h.startsWith(q)) return 2;
  if (h.includes(q)) return 1;
  return -1;
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function isExcluded(path: string, exclude: string[]): boolean {
  return exclude.some((ex) => path === ex || path.startsWith(`${ex}/`));
}

/*
 * Breadth-first traversal of `roots` using only `readDir`, emitting a flat
 * list of file and folder `AddItem`s (bounded by `WALK_LIMIT`). Each entry's
 * parent directory is used as its `sublabel`. A failed `readDir` on any
 * single directory is logged and skipped so one unreadable subtree does not
 * abort the whole walk. Subtrees under any `exclude` prefix are skipped
 * entirely (e.g. `/workspace/skills`, which the skill provider owns).
 */
async function walkViaReadDir(
  vfs: VfsLike,
  roots: string[],
  exclude: string[]
): Promise<AddItem[]> {
  const items: AddItem[] = [];
  const seen = new Set<string>();
  const queue: string[] = roots.filter((r) => !isExcluded(r, exclude));
  while (queue.length) {
    if (items.length >= WALK_LIMIT) break;
    const dir = queue.shift() as string;
    let entries: { name: string; type: string }[];
    try {
      entries = await vfs.readDir(dir);
    } catch (err) {
      log.warn('readDir failed during walk', { dir, error: String(err) });
      continue;
    }
    for (const entry of entries) {
      const path = joinPath(dir, entry.name);
      if (seen.has(path) || isExcluded(path, exclude)) continue;
      seen.add(path);
      if (entry.type === 'directory') {
        if (isNoisyDir(entry.name)) continue;
        items.push({ kind: 'folder', label: entry.name, sublabel: dir, locator: path });
        queue.push(path);
      } else if (entry.type === 'file') {
        items.push({ kind: 'file', label: entry.name, sublabel: dir, locator: path });
      }
      if (items.length >= WALK_LIMIT) break;
    }
  }
  return items;
}

function applyQueryRanking(items: AddItem[], query: string, limit: number): AddItem[] {
  const scored = query
    ? items
        .map((it) => ({ it, s: rank(query, it.locator) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s || a.it.locator.localeCompare(b.it.locator))
        .map((x) => x.it)
    : [...items].sort((a, b) => a.locator.localeCompare(b.locator));
  return scored.slice(0, limit);
}

export function createFileFolderProvider(
  vfs: VfsLike,
  roots: string[],
  exclude: string[] = []
): AddSearchProvider {
  /*
   * The full tree is walked once and reused across keystrokes within a
   * short TTL. Over the OPFS RPC path a fresh walk per keystroke would be
   * dozens of round-trips; the cache keeps typeahead responsive while still
   * picking up filesystem changes within `WALK_CACHE_TTL_MS`.
   */
  let cache: { at: number; items: AddItem[] } | null = null;
  let inflight: Promise<AddItem[]> | null = null;

  function loadItems(): Promise<AddItem[]> {
    if (cache && Date.now() - cache.at < WALK_CACHE_TTL_MS) return Promise.resolve(cache.items);
    if (inflight) return inflight;
    inflight = walkViaReadDir(vfs, roots, exclude)
      .then((items) => {
        cache = { at: Date.now(), items };
        return items;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    kind: 'file-folder',
    async search(query, limit) {
      return applyQueryRanking(await loadItems(), query, limit);
    },
  };
}

export function createSkillProvider(vfs: VfsLike): AddSearchProvider {
  return {
    kind: 'skill',
    async search(query, limit) {
      let entries: { name: string; type: string }[] = [];
      try {
        entries = await vfs.readDir('/workspace/skills');
      } catch (err) {
        log.warn('skill provider failed', { error: String(err) });
        return [];
      }
      const skills = entries
        .filter((e) => e.type === 'directory')
        .map<AddItem>((e) => ({ kind: 'skill', label: e.name, locator: e.name }))
        .filter((it) => rank(query, it.label) >= 0)
        .sort(
          (a, b) => rank(query, b.label) - rank(query, a.label) || a.label.localeCompare(b.label)
        );
      return skills.slice(0, limit);
    },
  };
}

type ReadSessionsIndex = () => Promise<
  { filename: string; title: string; frozenAt: string; messageCount: number }[]
>;

export function createSessionProvider(readIndex: ReadSessionsIndex): AddSearchProvider {
  return {
    kind: 'session',
    async search(query, limit) {
      let index: Awaited<ReturnType<ReadSessionsIndex>> = [];
      try {
        index = await readIndex();
      } catch (err) {
        log.warn('session provider failed', { error: String(err) });
        return [];
      }

      const toItem = (e: (typeof index)[0]): AddItem => ({
        kind: 'session',
        label: e.title,
        sublabel: `${e.messageCount} messages`,
        locator: `/sessions/${e.filename}`,
      });

      if (!query) {
        // No query: return sessions newest-first. frozenAt is ISO 8601, so
        // lexicographic comparison gives correct chronological ordering.
        return [...index]
          .sort((a, b) => b.frozenAt.localeCompare(a.frozenAt))
          .slice(0, limit)
          .map(toItem);
      }

      return index
        .map(toItem)
        .filter((it) => rank(query, it.label) >= 0 || rank(query, it.locator) >= 0)
        .sort(
          (a, b) => rank(query, b.label) - rank(query, a.label) || a.label.localeCompare(b.label)
        )
        .slice(0, limit);
    },
  };
}

type GetScoops = () => { jid: string; name: string; isCone: boolean }[];

export function createScoopProvider(getScoops: GetScoops): AddSearchProvider {
  return {
    kind: 'scoop',
    async search(query, limit) {
      return getScoops()
        .filter((s) => !s.isCone)
        .map<AddItem>((s) => ({
          kind: 'scoop',
          label: s.name,
          sublabel: undefined,
          locator: s.jid,
        }))
        .filter((it) => rank(query, it.label) >= 0)
        .sort(
          (a, b) => rank(query, b.label) - rank(query, a.label) || a.label.localeCompare(b.label)
        )
        .slice(0, limit);
    },
  };
}

export function createAggregator(providers: AddSearchProvider[]): AddSearchAggregator {
  return {
    async search(query, perKindLimit) {
      const groups = await Promise.all(
        providers.map((p) =>
          p.search(query, perKindLimit).catch((err) => {
            log.warn('provider threw in aggregator', { error: String(err) });
            return [] as AddItem[];
          })
        )
      );
      log.debug('aggregator results', {
        query,
        perKind: providers.map((p, i) => [p.kind, groups[i].length]),
      });
      return groups.flat();
    },
  };
}
