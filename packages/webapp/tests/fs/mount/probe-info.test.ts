import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  RefreshReport,
} from '../../../src/fs/mount/backend.js';
import {
  CASE_FOLDED_NAME,
  CASE_PROBE_NAME,
  formatMountInfo,
  type MountProbeFs,
  NFC_PROBE_NAME,
  NFD_PROBE_NAME,
  probeMountInfo,
} from '../../../src/fs/mount/probe-info.js';
import { MountCommands } from '../../../src/fs/mount-commands.js';
import { RestrictedFS } from '../../../src/fs/restricted-fs.js';
import { FsError } from '../../../src/fs/types.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';

let dbCounter = 0;
const vfsHandles: VirtualFS[] = [];

async function newVfs(): Promise<VirtualFS> {
  const vfs = await VirtualFS.create({
    dbName: `mount-info-${dbCounter++}`,
    wipe: true,
  });
  vfsHandles.push(vfs);
  return vfs;
}

afterEach(async () => {
  while (vfsHandles.length > 0) {
    const vfs = vfsHandles.pop();
    await vfs?.dispose();
  }
});

function wrapProbeFs(vfs: VirtualFS, extra: Partial<MountProbeFs> = {}): MountProbeFs {
  return {
    writeFile: (path, content) => vfs.writeFile(path, content),
    exists: (path) => vfs.exists(path),
    readDir: (path) => vfs.readDir(path),
    stat: (path) => vfs.stat(path),
    mkdir: (path, options) => vfs.mkdir(path, options),
    rm: (path, options) => vfs.rm(path, options),
    listMountPoints: () => vfs.listMountPoints(),
    ...extra,
  };
}

async function leftoverScratch(vfs: VirtualFS, dir: string): Promise<string[]> {
  const entries = await vfs.readDir(dir);
  return entries.map((e) => e.name).filter((name) => name.startsWith('.slicc-mi-'));
}

type TreeNode =
  | { kind: 'file'; storedName: string; body: Uint8Array; mode: number }
  | { kind: 'dir'; storedName: string; children: Map<string, TreeNode> };

function canon(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

function storedNfd(name: string): string {
  return name.normalize('NFD');
}

function splitRel(path: string): string[] {
  return path
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
}

/**
 * Cheap stand-in for a macOS APFS hostfs mount: lookup is case- and
 * normalization-insensitive, readdir returns NFD, names longer than 255
 * fail. Used so CI can assert the insensitive report without a real APFS
 * volume.
 */
class InsensitiveHostFsBackend implements MountBackend {
  readonly kind = 'hostfs' as const;
  readonly source = 'hostfs:///kb';
  readonly mountId = 'insensitive-fixture';
  readonly listingStatsMatchStat = true;
  readonly maxName = 255;
  private readonly root: TreeNode = { kind: 'dir', storedName: '', children: new Map() };

  private walk(parts: string[]): TreeNode {
    let node: TreeNode = this.root;
    for (const part of parts) {
      if (node.kind !== 'dir') throw new FsError('ENOTDIR', 'not a directory');
      const child = node.children.get(canon(part));
      if (!child) throw new FsError('ENOENT', 'no such file');
      node = child;
    }
    return node;
  }

  private parentOf(path: string): {
    parent: Extract<TreeNode, { kind: 'dir' }>;
    name: string;
    key: string;
  } {
    const parts = splitRel(path);
    if (parts.length === 0) throw new FsError('EINVAL', 'empty path');
    const name = parts[parts.length - 1];
    if (name.length > this.maxName) throw new FsError('EINVAL', 'file name too long');
    const parent = parts.length === 1 ? this.root : this.walk(parts.slice(0, -1));
    if (parent.kind !== 'dir') throw new FsError('ENOTDIR', 'not a directory');
    return { parent, name, key: canon(name) };
  }

  async readDir(path: string): Promise<MountDirEntry[]> {
    const parts = splitRel(path);
    const node = parts.length === 0 ? this.root : this.walk(parts);
    if (node.kind !== 'dir') throw new FsError('ENOTDIR', 'not a directory');
    return [...node.children.values()].map((child) => ({
      name: child.storedName,
      kind: child.kind === 'dir' ? 'directory' : 'file',
      ...(child.kind === 'file'
        ? { size: child.body.byteLength, lastModified: 1, mode: child.mode }
        : {}),
    }));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const node = this.walk(splitRel(path));
    if (node.kind !== 'file') throw new FsError('EISDIR', 'is a directory');
    return node.body;
  }

  async writeFile(path: string, body: Uint8Array): Promise<void> {
    const { parent, name, key } = this.parentOf(path);
    const existing = parent.children.get(key);
    if (existing?.kind === 'dir') throw new FsError('EISDIR', 'is a directory');
    parent.children.set(key, {
      kind: 'file',
      storedName: existing?.kind === 'file' ? existing.storedName : storedNfd(name),
      body,
      mode: existing?.kind === 'file' ? existing.mode : 0o100644,
    });
  }

  async stat(path: string): Promise<MountStat> {
    const parts = splitRel(path);
    const node = parts.length === 0 ? this.root : this.walk(parts);
    if (node.kind === 'dir') return { kind: 'directory', size: 0, mtime: 1 };
    return { kind: 'file', size: node.body.byteLength, mtime: 1, mode: node.mode };
  }

  async mkdir(path: string): Promise<void> {
    const { parent, name, key } = this.parentOf(path);
    if (parent.children.has(key)) return;
    parent.children.set(key, {
      kind: 'dir',
      storedName: storedNfd(name),
      children: new Map(),
    });
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const { parent, key } = this.parentOf(path);
    const child = parent.children.get(key);
    if (!child) throw new FsError('ENOENT', 'no such file');
    if (child.kind === 'dir' && child.children.size > 0 && !opts?.recursive) {
      throw new FsError('ENOTEMPTY', 'directory not empty');
    }
    parent.children.delete(key);
  }

  async refresh(): Promise<RefreshReport> {
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: 'kb', source: this.source };
  }

  getHostPath(): string {
    return '/kb';
  }

  async close(): Promise<void> {}
}

describe('probeMountInfo', () => {
  it('/tmp reports case-sensitive, byte-exact names, and executable-bit support', async () => {
    const vfs = await newVfs();
    await vfs.mkdir('/tmp', { recursive: true });

    const info = await probeMountInfo(vfs, '/tmp');

    expect(info.path).toBe('/tmp');
    expect(info.mountPoint).toBeNull();
    expect(info.kind).toBe('vfs');
    expect(info.writable).toBe(true);
    expect(info.hostBacked).toBe(false);
    expect(info.caseSensitivity).toBe('sensitive');
    expect(info.unicodeNormalization).toBe('byte-exact');
    expect(info.unicodeStorage).toBe('as-written');
    expect(info.executableBit).toBe(true);
    expect(info.namesRoundTripByteExact).toBe(true);
    expect(info.maxFilenameLength).toBeGreaterThan(0);
    expect(await leftoverScratch(vfs, '/tmp')).toEqual([]);
  });

  it('never writes the colliding case or Unicode form', async () => {
    const vfs = await newVfs();
    await vfs.mkdir('/tmp', { recursive: true });
    const written: string[] = [];
    const orig = vfs.writeFile.bind(vfs);
    const wrapped = wrapProbeFs(vfs, {
      writeFile: async (path, content) => {
        written.push(path.slice(path.lastIndexOf('/') + 1));
        return orig(path, content);
      },
    });

    await probeMountInfo(wrapped, '/tmp');

    expect(written).toContain(CASE_PROBE_NAME);
    expect(written).not.toContain(CASE_FOLDED_NAME);
    expect(written).toContain(NFC_PROBE_NAME);
    // /tmp is byte-exact, so the NFD form is a second distinct file — allowed.
    expect(written).toContain(NFD_PROBE_NAME);
    expect(await leftoverScratch(vfs, '/tmp')).toEqual([]);
  });

  it('reports as-written when a byte-exact listing returns NFD before NFC', async () => {
    const vfs = await newVfs();
    await vfs.mkdir('/tmp', { recursive: true });
    const wrapped = wrapProbeFs(vfs, {
      readDir: async (path) => {
        const entries = await vfs.readDir(path);
        return [...entries].sort((a, b) => {
          if (a.name === NFD_PROBE_NAME) return -1;
          if (b.name === NFD_PROBE_NAME) return 1;
          return a.name.localeCompare(b.name);
        });
      },
    });

    const info = await probeMountInfo(wrapped, '/tmp');
    expect(info.unicodeNormalization).toBe('byte-exact');
    expect(info.unicodeStorage).toBe('as-written');
    expect(await leftoverScratch(vfs, '/tmp')).toEqual([]);
  });

  it('deletes S3 prefix objects even when recursive remove is unsupported', async () => {
    const objects = new Map<string, Uint8Array>();
    const rel = (path: string) => path.replace(/^\/+|\/+$/g, '');
    const fs: MountProbeFs = {
      writeFile: async (path, content) => {
        const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        objects.set(rel(path), body);
      },
      exists: async (path) => objects.has(rel(path)),
      readDir: async (path) => {
        const prefix = rel(path);
        const pre = prefix === '' ? '' : `${prefix}/`;
        const files = new Set<string>();
        const dirs = new Set<string>();
        for (const key of objects.keys()) {
          if (!key.startsWith(pre)) continue;
          const rest = key.slice(pre.length);
          if (!rest) continue;
          const slash = rest.indexOf('/');
          if (slash === -1) files.add(rest);
          else dirs.add(rest.slice(0, slash));
        }
        return [
          ...[...dirs].map((name) => ({ name, type: 'directory' as const })),
          ...[...files].map((name) => ({ name, type: 'file' as const })),
        ];
      },
      stat: async (path) => {
        const body = objects.get(rel(path));
        if (body) {
          return { type: 'file', size: body.byteLength, mtime: 1, ctime: 1, mode: 0o100644 };
        }
        return { type: 'directory', size: 0, mtime: 1, ctime: 1 };
      },
      mkdir: async () => {},
      rm: async (path, options) => {
        if (options?.recursive) {
          throw new FsError('EINVAL', 'recursive remove not yet supported on S3', path);
        }
        const key = rel(path);
        if (!objects.has(key)) throw new FsError('ENOENT', 'no such file', path);
        objects.delete(key);
      },
      listMountPoints: () => [{ path: '/mnt/s3', kind: 's3' }],
    };
    objects.set('keep', new Uint8Array([1]));

    const info = await probeMountInfo(fs, '/mnt/s3');
    expect(info.kind).toBe('s3');
    expect(info.writable).toBe(true);
    expect([...objects.keys()].filter((k) => k.includes('.slicc-mi-'))).toEqual([]);
    expect(objects.has('keep')).toBe(true);
  });

  it('removes the scratch directory even when a later write fails', async () => {
    const vfs = await newVfs();
    await vfs.mkdir('/tmp', { recursive: true });
    const orig = vfs.writeFile.bind(vfs);
    let writes = 0;
    const wrapped = wrapProbeFs(vfs, {
      writeFile: async (path, content) => {
        writes += 1;
        if (writes > 1) throw new Error('injected failure');
        return orig(path, content);
      },
    });

    await expect(probeMountInfo(wrapped, '/tmp')).rejects.toThrow('injected failure');
    expect(await leftoverScratch(vfs, '/tmp')).toEqual([]);
  });

  it('an APFS-like hostfs fixture reports case- and Unicode-insensitive lookup', async () => {
    const vfs = await newVfs();
    await vfs.mkdir('/mnt/kb', { recursive: true });
    await vfs.mount('/mnt/kb', new InsensitiveHostFsBackend());

    const info = await probeMountInfo(vfs, '/mnt/kb');

    expect(info.mountPoint).toBe('/mnt/kb');
    expect(info.kind).toBe('hostfs');
    expect(info.hostBacked).toBe(true);
    expect(info.writable).toBe(true);
    expect(info.caseSensitivity).toBe('insensitive');
    expect(info.unicodeNormalization).toBe('insensitive');
    expect(info.unicodeStorage).toBe('nfd');
    expect(info.executableBit).toBe(false);
    expect(info.namesRoundTripByteExact).toBe(false);
    expect(info.maxFilenameLength).toBe(255);
    expect(await leftoverScratch(vfs, '/mnt/kb')).toEqual([]);
  });

  it('does not write the NFD form on a normalization-insensitive volume', async () => {
    const vfs = await newVfs();
    await vfs.mkdir('/mnt/kb', { recursive: true });
    await vfs.mount('/mnt/kb', new InsensitiveHostFsBackend());
    const orig = vfs.writeFile.bind(vfs);
    const written: string[] = [];
    const wrapped = wrapProbeFs(vfs, {
      writeFile: async (path, content) => {
        written.push(path.slice(path.lastIndexOf('/') + 1));
        return orig(path, content);
      },
    });

    await probeMountInfo(wrapped, '/mnt/kb');

    expect(written).toContain(CASE_PROBE_NAME);
    expect(written).not.toContain(CASE_FOLDED_NAME);
    expect(written).toContain(NFC_PROBE_NAME);
    expect(written).not.toContain(NFD_PROBE_NAME);
  });

  it('reports executableBit when chmod actually sets the exec bits', async () => {
    const vfs = await newVfs();
    await vfs.mkdir('/tmp', { recursive: true });
    const execPaths = new Set<string>();
    const wrapped = wrapProbeFs(vfs, {
      stat: async (path) => {
        const st = await vfs.stat(path);
        if (execPaths.has(path)) return { ...st, mode: 0o100755 };
        return st;
      },
      chmod: async (path, mode) => {
        if ((mode & 0o111) !== 0) execPaths.add(path);
      },
    });

    const info = await probeMountInfo(wrapped, '/tmp');
    expect(info.executableBit).toBe(true);
    expect(await leftoverScratch(vfs, '/tmp')).toEqual([]);
  });

  it('throws ENOENT for a missing path', async () => {
    const vfs = await newVfs();
    await expect(probeMountInfo(vfs, '/nope')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports host-backed through a RestrictedFS scoop sandbox (#3434)', async () => {
    // A scoop probes through a RestrictedFS, not the raw VFS. Before it
    // forwarded listMountPoints(), the covering mount was invisible, so the
    // kind fell back to 'vfs' and host-backed reported 'no' for a live
    // host-backed mount — the only write-safety signal a scoop has.
    const vfs = await newVfs();
    await vfs.mkdir('/scoops/editor/kb', { recursive: true });
    await vfs.mount('/scoops/editor/kb', new InsensitiveHostFsBackend());
    const restricted = new RestrictedFS(vfs, ['/scoops/editor/']);

    const info = await probeMountInfo(restricted as unknown as MountProbeFs, '/scoops/editor/kb');

    expect(info.mountPoint).toBe('/scoops/editor/kb');
    expect(info.kind).toBe('hostfs');
    expect(info.hostBacked).toBe(true);
  });
});

describe('formatMountInfo', () => {
  it('renders the /tmp shape agents grep for', () => {
    const text = formatMountInfo({
      path: '/tmp',
      mountPoint: null,
      kind: 'vfs',
      writable: true,
      hostBacked: false,
      caseSensitivity: 'sensitive',
      unicodeNormalization: 'byte-exact',
      unicodeStorage: 'as-written',
      executableBit: false,
      namesRoundTripByteExact: true,
      maxFilenameLength: 255,
    });
    expect(text).toContain('/tmp (vfs)');
    expect(text).toContain('case: sensitive');
    expect(text).toContain('unicode: byte-exact (stored as-written)');
    expect(text).toContain('executable-bit: not supported');
    expect(text).toContain('names: byte-exact');
    expect(text).toContain('host-backed: no');
  });
});

describe('mount info command', () => {
  it('emits JSON for /tmp matching the programmatic shape', async () => {
    const vfs = await newVfs();
    await vfs.mkdir('/tmp', { recursive: true });
    const cmd = new MountCommands({ fs: vfs });
    const result = await cmd.execute(['info', '--json', '/tmp'], '/');
    expect(result.exitCode).toBe(0);
    const info = JSON.parse(result.stdout) as { caseSensitivity: string; executableBit: boolean };
    expect(info.caseSensitivity).toBe('sensitive');
    expect(info.executableBit).toBe(true);
    expect(await leftoverScratch(vfs, '/tmp')).toEqual([]);
  });

  it('answers --help without probing', async () => {
    const cmd = new MountCommands({
      fs: {
        listMounts: () => [],
        getMountIndex: () => ({ getState: () => undefined }),
      } as never,
    });
    for (const args of [
      ['info', '--help'],
      ['info', '/tmp', '--help'],
      ['info', '-h'],
    ]) {
      const result = await cmd.execute(args, '/workspace');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('mount info [--json] <path>');
    }
  });

  it('requires a path', async () => {
    const cmd = new MountCommands({
      fs: { listMounts: () => [] } as never,
    });
    const result = await cmd.execute(['info'], '/workspace');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('path required');
  });
});
