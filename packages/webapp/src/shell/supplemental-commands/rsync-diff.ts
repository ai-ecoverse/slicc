export interface RsyncEntry {
  path: string;

  size: number;

  mtimeMs: number;
}

export interface RsyncDiffOptions {
  delete?: boolean;
}

export interface RsyncDiffResult {
  toAdd: string[];

  toUpdate: string[];

  toDelete: string[];

  toSkip: string[];
}

export function computeRsyncDiff(
  sourceEntries: RsyncEntry[],
  destEntries: RsyncEntry[],
  options: RsyncDiffOptions = {}
): RsyncDiffResult {
  const destMap = new Map<string, RsyncEntry>();
  for (const entry of destEntries) {
    destMap.set(entry.path, entry);
  }

  const sourceSet = new Set<string>();
  const toAdd: string[] = [];
  const toUpdate: string[] = [];
  const toSkip: string[] = [];

  for (const src of sourceEntries) {
    sourceSet.add(src.path);
    const dst = destMap.get(src.path);

    if (!dst) {
      toAdd.push(src.path);
    } else if (dst.size === src.size && dst.mtimeMs === src.mtimeMs) {
      toSkip.push(src.path);
    } else {
      toUpdate.push(src.path);
    }
  }

  const toDelete: string[] = [];
  if (options.delete) {
    for (const dst of destEntries) {
      if (!sourceSet.has(dst.path)) {
        toDelete.push(dst.path);
      }
    }
  }

  return { toAdd, toUpdate, toDelete, toSkip };
}
