/**
 * Pseudo-terminals from a real program: the Emscripten build of the
 * `wasitest` fixture opens `/dev/ptmx` (posix_openpt, unlockpt, ptsname),
 * its slave, sets the window size on the master, and moves bytes both ways
 * through the slave's line discipline (`pty.ts`, `process-pty.ts`).
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { FdTable, nullFile, sinkFile } from '../../../src/kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess } from '../../../src/kernel/wasm-realm/host.js';
import { PtyTable } from '../../../src/kernel/wasm-realm/pty.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { bundleProcessWorker, loadProgram, nodeWorker } from './helpers/node-wasm-process.js';

const FIXTURES = new URL('../../fixtures/wasm-wasi/', import.meta.url).pathname;

let worker: { file: string; dispose(): void };
let fs: VfsAdapter;

beforeAll(async () => {
  worker = await bundleProcessWorker();
  const vfs = await VirtualFS.create({ dbName: `pty-${Math.random()}`, wipe: true });
  await vfs.mkdir('/tmp', { recursive: true });
  fs = new VfsAdapter(vfs);
}, 120_000);

afterAll(() => worker?.dispose());

describe('pseudo-terminals (Emscripten program)', () => {
  it('posix_openpt → unlockpt → ptsname → open slave; window size and bytes both ways', async () => {
    const ptys = new PtyTable(() => {});
    let stdout = '';
    let stderr = '';
    const dec = new TextDecoder();
    const fds = new FdTable();
    fds.installAt(0, nullFile());
    fds.installAt(
      1,
      sinkFile((b) => void (stdout += dec.decode(b, { stream: true })))
    );
    fds.installAt(
      2,
      sinkFile((b) => void (stderr += dec.decode(b, { stream: true })))
    );
    const code = await spawnWasmProcess({
      pid: 41000,
      program: await loadProgram(`${FIXTURES}wasitest-em`),
      argv0: 'wasitest-em',
      args: ['pty'],
      env: { HOME: '/tmp' },
      cwd: '/tmp',
      fds,
      fs: fs as never,
      net: new LoopbackNet(),
      ptys,
      createWorker: () => nodeWorker(worker.file),
      onError: (m) => void (stderr += m),
    }).exited;
    expect(stderr).toBe('');
    expect(stdout).toBe(
      [
        // Emscripten's isatty asks for a character device, which a master is
        // not here (Linux says yes; nothing depends on it).
        'ptsname /dev/pts/0 isatty-master 0',
        'isatty-slave 1',
        'winsize 33 99',
        'slave read 6 [typed]',
        'master echo 7',
        'master read 5 crlf 1',
        'slave closed: read -1 EIO',
        '',
      ].join('\n')
    );
    expect(code).toBe(0);
    // Both ends closed: the number is free again.
    expect(ptys.numbers()).toEqual([]);
  });
});
