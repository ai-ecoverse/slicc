/**
 * Benchmark stand-in for the boot sidecar repair.
 *
 * A real OPFS tree made the kernel spend minutes in `getDirectoryHandle` ×
 * depth plus `getFile()` per entry. These fakes count those calls. Wall
 * time is not the assertion: the fake resolves in-process, so a slow
 * algorithm would still finish quickly. The call counts are the regression
 * net — one directory listing per directory, no ancestor re-walk, no
 * `getFile()` for a size the sync-access handle already has, and a second
 * mount that skips the walk when the clean-boot mark matches.
 */
import { describe, expect, it } from 'vitest';
import type { SidecarIndexJson } from '../../src/fs/sidecar-merge.js';
import { invalidateSidecarConsistency, makeOpfsProbe } from '../../src/fs/sidecar-probe.js';
import { repairOpfsMetadataSidecar } from '../../src/fs/sidecar-repair.js';

const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;

interface Counts {
  getDirectoryHandle: number;
  getFileHandle: number;
  getFile: number;
  directoryLists: number;
  syncGetSize: number;
  removeEntry: number;
  maxInFlight: number;
}

interface FileNode {
  kind: 'file';
  size: number;
  text: string;
  syncSize: boolean;
}

interface DirNode {
  kind: 'dir';
  children: Map<string, Node>;
}

type Node = FileNode | DirNode;

function notFound(): Error {
  return Object.assign(new Error('not found'), { name: 'NotFoundError' });
}

function emptyCounts(): Counts {
  return {
    getDirectoryHandle: 0,
    getFileHandle: 0,
    getFile: 0,
    directoryLists: 0,
    syncGetSize: 0,
    removeEntry: 0,
    maxInFlight: 0,
  };
}

function createTree(counts: Counts, rootNode: DirNode): FileSystemDirectoryHandle {
  let inFlight = 0;
  const dirHandle = (node: DirNode): FileSystemDirectoryHandle => {
    const handle = {
      kind: 'directory' as const,
      async getDirectoryHandle(name: string) {
        counts.getDirectoryHandle += 1;
        const child = node.children.get(name);
        if (child?.kind !== 'dir') throw notFound();
        return dirHandle(child);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        counts.getFileHandle += 1;
        let child = node.children.get(name);
        if (!child && options?.create) {
          child = { kind: 'file', size: 0, text: '', syncSize: false };
          node.children.set(name, child);
        }
        if (child?.kind !== 'file') throw notFound();
        return fileHandle(child);
      },
      async removeEntry(name: string) {
        counts.removeEntry += 1;
        if (!node.children.delete(name)) throw notFound();
      },
      entries() {
        counts.directoryLists += 1;
        const pairs: [string, FileSystemHandle][] = [];
        for (const [name, child] of node.children) {
          pairs.push([name, child.kind === 'dir' ? dirHandle(child) : fileHandle(child)]);
        }
        return (async function* () {
          for (const pair of pairs) yield pair;
        })();
      },
    };
    return handle as unknown as FileSystemDirectoryHandle;
  };
  const fileHandle = (node: FileNode): FileSystemFileHandle => {
    const handle: {
      kind: 'file';
      getFile: () => Promise<File>;
      createWritable: () => Promise<FileSystemWritableFileStream>;
      createSyncAccessHandle?: () => Promise<{ getSize: () => number; close: () => void }>;
    } = {
      kind: 'file',
      async getFile() {
        inFlight += 1;
        counts.maxInFlight = Math.max(counts.maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        counts.getFile += 1;
        return { size: node.size, text: async () => node.text } as File;
      },
      async createWritable() {
        let body = '';
        return {
          async write(data: string) {
            body = data;
          },
          async close() {
            node.text = body;
            node.size = body.length;
          },
        } as FileSystemWritableFileStream;
      },
    };
    if (node.syncSize) {
      handle.createSyncAccessHandle = async () => {
        counts.syncGetSize += 1;
        return { getSize: () => node.size, close: () => undefined };
      };
    }
    return handle as unknown as FileSystemFileHandle;
  };
  return dirHandle(rootNode);
}

function fileNode(size: number, syncSize = false): FileNode {
  return { kind: 'file', size, text: '', syncSize };
}

describe('sidecar repair on a large synthetic OPFS tree', () => {
  it('lists each directory once, then skips the walk when the mark matches', async () => {
    const counts = emptyCounts();
    const rootNode: DirNode = { kind: 'dir', children: new Map() };
    // depth 4 × branching 4, 8 files in every directory: 341 dirs, 2728 files.
    // The old probe walked every ancestor of every entry (naiveParentResolves).
    const depth = 4;
    const branching = 4;
    const filesPerDir = 8;
    let dirs = 1;
    let files = 0;
    let naiveParentResolves = 0;
    const entries: NonNullable<SidecarIndexJson['entries']> = {
      '/': { mode: S_IFDIR | 0o755, ino: 0, data: 0, nlink: 1 },
    };
    let ino = 1;
    const add = (path: string, mode: number, size?: number) => {
      const record: { mode: number; ino: number; data: number; nlink: number; size?: number } = {
        mode,
        ino,
        data: ino + 1,
        nlink: 1,
      };
      if (size !== undefined) record.size = size;
      entries[path] = record;
      ino += 2;
      naiveParentResolves += path.split('/').filter(Boolean).length - 1;
    };
    const fill = (node: DirNode, prefix: string, level: number) => {
      for (let i = 0; i < filesPerDir; i += 1) {
        const name = `f${i}.txt`;
        node.children.set(name, fileNode(4));
        files += 1;
        add(`${prefix}/${name}`, S_IFREG | 0o644, 4);
      }
      if (level >= depth) return;
      for (let i = 0; i < branching; i += 1) {
        const name = `d${i}`;
        const child: DirNode = { kind: 'dir', children: new Map() };
        node.children.set(name, child);
        dirs += 1;
        add(`${prefix}/${name}`, S_IFDIR | 0o755);
        fill(child, `${prefix}/${name}`, level + 1);
      }
    };
    fill(rootNode, '', 0);
    const sidecar = fileNode(0);
    rootNode.children.set('.metadata.json', sidecar);
    sidecar.text = JSON.stringify({ version: 1, entries });
    const root = createTree(counts, rootNode);

    const first = await repairOpfsMetadataSidecar(root);
    expect(first?.changed).toBe(false);
    expect(counts.directoryLists).toBe(dirs);
    expect(counts.getDirectoryHandle).toBe(0);
    // Sidecar text, plus one snapshot per file. Directories contribute none.
    expect(counts.getFile).toBe(files + 1);
    expect(counts.maxInFlight).toBeGreaterThan(1);
    expect(counts.maxInFlight).toBeLessThanOrEqual(16);
    expect(naiveParentResolves).toBeGreaterThan(dirs * 3);

    const listsAfterFirst = counts.directoryLists;
    const handlesAfterFirst = counts.getDirectoryHandle;
    const second = await repairOpfsMetadataSidecar(root);
    expect(second?.changed).toBe(false);
    expect(counts.directoryLists).toBe(listsAfterFirst);
    expect(counts.getDirectoryHandle).toBe(handlesAfterFirst);

    await invalidateSidecarConsistency(root);
    const sample = rootNode.children.get('f0.txt');
    if (sample?.kind !== 'file') throw new Error('missing sample file');
    sample.size = 9;
    const third = await repairOpfsMetadataSidecar(root);
    expect(third?.sizesFixed).toBe(1);
    expect(third?.changed).toBe(true);
    expect(counts.directoryLists).toBeGreaterThan(listsAfterFirst);
    const repaired = JSON.parse(sidecar.text) as SidecarIndexJson;
    expect(repaired.entries?.['/f0.txt']).toMatchObject({ size: 9 });
  });

  it('does not snapshot a directory, and reuses cached parent handles', async () => {
    const counts = emptyCounts();
    const leaf: DirNode = { kind: 'dir', children: new Map() };
    const mid: DirNode = { kind: 'dir', children: new Map([['b', leaf]]) };
    const rootNode: DirNode = {
      kind: 'dir',
      children: new Map<string, Node>([
        ['a', mid],
        ['c.txt', fileNode(3)],
        ['d.txt', fileNode(3)],
        ['e.txt', fileNode(3)],
      ]),
    };
    leaf.children.set('c.txt', fileNode(3));
    leaf.children.set('d.txt', fileNode(3));
    leaf.children.set('e.txt', fileNode(3));
    const root = createTree(counts, rootNode);
    const probe = makeOpfsProbe(root);

    await probe('/a/b', 'directory');
    expect(counts.getFile).toBe(0);
    expect(counts.getFileHandle).toBe(0);
    expect(counts.getDirectoryHandle).toBe(2);

    counts.getDirectoryHandle = 0;
    counts.getFile = 0;
    await probe('/a/b/c.txt', 'file');
    await probe('/a/b/d.txt', 'file');
    await probe('/a/b/e.txt', 'file');
    // `a` and `a/b` were cached by the directory probe. Three files reuse them.
    expect(counts.getDirectoryHandle).toBe(0);
    expect(counts.getFile).toBe(3);
  });

  it('reads size from the sync-access handle and does not call getFile for it', async () => {
    const counts = emptyCounts();
    const rootNode: DirNode = {
      kind: 'dir',
      children: new Map([['note.txt', fileNode(11, true)]]),
    };
    const entries: NonNullable<SidecarIndexJson['entries']> = {
      '/': { mode: S_IFDIR | 0o755, ino: 0, nlink: 1 },
      '/note.txt': { mode: S_IFREG | 0o644, size: 11, ino: 1, data: 2, nlink: 1 },
    };
    const sidecar = fileNode(0);
    rootNode.children.set('.metadata.json', sidecar);
    sidecar.text = JSON.stringify({ version: 1, entries });
    const root = createTree(counts, rootNode);
    const summary = await repairOpfsMetadataSidecar(root);
    expect(summary?.changed).toBe(false);
    expect(counts.syncGetSize).toBe(1);
    expect(counts.getFile).toBe(1);
  });

  it('still flips kinds and drops missing paths through the listing probe', async () => {
    const counts = emptyCounts();
    const rootNode: DirNode = {
      kind: 'dir',
      children: new Map([['workspace', { kind: 'dir', children: new Map() }]]),
    };
    const entries: NonNullable<SidecarIndexJson['entries']> = {
      '/': { mode: S_IFDIR | 0o755, ino: 0, nlink: 1 },
      '/workspace': { mode: S_IFREG | 0o644, size: 4, ino: 1, data: 2, nlink: 1 },
      '/gone.txt': { mode: S_IFREG | 0o644, size: 4, ino: 3, data: 4, nlink: 1 },
    };
    const sidecar = fileNode(0);
    rootNode.children.set('.metadata.json', sidecar);
    sidecar.text = JSON.stringify({ version: 1, entries });
    const root = createTree(counts, rootNode);
    const summary = await repairOpfsMetadataSidecar(root);
    expect(summary?.kindFixed).toEqual(['/workspace file→dir']);
    expect(summary?.dropped).toBe(1);
    expect(counts.getFile).toBe(1);
    const repaired = JSON.parse(sidecar.text) as SidecarIndexJson;
    expect(repaired.entries).not.toHaveProperty('/gone.txt');
    expect((repaired.entries?.['/workspace'] as { mode: number }).mode & 0o170000).toBe(S_IFDIR);
  });
});
