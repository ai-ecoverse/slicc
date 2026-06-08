/**
 * Verifies the `MOUNT_BOMB_FS` Emscripten-FS plugin: every node_op
 * and stream_op throws a guiding error naming the mount path and
 * directing the caller at the async `slicc.fs` module (or to copy
 * the file into the VFS first). Replaces the eager
 * `materializeRealmMounts` test (PR #919) — the new model is
 * "fail-fast sync + explicit async slicc.fs".
 *
 * Uses a fake `pyodide.FS` shim that records `mkdirTree` / `mount`
 * calls; the real plugin is exercised against the fake.
 */
import { describe, expect, it } from 'vitest';
import {
  createMountBombFs,
  formatBombMessage,
  installMountBombs,
} from '../../../src/kernel/realm/mount-bomb-fs.js';
import type { EmscriptenFsApi, FsNode } from '../../../src/kernel/realm/opfs-sync-fs.js';

const DIR_MODE = 0o040000 | 0o755;

function makeFakeFsApi(): EmscriptenFsApi {
  return {
    createNode: (parent: FsNode | null, name: string, mode: number, _dev?: number): FsNode => {
      const node = {
        id: Math.floor(Math.random() * 1_000_000),
        name,
        mode,
        parent: parent ?? (undefined as unknown as FsNode),
        timestamp: Date.now(),
        opfs: { relPath: '', size: 0, mtime: 0 },
      } as unknown as FsNode;
      return node;
    },
    isDir: (mode: number): boolean => (mode & 0o170000) === 0o040000,
    isFile: (mode: number): boolean => (mode & 0o170000) === 0o100000,
    isLink: (mode: number): boolean => (mode & 0o170000) === 0o120000,
    ErrnoError: class extends Error {
      errno: number;
      constructor(errno: number) {
        super(`errno ${errno}`);
        this.errno = errno;
      }
    },
  };
}

function makeFakePyFs(): {
  filesystems: Record<string, unknown>;
  mounts: { plugin: unknown; opts: unknown; dir: string }[];
  mkdirs: string[];
  api: EmscriptenFsApi & {
    stat: (p: string) => unknown;
    mkdirTree: (p: string) => void;
    mount: (plugin: unknown, opts: unknown, dir: string) => unknown;
    filesystems: Record<string, unknown>;
  };
} {
  const fsApi = makeFakeFsApi();
  const filesystems: Record<string, unknown> = {};
  const mounts: { plugin: unknown; opts: unknown; dir: string }[] = [];
  const mkdirs: string[] = [];
  const dirs = new Set<string>(['/']);
  const api = {
    ...fsApi,
    filesystems,
    stat: (path: string): unknown => {
      if (dirs.has(path)) return { mode: DIR_MODE };
      throw Object.assign(new Error(`ENOENT ${path}`), { errno: 44 });
    },
    mkdirTree: (path: string): void => {
      mkdirs.push(path);
      let cursor = '';
      for (const part of path.split('/').filter(Boolean)) {
        cursor += '/' + part;
        dirs.add(cursor);
      }
    },
    mount: (plugin: unknown, opts: unknown, dir: string): unknown => {
      mounts.push({ plugin, opts, dir });
      dirs.add(dir);
      return {};
    },
  };
  return { filesystems, mounts, mkdirs, api };
}

describe('formatBombMessage', () => {
  it('names the mount path and points at slicc.fs', () => {
    const msg = formatBombMessage('/mnt/kb');
    expect(msg).toContain('/mnt/kb');
    expect(msg).toContain('slicc.fs');
    expect(msg).toContain("await slicc.fs.read_text('/mnt/kb')");
  });
});

describe('createMountBombFs node_ops/stream_ops', () => {
  const Fs = makeFakeFsApi();
  const plugin = createMountBombFs(Fs);
  const mount = { opts: { mountPath: '/mnt/kb' }, mountpoint: '/mnt/kb' } as unknown as Parameters<
    typeof plugin.mount
  >[0];
  const root = plugin.mount(mount);

  it('every node_op throws the bomb message', () => {
    const ops = plugin.node_ops as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const opName of [
      'getattr',
      'setattr',
      'lookup',
      'mknod',
      'rename',
      'unlink',
      'rmdir',
      'readdir',
      'symlink',
      'readlink',
    ]) {
      expect(() => ops[opName](root, 'child', 0, 0)).toThrowError(/\/mnt\/kb/);
      expect(() => ops[opName](root, 'child', 0, 0)).toThrowError(/slicc\.fs/);
    }
  });

  it('every stream_op throws the bomb message', () => {
    const ops = plugin.stream_ops as unknown as Record<string, (...args: unknown[]) => unknown>;
    const stream = { node: root, position: 0 };
    expect(() => ops.open(stream)).toThrowError(/\/mnt\/kb/);
    expect(() => ops.read(stream, new Uint8Array(8), 0, 8, 0)).toThrowError(/slicc\.fs/);
    expect(() => ops.write(stream, new Uint8Array(8), 0, 8, 0)).toThrowError(/slicc\.fs/);
    expect(() => ops.llseek(stream, 0, 0)).toThrowError(/slicc\.fs/);
  });
});

describe('installMountBombs', () => {
  it('mounts MOUNT_BOMB_FS at each path (instant — no walk)', () => {
    const py = makeFakePyFs();
    installMountBombs(py.api, ['/mnt/kb', '/workspace/repo']);
    expect(py.mounts).toHaveLength(2);
    expect(py.mounts[0].dir).toBe('/mnt/kb');
    expect(py.mounts[1].dir).toBe('/workspace/repo');
    expect((py.mounts[0].opts as { mountPath: string }).mountPath).toBe('/mnt/kb');
    expect((py.mounts[1].opts as { mountPath: string }).mountPath).toBe('/workspace/repo');
  });

  it('creates missing parent directories via mkdirTree', () => {
    const py = makeFakePyFs();
    installMountBombs(py.api, ['/mnt/kb']);
    expect(py.mkdirs).toContain('/mnt/kb');
  });

  it('registers the plugin idempotently on filesystems', () => {
    const py = makeFakePyFs();
    installMountBombs(py.api, ['/a']);
    const first = py.filesystems.MOUNT_BOMB_FS;
    installMountBombs(py.api, ['/b']);
    expect(py.filesystems.MOUNT_BOMB_FS).toBe(first);
  });

  it('skips empty mount lists without touching FS', () => {
    const py = makeFakePyFs();
    installMountBombs(py.api, []);
    expect(py.mounts).toEqual([]);
    expect(py.mkdirs).toEqual([]);
    expect(py.filesystems.MOUNT_BOMB_FS).toBeUndefined();
  });

  it('per-path failure surfaces a warning and continues with the next path', () => {
    const py = makeFakePyFs();
    let mountCalls = 0;
    const api = {
      ...py.api,
      mount: (plugin: unknown, opts: unknown, dir: string): unknown => {
        mountCalls++;
        if (dir === '/mnt/a') throw new Error('EBUSY');
        py.mounts.push({ plugin, opts, dir });
        return {};
      },
    };
    const warnings: string[] = [];
    installMountBombs(api, ['/mnt/a', '/mnt/b'], (w) => warnings.push(w));
    expect(mountCalls).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/mnt/a');
    expect(warnings[0]).toContain('EBUSY');
    expect(py.mounts.some((m) => m.dir === '/mnt/b')).toBe(true);
  });
});
