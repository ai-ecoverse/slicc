/**
 * `sidecar-probe.ts` — OPFS lookups for the boot sidecar repair.
 *
 * The pre-boot repair used to resolve every sidecar path from the OPFS root,
 * one `getDirectoryHandle` per segment, then `getFile()` just to read a size.
 * On a 22k-entry tree that is O(entries × depth) serial IPCs and dominated
 * kernel boot (field: ~8 minutes on a cold, I/O-starved disk).
 *
 * Two probes share the repair's result type:
 *
 * - {@link makeOpfsProbe} caches directory handles by path prefix and asks
 *   `createSyncAccessHandle().getSize()` before falling back to `getFile()`.
 *   Kind-reconcile uses it for a single path.
 * - {@link makeBulkOpfsProbe} lists each directory once (`entries()`) and
 *   reuses that child map for every sibling. Boot repair uses it. File sizes
 *   still come from metadata (`getSize`), not a content snapshot, and only
 *   for real files.
 *
 * A clean boot skips both. After a repair that matches the tree we write
 * `/.metadata.consistent.json` holding a hash of the sidecar bytes. The next
 * mount trusts that hash until something mutates the tree and deletes the
 * mark first (`invalidateSidecarConsistency`).
 */

import { SIDECAR_CONSISTENT_NAME, type SidecarIndexJson } from './sidecar-merge.js';

/** Same ceiling `opfs-mount.ts` uses for ZenFS preload. Native OPFS was tested at 16. */
export const SIDECAR_REPAIR_CONCURRENCY = 16;

const CONSISTENCY_VERSION = 1;

/** What the filesystem really holds at a sidecar entry's path. */
export type SidecarProbeResult =
  | { kind: 'file'; size: number }
  | { kind: 'directory' }
  | { kind: 'missing' };

/** Which handle to try first. A miss still falls through to the other kind. */
export type SidecarProbeHint = 'file' | 'directory';

/** Resolve a sidecar path (e.g. `/workspace/CLAUDE.md`) against reality. */
export type SidecarProbe = (path: string, hint?: SidecarProbeHint) => Promise<SidecarProbeResult>;

interface ConsistencyMark {
  v: number;
  hash: string;
}

interface SyncSizeHandle {
  getSize(): number;
  close(): void | Promise<void>;
}

type FileHandleWithSyncSize = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<SyncSizeHandle>;
};

/** Run `fn` over `items` with at most `concurrency` calls in flight. Order matches `items`. */
export async function mapPool<T, R>(
  concurrency: number,
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R> | R
): Promise<R[]> {
  const width = Math.max(1, Math.trunc(concurrency) || 1);
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };
  const workers: Promise<void>[] = [];
  const started = Math.min(width, items.length);
  for (let i = 0; i < started; i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Byte length without snapshotting the file body.
 *
 * `FileSystemFileHandle.getFile()` builds a `File` snapshot. In a dedicated
 * worker `createSyncAccessHandle().getSize()` is the metadata read. It is
 * worker-only and exclusive, so a failure (page realm, file already open)
 * falls back to the snapshot's `size`. The access handle is always closed —
 * leaving it open locks the file and the following ZenFS mount fails.
 */
export async function readOpfsFileSize(handle: FileSystemFileHandle): Promise<number> {
  const withSync = handle as FileHandleWithSyncSize;
  if (typeof withSync.createSyncAccessHandle === 'function') {
    try {
      const access = await withSync.createSyncAccessHandle();
      try {
        return access.getSize();
      } finally {
        try {
          await access.close();
        } catch {
          /* The size was already read. A close error must not hide it. */
        }
      }
    } catch {
      /* Not a worker, or the file is busy. Snapshot size below. */
    }
  }
  return (await handle.getFile()).size;
}

async function readHandleText(handle: FileSystemFileHandle): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await (await handle.getFile()).text();
    } catch (err) {
      if ((err as { name?: string } | null)?.name !== 'NotReadableError') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

function isSidecarIndex(parsed: unknown): parsed is SidecarIndexJson {
  if (!parsed || typeof parsed !== 'object') return false;
  const entries = (parsed as SidecarIndexJson).entries;
  return !!entries && typeof entries === 'object';
}

/** Read `/.metadata.json`. `null` means absent, unreadable, or not a ZenFS index. */
export async function readOpfsSidecar(
  root: FileSystemDirectoryHandle
): Promise<{ text: string; doc: SidecarIndexJson } | null> {
  try {
    const handle = await root.getFileHandle('.metadata.json');
    const text = await readHandleText(handle);
    const parsed: unknown = JSON.parse(text);
    if (!isSidecarIndex(parsed)) return null;
    return { text, doc: parsed };
  } catch {
    return null;
  }
}

export async function writeOpfsSidecarText(
  root: FileSystemDirectoryHandle,
  text: string
): Promise<void> {
  const handle = await root.getFileHandle('.metadata.json', { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** True when `text` is exactly the sidecar bytes last certified against the tree. */
export async function sidecarConsistencyMatches(
  root: FileSystemDirectoryHandle,
  text: string
): Promise<boolean> {
  try {
    const handle = await root.getFileHandle(SIDECAR_CONSISTENT_NAME);
    const parsed: unknown = JSON.parse(await readHandleText(handle));
    if (!parsed || typeof parsed !== 'object') return false;
    const mark = parsed as ConsistencyMark;
    if (mark.v !== CONSISTENCY_VERSION || typeof mark.hash !== 'string') return false;
    return mark.hash === (await fingerprint(text));
  } catch {
    return false;
  }
}

/** Remember that `text` matched the OPFS tree, so the next mount can skip the probe. */
export async function certifySidecarConsistency(
  root: FileSystemDirectoryHandle,
  text: string
): Promise<void> {
  const mark: ConsistencyMark = { v: CONSISTENCY_VERSION, hash: await fingerprint(text) };
  const handle = await root.getFileHandle(SIDECAR_CONSISTENT_NAME, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(mark));
  await writable.close();
}

/**
 * Forget the certification. Callers must finish this before OPFS bytes change:
 * a crash between the write and the delete would skip a tree the sidecar no
 * longer describes.
 */
export async function invalidateSidecarConsistency(root: FileSystemDirectoryHandle): Promise<void> {
  try {
    await root.removeEntry(SIDECAR_CONSISTENT_NAME);
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'NotFoundError') return;
    throw err;
  }
}

async function cachedDirectory(
  root: FileSystemDirectoryHandle,
  cache: Map<string, FileSystemDirectoryHandle>,
  parts: readonly string[]
): Promise<FileSystemDirectoryHandle | null> {
  let dir = root;
  let key = '';
  let start = 0;
  for (let i = parts.length; i > 0; i -= 1) {
    const candidate = parts.slice(0, i).join('/');
    const hit = cache.get(candidate);
    if (hit) {
      dir = hit;
      key = candidate;
      start = i;
      break;
    }
  }
  for (let i = start; i < parts.length; i += 1) {
    const name = parts[i] as string;
    try {
      dir = await dir.getDirectoryHandle(name);
    } catch {
      return null;
    }
    key = key ? `${key}/${name}` : name;
    cache.set(key, dir);
  }
  return dir;
}

async function resolveLeaf(
  dir: FileSystemDirectoryHandle,
  name: string,
  hint: SidecarProbeHint | undefined,
  includeSize: boolean,
  cache: Map<string, FileSystemDirectoryHandle>,
  parentKey: string
): Promise<SidecarProbeResult> {
  const asDirectory = async (): Promise<SidecarProbeResult | null> => {
    try {
      const child = await dir.getDirectoryHandle(name);
      cache.set(parentKey ? `${parentKey}/${name}` : name, child);
      return { kind: 'directory' };
    } catch {
      return null;
    }
  };
  const asFile = async (): Promise<SidecarProbeResult | null> => {
    try {
      const child = await dir.getFileHandle(name);
      if (!includeSize) return { kind: 'file', size: 0 };
      return { kind: 'file', size: await readOpfsFileSize(child) };
    } catch {
      return null;
    }
  };
  if (hint === 'directory') {
    return (await asDirectory()) ?? (await asFile()) ?? { kind: 'missing' };
  }
  return (await asFile()) ?? (await asDirectory()) ?? { kind: 'missing' };
}

export interface OpfsProbeOptions {
  /** When false, file results report `size: 0` and never read the file. */
  includeSize?: boolean;
}

/**
 * Single-path probe. Directory handles are cached by prefix so a walk of
 * `/a/b/c` then `/a/b/d` resolves `a` and `a/b` once. `hint` tries the likely
 * kind first so a directory entry does not pay a failing `getFileHandle`.
 */
export function makeOpfsProbe(
  root: FileSystemDirectoryHandle,
  options?: OpfsProbeOptions
): SidecarProbe {
  const includeSize = options?.includeSize !== false;
  const cache = new Map<string, FileSystemDirectoryHandle>();
  return async (path: string, hint?: SidecarProbeHint): Promise<SidecarProbeResult> => {
    const parts = path.split('/').filter(Boolean);
    const parent = await cachedDirectory(root, cache, parts.slice(0, -1));
    if (!parent) return { kind: 'missing' };
    const name = parts[parts.length - 1];
    if (name === undefined) return { kind: 'directory' };
    const parentKey = parts.slice(0, -1).join('/');
    return resolveLeaf(parent, name, hint, includeSize, cache, parentKey);
  };
}

async function listChildren(
  dir: FileSystemDirectoryHandle
): Promise<Map<string, FileSystemHandle>> {
  const children = new Map<string, FileSystemHandle>();
  for await (const [name, handle] of dir.entries()) {
    children.set(name, handle);
  }
  return children;
}

function childKind(handle: FileSystemHandle): SidecarProbeResult['kind'] | 'other' {
  if (handle.kind === 'directory') return 'directory';
  if (handle.kind === 'file') return 'file';
  return 'other';
}

/**
 * Boot probe. The first lookup under a directory lists it once; every sibling
 * reuses that map. File sizes are read only for handles `entries()` already
 * identified as files, so a directory never becomes a `getFile()` snapshot.
 */
export function makeBulkOpfsProbe(root: FileSystemDirectoryHandle): SidecarProbe {
  if (typeof root.entries !== 'function') return makeOpfsProbe(root);
  const listings = new Map<string, Promise<Map<string, FileSystemHandle>>>();
  const childrenOf = (dir: FileSystemDirectoryHandle, key: string) => {
    const pending = listings.get(key);
    if (pending) return pending;
    const listed = listChildren(dir).catch((err: unknown) => {
      listings.delete(key);
      throw err;
    });
    listings.set(key, listed);
    return listed;
  };
  return async (path: string): Promise<SidecarProbeResult> => {
    const parts = path.split('/').filter(Boolean);
    let dir = root;
    let key = '';
    for (let i = 0; i < parts.length; i += 1) {
      const name = parts[i] as string;
      const children = await childrenOf(dir, key);
      const child = children.get(name);
      if (!child) return { kind: 'missing' };
      const kind = childKind(child);
      const isLast = i === parts.length - 1;
      if (!isLast) {
        if (kind !== 'directory') return { kind: 'missing' };
        dir = child as FileSystemDirectoryHandle;
        key = `${key}/${name}`;
        continue;
      }
      if (kind === 'directory') return { kind: 'directory' };
      if (kind !== 'file') return { kind: 'missing' };
      return { kind: 'file', size: await readOpfsFileSize(child as FileSystemFileHandle) };
    }
    return { kind: 'directory' };
  };
}
