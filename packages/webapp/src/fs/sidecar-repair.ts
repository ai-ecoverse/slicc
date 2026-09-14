import { SIDECAR_SELF_ENTRY, type SidecarIndexJson } from './sidecar-merge.js';

const S_IFMT = 0o170000;
const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export type SidecarProbeResult =
  | { kind: 'file'; size: number }
  | { kind: 'directory' }
  | { kind: 'missing' };

export type SidecarProbe = (path: string) => Promise<SidecarProbeResult>;

export interface SidecarRepairSummary {
  kindFixed: string[];

  sizesFixed: number;

  dropped: number;

  selfEntryDropped: boolean;

  inosReassigned: number;

  nlinksFixed: number;

  changed: boolean;
}

interface MutableEntry {
  mode?: number;
  size?: number;
  ino?: number;
  data?: number;
  nlink?: number;
}

export async function repairSidecarDocument(
  doc: SidecarIndexJson,
  probe: SidecarProbe,
  onEntry?: () => void
): Promise<SidecarRepairSummary> {
  const summary: SidecarRepairSummary = {
    kindFixed: [],
    sizesFixed: 0,
    dropped: 0,
    selfEntryDropped: false,
    inosReassigned: 0,
    nlinksFixed: 0,
    changed: false,
  };
  const entries = doc.entries ?? {};
  for (const [path, raw] of Object.entries(entries)) {
    onEntry?.();
    if (path === '/' || typeof raw !== 'object' || raw === null) continue;

    if (path === SIDECAR_SELF_ENTRY) {
      delete entries[path];
      summary.selfEntryDropped = true;
      summary.changed = true;
      continue;
    }
    const entry = raw as MutableEntry;
    const fmt = (entry.mode ?? 0) & S_IFMT;
    if (fmt === S_IFLNK) {
      healNlink(entry, summary);
      continue;
    }
    const real = await probe(path);
    if (real.kind === 'missing') {
      delete entries[path];
      summary.dropped += 1;
      summary.changed = true;
      continue;
    }
    healNlink(entry, summary);
    repairEntryAgainstReality(path, entry, fmt, real, summary);
  }
  reassignDuplicateInos(entries, summary);
  return summary;
}

function reassignDuplicateInos(
  entries: { [path: string]: unknown },
  summary: SidecarRepairSummary
): void {
  let ceiling = 0;
  for (const raw of Object.values(entries)) {
    const e = raw as MutableEntry | null;
    if (typeof e?.ino === 'number') ceiling = Math.max(ceiling, e.ino);
    if (typeof e?.data === 'number') ceiling = Math.max(ceiling, e.data);
  }
  let next = ceiling + 1;
  const claimed = new Set<number>();
  for (const [path, raw] of Object.entries(entries)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as MutableEntry;
    if (path === '/') {
      if (typeof entry.ino === 'number') claimed.add(entry.ino);
      continue;
    }
    const ino = entry.ino;
    if (typeof ino === 'number' && ino !== 0 && !claimed.has(ino)) {
      claimed.add(ino);
      continue;
    }
    entry.ino = next;
    entry.data = next + 1;
    claimed.add(next);
    next += 2;
    summary.inosReassigned += 1;
    summary.changed = true;
  }
}

function healNlink(entry: MutableEntry, summary: SidecarRepairSummary): void {
  if (entry.nlink) return;
  entry.nlink = 1;
  summary.nlinksFixed += 1;
  summary.changed = true;
}

function repairEntryAgainstReality(
  path: string,
  entry: MutableEntry,
  fmt: number,
  real: Exclude<SidecarProbeResult, { kind: 'missing' }>,
  summary: SidecarRepairSummary
): void {
  if (fmt === S_IFREG && real.kind === 'directory') {
    entry.mode = ((entry.mode ?? 0) & 0o777 || 0o755) | S_IFDIR;
    summary.kindFixed.push(`${path} file→dir`);
    summary.changed = true;
    return;
  }
  if (fmt === S_IFDIR && real.kind === 'file') {
    entry.mode = ((entry.mode ?? 0) & 0o777 || 0o644) | S_IFREG;

    entry.size = real.size;
    summary.kindFixed.push(`${path} dir→file`);
    summary.changed = true;
    return;
  }
  if (
    fmt === S_IFREG &&
    real.kind === 'file' &&
    typeof entry.size === 'number' &&
    entry.size !== real.size
  ) {
    entry.size = real.size;
    summary.sizesFixed += 1;
    summary.changed = true;
  }
}

export function makeOpfsProbe(root: FileSystemDirectoryHandle): SidecarProbe {
  return async (path: string): Promise<SidecarProbeResult> => {
    const parts = path.split('/').filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      try {
        dir = await dir.getDirectoryHandle(parts[i]);
      } catch {
        return { kind: 'missing' };
      }
    }
    const name = parts[parts.length - 1];
    if (name === undefined) return { kind: 'directory' };
    try {
      const fh = await dir.getFileHandle(name);
      return { kind: 'file', size: (await fh.getFile()).size };
    } catch {}
    try {
      await dir.getDirectoryHandle(name);
      return { kind: 'directory' };
    } catch {
      return { kind: 'missing' };
    }
  };
}

export async function resolveWithSidecarRepair<T>(
  resolve: () => Promise<T>,
  repair: () => Promise<SidecarRepairSummary | null>,
  onRepaired: (summary: SidecarRepairSummary) => void
): Promise<T> {
  try {
    return await resolve();
  } catch (err) {
    let summary: SidecarRepairSummary | null = null;
    try {
      summary = await repair();
    } catch {}
    if (!summary?.changed) throw err;
    onRepaired(summary);
    return await resolve();
  }
}

export async function repairOpfsMetadataSidecar(
  handle: FileSystemDirectoryHandle,
  onEntry?: () => void
): Promise<SidecarRepairSummary | null> {
  let doc: SidecarIndexJson;
  try {
    const fh = await handle.getFileHandle('.metadata.json');
    const parsed: unknown = JSON.parse(await (await fh.getFile()).text());
    if (!parsed || typeof parsed !== 'object' || !(parsed as SidecarIndexJson).entries) {
      return null;
    }
    doc = parsed as SidecarIndexJson;
  } catch {
    return null;
  }
  const summary = await repairSidecarDocument(doc, makeOpfsProbe(handle), onEntry);
  if (!summary.changed) return summary;
  const fh = await handle.getFileHandle('.metadata.json', { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(doc));
  await writable.close();
  return summary;
}
