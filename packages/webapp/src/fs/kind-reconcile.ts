import type { SidecarProbeResult } from './sidecar-repair.js';

const S_IFMT = 0o170000;
const S_IFDIR = 0o40000;

export type MemoryKind = 'file' | 'directory' | 'absent';

export function memoryKindOfMode(mode: number | undefined): MemoryKind {
  if (mode === undefined) return 'absent';
  return (mode & S_IFMT) === S_IFDIR ? 'directory' : 'file';
}

export function shouldReconcileKind(truth: SidecarProbeResult, memory: MemoryKind): boolean {
  if (memory === 'absent') return false;
  if (truth.kind === 'missing') return true;
  return truth.kind !== memory;
}

export interface DirtyKindFlip {
  path: string;

  ownIsDirectory: boolean;
}

function modeOf(entry: unknown): number | undefined {
  const mode = (entry as { mode?: unknown } | null)?.mode;
  return typeof mode === 'number' ? mode : undefined;
}

export function findDirtyKindFlips(
  own: { entries?: { [path: string]: unknown } },
  onDisk: { entries?: { [path: string]: unknown } },
  dirtyPaths: ReadonlySet<string>,
  dirtyPrefixes: ReadonlySet<string> = new Set()
): DirtyKindFlip[] {
  const candidates = new Set<string>(dirtyPaths);
  if (dirtyPrefixes.size > 0) {
    for (const path of Object.keys(own.entries ?? {})) {
      for (const prefix of dirtyPrefixes) {
        if (path === prefix || path.startsWith(`${prefix}/`)) {
          candidates.add(path);
          break;
        }
      }
    }
  }
  const flips: DirtyKindFlip[] = [];
  for (const path of candidates) {
    const ownEntry = own.entries?.[path];
    const diskEntry = onDisk.entries?.[path];
    if (!ownEntry || !diskEntry) continue;
    const ownKind = memoryKindOfMode(modeOf(ownEntry));
    const diskKind = memoryKindOfMode(modeOf(diskEntry));
    if (ownKind !== diskKind) {
      flips.push({ path, ownIsDirectory: ownKind === 'directory' });
    }
  }
  return flips;
}
