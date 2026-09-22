import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { RealmInitMsg } from '../../../src/kernel/realm/realm-types.js';
import type {
  SyncFsBridgeStat,
  SyncFsPosixBridge,
} from '../../../src/kernel/realm/sync-fs-xhr-bridge.js';

const PYODIDE_INDEX_URL = resolve(__dirname, '../../../../../node_modules/pyodide');

let host = '';
const at = (p: string): string => join(host, p);

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

function wrap<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  return (...a) => {
    try {
      return fn(...a);
    } catch (err) {
      throw Object.assign(new Error(String(err)), { code: (err as { code?: string }).code });
    }
  };
}

const hostBridge: SyncFsPosixBridge = {
  readFile: wrap((p) => new Uint8Array(nodeFs.readFileSync(at(p)))),
  writeFile: wrap((p, b) => nodeFs.writeFileSync(at(p), b)),
  stat: wrap((p) => toStat(nodeFs.statSync(at(p)))),
  lstat: wrap((p) => toStat(nodeFs.lstatSync(at(p)))),
  readdir: wrap((p) => nodeFs.readdirSync(at(p))),
  exists: wrap((p) => nodeFs.existsSync(at(p))),
  mkdir: wrap((p) => void nodeFs.mkdirSync(at(p), { recursive: true })),
  rm: wrap((p) => nodeFs.rmSync(at(p), { recursive: true })),
  rename: wrap((a, b) => nodeFs.renameSync(at(a), at(b))),
  unlink: wrap((p) => nodeFs.unlinkSync(at(p))),
  rmdir: wrap((p) => nodeFs.rmdirSync(at(p))),
  symlink: wrap((t, l) => nodeFs.symlinkSync(t, at(l))),
  readlink: wrap((p) => nodeFs.readlinkSync(at(p))),
  chmod: wrap((p, m) => nodeFs.chmodSync(at(p), m)),
  utimes: wrap((p, a, m) => nodeFs.utimesSync(at(p), a / 1000, m / 1000)),
};

vi.mock('../../../src/kernel/realm/realm-sync-transport.js', () => ({
  resolveSyncSabTransport: () => undefined,
  resolveSyncFsBridge: (init: RealmInitMsg) => (init.syncFsToken ? hostBridge : undefined),
}));

const { mountPyLiveVfs } = await import('../../../src/kernel/realm/py-live-vfs.js');

class ExecXHR {
  status = 0;
  responseType = '';
  timeout = 0;
  response: ArrayBuffer = new ArrayBuffer(0);
  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    const seen = nodeFs.readFileSync(at('/job/in.txt'), 'utf8');
    nodeFs.writeFileSync(at('/job/out.txt'), `child saw: ${seen}`);
    const b = new TextEncoder().encode(
      JSON.stringify({ stdout: `ok ${seen}\n`, stderr: '', exitCode: 0 })
    );
    this.status = 200;
    this.response = b.buffer.slice(0) as ArrayBuffer;
  }
  getResponseHeader(n: string): string | null {
    return n.toLowerCase() === 'x-slicc-fs' ? '1' : null;
  }
}

let pyodide: PyodideInterface;
const port = { postMessage() {}, addEventListener() {}, removeEventListener() {} };

function init(extra: Partial<RealmInitMsg> = {}): RealmInitMsg {
  return {
    type: 'realm-init',
    kind: 'py',
    code: '',
    argv: [],
    env: {},
    cwd: '/job',
    filename: 'x.py',
    syncFsToken: 'tok',
    pyodideMountDirs: ['/job', '/job/nested', '/tmp'],
    ...extra,
  } as RealmInitMsg;
}

beforeAll(async () => {
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
}, 60_000);

beforeEach(() => {
  host = nodeFs.mkdtempSync(join(tmpdir(), 'py-live-'));
  nodeFs.mkdirSync(at('/job/nested'), { recursive: true });
  nodeFs.mkdirSync(at('/tmp'));
  vi.stubGlobal('XMLHttpRequest', ExecXHR as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  nodeFs.rmSync(host, { recursive: true, force: true });
});

test('falls back without a token or with SLICC_PY_FS=opfs', () => {
  expect(mountPyLiveVfs(pyodide, init({ syncFsToken: undefined }), port, () => {})).toBeUndefined();
  const optOut = init({ env: { SLICC_PY_FS: 'opfs' } });
  expect(mountPyLiveVfs(pyodide, optOut, port, () => {})).toBeUndefined();
});

test('mounts the outermost dirs and brackets a child with flush + invalidate', () => {
  const live = mountPyLiveVfs(pyodide, init(), port, () => {});
  expect(live?.mounted).toEqual(['/job', '/tmp']);
  pyodide.runPython(`
import subprocess
# Flushed to the fd but still open: only flushLiveVfs gets it to the VFS.
f = open('/job/in.txt', 'w'); f.write('from python'); f.flush()
r = subprocess.run(['child'], capture_output=True, text=True)
back = open('/job/out.txt').read()
`);
  expect(pyodide.runPython('r.stdout')).toBe('ok from python\n');
  expect(pyodide.runPython('back')).toBe('child saw: from python');
});
