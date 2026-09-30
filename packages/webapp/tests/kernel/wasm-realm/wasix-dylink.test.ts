import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { FdTable, nullFile, sinkFile } from '../../../src/kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess } from '../../../src/kernel/wasm-realm/host.js';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { importedMemory } from '../../../src/kernel/wasm-realm/wasi/wasi-module.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { bundleProcessWorker, nodeWorker } from './helpers/node-wasm-process.js';

const FIXTURES = new URL('../../fixtures/wasm-wasi/dylink/', import.meta.url).pathname;

let worker: { file: string; dispose(): void };
let fs: VfsAdapter;
let program: WasmProgram;
let weakmain: WasmProgram;
let nextPid = 46000;

beforeAll(async () => {
  worker = await bundleProcessWorker();
  const vfs = await VirtualFS.create({ dbName: `wasix-dylink-${Math.random()}`, wipe: true });
  for (const d of ['/workspace', '/usr/lib', '/opt/libs']) await vfs.mkdir(d, { recursive: true });
  for (const lib of ['liba.so', 'libb.so']) {
    await vfs.writeFile(`/opt/libs/${lib}`, readFileSync(`${FIXTURES}${lib}`));
  }

  await vfs.writeFile('/usr/lib/liba.so', readFileSync(`${FIXTURES}liba.so`));
  fs = new VfsAdapter(vfs);
  program = load('dlmain.wasm');
  weakmain = load('weakmain.wasm');
}, 120_000);

afterAll(() => worker?.dispose());

function load(name: string): WasmProgram {
  const bytes = readFileSync(`${FIXTURES}${name}`);
  const memory = importedMemory(bytes);
  return {
    abi: 'wasi',
    glue: '',
    module: new WebAssembly.Module(bytes),
    ...(memory ? { memory } : {}),
  };
}

async function run(args: string[], main = program) {
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
    pid: nextPid++,
    program: main,
    argv0: main === program ? 'dlmain' : 'weakmain',
    args,
    env: { HOME: '/home' },
    cwd: '/workspace',
    fds,
    fs: fs as never,
    net: new LoopbackNet(),
    createWorker: () => nodeWorker(worker.file),
    onError: (m) => void (stderr += m),
  }).exited;
  return { code, stdout, stderr };
}

describe('WASIX dynamic linking', () => {
  it('dlopen loads a library and what it needs; dlsym, data, function pointers, a thread', async () => {
    const r = await run(['/opt/libs']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(
      [
        'twice 42',
        'liba counter 42',
        'counter via dlsym 42',
        'missing null',
        'pointer call 43',
        'thread call 143',
        'resolved in a thread',
        'main calls it: liba',
        '',
      ].join('\n')
    );
    expect(r.code).toBe(0);
  });

  it('a library that is not there: dlopen fails with its message (dlerror)', async () => {
    const r = await run(['/nowhere']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^dlopen: .*libb\.so/);
  });

  it('env imports a PIE main module leaves undefined: weak ones are null, thread_local destructors run', async () => {
    const r = await run([], weakmain);
    expect(r.stderr).toBe('');
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe('weak_missing is absent');
    for (const line of [
      'ctor main',
      'main_tl is main',
      'ctor thread',
      'thread_tl is thread',
      'dtor thread',
      'joined',
    ]) {
      expect(lines, line).toContain(line);
    }

    expect(lines.indexOf('dtor thread')).toBeLessThan(lines.indexOf('joined'));
    expect(r.code).toBe(0);
  });

  it('an undefined function is an error when it is called, not when the program loads', async () => {
    const r = await run(['call-missing'], weakmain);
    expect(r.stdout).toBe('weak_missing is absent\n');
    expect(r.stderr).toContain('unresolved symbol strong_missing');
    expect(r.code).toBe(134);
  });
});
