/**
 * `SLICC_LIVE_FS` against real Pyodide. The bridge is a host-`node:fs`
 * adapter over a temp dir, so every POSIX op hits genuine filesystem
 * semantics and the test can observe exactly what reached the "VFS".
 */
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

/** Re-throw a host fs error as the bridge contract does: `Error` + POSIX `.code`. */
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
  };
}

/** A bridge whose VFS path `/work/x` lives at `<host>/x`; counts round-trips. */
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

  it('flushLiveVfs pushes a still-open dirty buffer', () => {
    py(`g = open('/work/open.txt', 'w'); g.write('pending'); g.flush()`);
    expect(nodeFs.readFileSync(join(host, 'open.txt'), 'utf8')).toBe('');
    flushLiveVfs(FS, plugin);
    expect(nodeFs.readFileSync(join(host, 'open.txt'), 'utf8')).toBe('pending');
    py('g.close()');
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
