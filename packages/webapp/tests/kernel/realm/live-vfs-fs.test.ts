import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createLiveVfsPlugin,
  flushLiveVfs,
  invalidateLiveVfs,
  type LiveFsApi,
  type LiveVfsPlugin,
} from '../../../src/kernel/realm/live-vfs-fs.js';
import type {
  SyncFsBridgeStat,
  SyncFsPosixBridge,
} from '../../../src/kernel/realm/sync-fs-xhr-bridge.js';

const PYODIDE_INDEX_URL = resolve(__dirname, '../../../../../node_modules/pyodide');

function hostCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'EIO';
    throw Object.assign(new Error(String(err)), { code });
  }
}

function toStat(s: nodeFs.Stats): SyncFsBridgeStat {
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    size: s.size,
    mode: s.mode,
    mtimeMs: s.mtimeMs,
    ino: s.ino,
  };
}

function hostBridge(host: string): { bridge: SyncFsPosixBridge; calls: string[] } {
  const calls: string[] = [];
  const at = (p: string): string => join(host, p.replace(/^\/work/, ''));
  const op =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    (...a: A): R => {
      calls.push(name);
      return hostCall(() => fn(...a));
    };
  const bridge: SyncFsPosixBridge = {
    readFile: op('readFile', (p: string) => new Uint8Array(nodeFs.readFileSync(at(p)))),
    writeFile: op('writeFile', (p: string, b: Uint8Array) => nodeFs.writeFileSync(at(p), b)),
    stat: op('stat', (p: string) => toStat(nodeFs.statSync(at(p)))),
    lstat: op('lstat', (p: string) => toStat(nodeFs.lstatSync(at(p)))),
    readdir: op('readdir', (p: string) => nodeFs.readdirSync(at(p))),
    exists: op('exists', (p: string) => nodeFs.existsSync(at(p))),
    mkdir: op('mkdir', (p: string) => void nodeFs.mkdirSync(at(p), { recursive: true })),
    rm: op('rm', (p: string) => nodeFs.rmSync(at(p), { recursive: true })),
    rename: op('rename', (a: string, b: string) => nodeFs.renameSync(at(a), at(b))),
    unlink: op('unlink', (p: string) => nodeFs.unlinkSync(at(p))),
    rmdir: op('rmdir', (p: string) => nodeFs.rmdirSync(at(p))),
    symlink: op('symlink', (t: string, l: string) => nodeFs.symlinkSync(t, at(l))),
    readlink: op('readlink', (p: string) => nodeFs.readlinkSync(at(p))),
    chmod: op('chmod', (p: string, m: number) => nodeFs.chmodSync(at(p), m)),
    utimes: op('utimes', (p: string, a: number, m: number) =>
      nodeFs.utimesSync(at(p), a / 1000, m / 1000)
    ),
  };
  return { bridge, calls };
}

let pyodide: PyodideInterface;
let FS: LiveFsApi & {
  filesystems: Record<string, unknown>;
  mkdir(p: string): void;
  mount(t: unknown, o: unknown, p: string): void;
  unmount(p: string): void;
};
let plugin: LiveVfsPlugin;
let host: string;
let calls: string[];

beforeAll(async () => {
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  FS = pyodide.FS as unknown as typeof FS;
  plugin = createLiveVfsPlugin(FS);
  FS.filesystems.SLICC_LIVE_FS = plugin;
  FS.mkdir('/work');
}, 60_000);

beforeEach(() => {
  host = nodeFs.mkdtempSync(join(tmpdir(), 'live-vfs-'));
  nodeFs.writeFileSync(join(host, 'hello.txt'), 'hello from the vfs\n');
  nodeFs.mkdirSync(join(host, 'sub'));
  const made = hostBridge(host);
  calls = made.calls;
  FS.mount(plugin, { root: '/work', bridge: made.bridge }, '/work');
});

afterEach(() => {
  FS.unmount('/work');
  nodeFs.rmSync(host, { recursive: true, force: true });
});

const py = (code: string): unknown => pyodide.runPython(code);

describe('SLICC_LIVE_FS', () => {
  it('mounts without walking the tree', () => {
    expect(calls).toEqual(['stat']);
  });

  it('reports the backing file’s inode: a file replaced at its path, same size and mtime, is a new one', () => {
    const ino = (p: string) => py(`__import__('os').stat('${p}').st_ino`) as number;
    const before = ino('/work/hello.txt');
    expect(before).toBe(nodeFs.statSync(join(host, 'hello.txt')).ino);

    const { mtime } = nodeFs.statSync(join(host, 'hello.txt'));
    nodeFs.writeFileSync(join(host, 'next.tmp'), 'HELLO FROM THE VFS\n');
    nodeFs.utimesSync(join(host, 'next.tmp'), mtime, mtime);
    nodeFs.renameSync(join(host, 'next.tmp'), join(host, 'hello.txt'));
    FS.mkdir('/fresh');
    FS.mount(plugin, { root: '/work', bridge: hostBridge(host).bridge }, '/fresh');
    try {
      expect(ino('/fresh/hello.txt')).not.toBe(before);
    } finally {
      FS.unmount('/fresh');
    }
  });

  it('numbers inodes by VFS path where the backend names none: the same in every mount', () => {
    const ino = (p: string) => py(`__import__('os').stat('${p}').st_ino`) as number;

    const anonymous = (): SyncFsPosixBridge => {
      const { bridge } = hostBridge(host);
      const strip = ({ ino: _ino, ...st }: SyncFsBridgeStat) => st;
      return {
        ...bridge,
        stat: (p) => strip(bridge.stat(p)),
        lstat: (p) => strip(bridge.lstat(p)),
      };
    };
    FS.mkdir('/one');
    FS.mkdir('/two');
    FS.mount(plugin, { root: '/work', bridge: anonymous() }, '/one');
    FS.mount(plugin, { root: '/work', bridge: anonymous() }, '/two');
    try {
      const file = ino('/one/hello.txt');
      expect(file).not.toBe(ino('/one/sub'));
      expect(ino('/two/sub')).toBe(ino('/one/sub'));
      expect(ino('/two/hello.txt')).toBe(file);
    } finally {
      FS.unmount('/one');
      FS.unmount('/two');
    }
  });

  it('reads an existing file and lists directories lazily', () => {
    expect(py(`open('/work/hello.txt').read()`)).toBe('hello from the vfs\n');
    expect(py(`','.join(sorted(__import__('os').listdir('/work')))`)).toBe('hello.txt,sub');
  });

  it('writes reach the VFS on close, not before', () => {
    py(`f = open('/work/out.txt', 'w'); f.write('abc')`);
    expect(nodeFs.readFileSync(join(host, 'out.txt'), 'utf8')).toBe('');
    py(`f.close()`);
    expect(nodeFs.readFileSync(join(host, 'out.txt'), 'utf8')).toBe('abc');
  });

  it('appends, seeks and truncates', () => {
    py(`
with open('/work/hello.txt', 'a') as f: f.write('more\\n')
with open('/work/hello.txt', 'r+b') as f:
    f.seek(0, 2); end = f.tell(); f.truncate(5)
`);
    expect(py('end')).toBe('hello from the vfs\nmore\n'.length);
    expect(nodeFs.readFileSync(join(host, 'hello.txt'), 'utf8')).toBe('hello');
  });

  it('applies rename / unlink / mkdir / rmdir / symlink / chmod / utime', () => {
    py(`
import os
os.rename('/work/hello.txt', '/work/sub/moved.txt')
os.mkdir('/work/newdir'); os.rmdir('/work/newdir')
os.symlink('sub/moved.txt', '/work/link')
link_target = os.readlink('/work/link')
via_link = open('/work/link').read()
os.chmod('/work/sub/moved.txt', 0o755)
os.utime('/work/sub/moved.txt', (1000, 2000))
st = os.stat('/work/sub/moved.txt')
os.unlink('/work/link')
`);
    expect(py('link_target')).toBe('sub/moved.txt');
    expect(py('via_link')).toBe('hello from the vfs\n');
    expect(nodeFs.existsSync(join(host, 'hello.txt'))).toBe(false);
    expect(nodeFs.existsSync(join(host, 'newdir'))).toBe(false);
    expect(nodeFs.existsSync(join(host, 'link'))).toBe(false);
    const st = nodeFs.statSync(join(host, 'sub/moved.txt'));
    expect(st.mode & 0o777).toBe(0o755);
    expect(Math.round(st.mtimeMs)).toBe(2_000_000);
    expect(py('st.st_mtime')).toBe(2000);
    expect(py('st.st_mode & 0o777')).toBe(0o755);
  });

  it('a directory gets the mode its mkdir asked for (screen wants its socket dir 0700)', () => {
    py(`
import os
os.mkdir('/work/private', 0o700)
os.mkdir('/work/plain')
`);
    expect(nodeFs.statSync(join(host, 'private')).mode & 0o777).toBe(0o700);
    expect(nodeFs.statSync(join(host, 'plain')).mode & 0o777).toBe(0o755);
  });

  it('drops chmod / utime on a mount that stores no metadata instead of failing', () => {
    const meta = nodeFs.mkdtempSync(join(tmpdir(), 'live-vfs-meta-'));
    const noMeta = (): never => {
      throw Object.assign(new Error('metadata changes are not supported by this mount'), {
        code: 'ENOSYS',
      });
    };

    const metaBridge: SyncFsPosixBridge = {
      ...hostBridge(meta).bridge,
      chmod: noMeta,
      utimes: noMeta,
    };
    FS.mkdir('/meta');
    FS.mount(plugin, { root: '/work', bridge: metaBridge }, '/meta');
    try {
      py(`
import os
fd = os.open('/meta/made.txt', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
os.write(fd, b'abc'); os.close(fd)
os.chmod('/meta/made.txt', 0o600)
os.utime('/meta/made.txt', (1000, 2000))
meta_mode = os.stat('/meta/made.txt').st_mode & 0o777
`);
      expect(nodeFs.readFileSync(join(meta, 'made.txt'), 'utf8')).toBe('abc');

      expect(py('meta_mode')).toBe(nodeFs.statSync(join(meta, 'made.txt')).mode & 0o777);

      expect(
        py(`
import errno
try: os.chmod('/meta/missing.txt', 0o600); r = 'ok'
except OSError as e: r = errno.errorcode[e.errno]
r`)
      ).toBe('ENOENT');
    } finally {
      FS.unmount('/meta');
      nodeFs.rmSync(meta, { recursive: true, force: true });
    }
  });

  it('surfaces POSIX errors as the matching OSError', () => {
    py(`
import errno, os
def err(fn):
    try: fn()
    except OSError as e: return errno.errorcode[e.errno]
open('/work/sub/x', 'w').close()
missing = err(lambda: open('/work/nope.txt'))
not_empty = err(lambda: os.rmdir('/work/sub'))
is_dir = err(lambda: os.unlink('/work/sub'))
`);
    expect(py('missing')).toBe('ENOENT');
    expect(py('not_empty')).toBe('ENOTEMPTY');
    expect(py('is_dir')).toBe('EISDIR');
  });

  it('keeps a file unlinked while open for its streams, and never writes it back', () => {
    py(`
import os
fd = os.open('/work/tmpXYZ', os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
os.unlink('/work/tmpXYZ')
os.write(fd, b'staged bytes')
size = os.fstat(fd).st_size
os.lseek(fd, 0, 0)
back = os.read(fd, 100).decode()
os.ftruncate(fd, 6)
os.lseek(fd, 0, 0)
cut = os.read(fd, 100).decode()
os.close(fd)
`);
    expect(py('back')).toBe('staged bytes');
    expect(py('size')).toBe(12);
    expect(py('cut')).toBe('staged');
    expect(nodeFs.existsSync(join(host, 'tmpXYZ'))).toBe(false);
    expect(py(`os.path.exists('/work/tmpXYZ')`)).toBe(false);
  });

  it('keeps the bytes an open file had when it is unlinked', () => {
    py(`
fd = os.open('/work/hello.txt', os.O_RDONLY)
os.unlink('/work/hello.txt')
kept = os.read(fd, 100).decode()
os.close(fd)
`);
    expect(py('kept')).toBe('hello from the vfs\n');
    expect(nodeFs.existsSync(join(host, 'hello.txt'))).toBe(false);
  });

  it('flushLiveVfs pushes a still-open dirty buffer', () => {
    py(`g = open('/work/open.txt', 'w'); g.write('pending'); g.flush()`);
    expect(nodeFs.readFileSync(join(host, 'open.txt'), 'utf8')).toBe('');
    flushLiveVfs(FS, plugin);
    expect(nodeFs.readFileSync(join(host, 'open.txt'), 'utf8')).toBe('pending');
    py('g.close()');
  });

  it('invalidateLiveVfs re-reads a file Python holds open and already read', () => {
    py(`
import os
fd = os.open('/work/hello.txt', os.O_RDONLY)
before = os.read(fd, 100).decode()
`);
    nodeFs.writeFileSync(join(host, 'hello.txt'), 'rewritten by a child');
    invalidateLiveVfs(FS, plugin);
    expect(py(`os.lseek(fd, 0, 0); after = os.read(fd, 100).decode(); os.close(fd); after`)).toBe(
      'rewritten by a child'
    );
    expect(py('before')).toBe('hello from the vfs\n');
  });

  it('a dup keeps the file open: a redirection (open, dup2, close) survives a child running', () => {
    py(`
import os
fd = os.open('/work/redir.txt', os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
os.dup2(fd, 9)
os.close(fd)
`);

    invalidateLiveVfs(FS, plugin);
    py(`os.write(9, b'kept')`);
    flushLiveVfs(FS, plugin);
    expect(nodeFs.readFileSync(join(host, 'redir.txt'), 'utf8')).toBe('kept');
    py('os.close(9)');
    expect(nodeFs.readFileSync(join(host, 'redir.txt'), 'utf8')).toBe('kept');
  });

  it('invalidateLiveVfs makes changes by another process visible', () => {
    expect(py(`__import__('os').path.exists('/work/hello.txt')`)).toBe(true);
    nodeFs.rmSync(join(host, 'hello.txt'));
    nodeFs.writeFileSync(join(host, 'fresh.txt'), 'from a child');
    nodeFs.writeFileSync(join(host, 'sub', 'grown.txt'), 'x');
    invalidateLiveVfs(FS, plugin);
    expect(py(`__import__('os').path.exists('/work/hello.txt')`)).toBe(false);
    expect(py(`open('/work/fresh.txt').read()`)).toBe('from a child');
    expect(py(`','.join(__import__('os').listdir('/work/sub'))`)).toBe('grown.txt');
  });
});
