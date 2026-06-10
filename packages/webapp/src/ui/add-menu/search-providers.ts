import type { AddItem, AddItemKind } from './add-item.js';

export interface AddSearchProvider {
  kind: AddItemKind;
  search(query: string, limit: number): Promise<AddItem[]>;
}

export interface AddSearchAggregator {
  search(query: string, perKindLimit: number): Promise<AddItem[]>;
}

/** Minimal VFS surface the file/folder + skill providers need. */
interface VfsLike {
  readDir(path: string): Promise<{ name: string; type: string }[]>;
  walk(path: string): AsyncGenerator<string>;
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

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/*
 * Walks upward from a file's immediate parent directory collecting distinct
 * ancestor paths that fall strictly under the given root (i.e. longer than
 * the root path). Stops as soon as a directory has already been seen.
 */
function collectAncestorDirs(filePath: string, root: string, seen: Set<string>): void {
  let dir = parentDir(filePath);
  while (dir.length > root.length) {
    if (seen.has(dir)) break;
    seen.add(dir);
    dir = parentDir(dir);
  }
}

async function walkFilesAndDirs(
  vfs: VfsLike,
  roots: string[]
): Promise<{ fileItems: AddItem[]; seenDirs: Set<string> }> {
  const fileItems: AddItem[] = [];
  const seenFiles = new Set<string>();
  const seenDirs = new Set<string>();
  for (const root of roots) {
    try {
      for await (const filePath of vfs.walk(root)) {
        if (seenFiles.has(filePath)) continue;
        seenFiles.add(filePath);
        fileItems.push({
          kind: 'file',
          label: basename(filePath),
          sublabel: parentDir(filePath),
          locator: filePath,
        });
        collectAncestorDirs(filePath, root, seenDirs);
        if (fileItems.length >= 500) break;
      }
    } catch {
      // skip an unreadable root
    }
    if (fileItems.length >= 500) break;
  }
  return { fileItems, seenDirs };
}

function applyQueryRanking(items: AddItem[], query: string, limit: number): AddItem[] {
  const scored = query
    ? items
        .map((it) => ({ it, s: rank(query, it.locator) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s || a.it.locator.localeCompare(b.it.locator))
        .map((x) => x.it)
    : items.sort((a, b) => a.locator.localeCompare(b.locator));
  return scored.slice(0, limit);
}

export function createFileFolderProvider(vfs: VfsLike, roots: string[]): AddSearchProvider {
  return {
    kind: 'file',
    async search(query, limit) {
      const { fileItems, seenDirs } = await walkFilesAndDirs(vfs, roots);
      const folderItems: AddItem[] = [...seenDirs].map((dir) => ({
        kind: 'folder' as const,
        label: basename(dir),
        sublabel: parentDir(dir),
        locator: dir,
      }));
      return applyQueryRanking([...folderItems, ...fileItems], query, limit);
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
      } catch {
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
      } catch {
        return [];
      }
      return index
        .map<AddItem>((e) => ({
          kind: 'session',
          label: e.title,
          sublabel: `${e.messageCount} messages`,
          locator: `/sessions/${e.filename}`,
        }))
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
        providers.map((p) => p.search(query, perKindLimit).catch(() => []))
      );
      return groups.flat();
    },
  };
}
