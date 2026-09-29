import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalMountBackend } from '../../../src/fs/mount/backend-local.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  bytesSource,
  FdTable,
  nullFile,
  type OpenFile,
  openPipe,
  sinkFile,
} from '../../../src/kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess } from '../../../src/kernel/wasm-realm/host.js';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { createDirectoryHandle } from '../../fs/fsa-test-helpers.js';
import { bundleProcessWorker, loadProgram, nodeWorker } from './helpers/node-wasm-process.js';

const FIXTURES = new URL('../../fixtures/wasm-wasi/', import.meta.url).pathname;
const RESEARCH = process.env.WASI_RESEARCH;
const big = (rel: string): string | undefined =>
  RESEARCH && existsSync(`${RESEARCH}/${rel}`) ? `${RESEARCH}/${rel}` : undefined;

let worker: { file: string; dispose(): void };
let fs: VfsAdapter;
let nextPid = 30000;
const programs = new Map<string, Promise<WasmProgram>>();

function wasi(path: string): Promise<WasmProgram> {
  let p = programs.get(path);
  if (!p) {
    p = WebAssembly.compile(readFileSync(path)).then((module) => ({
      abi: 'wasi' as const,
      glue: '',
      module,
    }));
    programs.set(path, p);
  }
  return p;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function start(
  program: WasmProgram,
  argv0: string,
  args: string[],
  stdio: [OpenFile, OpenFile, OpenFile],
  err: (m: string) => void,
  extra: Array<[number, OpenFile]> = [],
  cwd = '/workspace/proj'
): Promise<number> {
  const fds = new FdTable();
  for (const [i, f] of stdio.entries()) fds.installAt(i, f);
  for (const [fd, f] of extra) fds.installAt(fd, f);
  return spawnWasmProcess({
    pid: nextPid++,
    program,
    argv0,
    args,
    env: { HOME: '/home' },
    cwd,
    fds,
    fs: fs as never,
    net: new LoopbackNet(),
    createWorker: () => nodeWorker(worker.file),
    onError: err,
  }).exited;
}

async function run(
  program: WasmProgram,
  args: string[],
  opts: { stdin?: string; argv0?: string; extra?: Array<[number, OpenFile]>; cwd?: string } = {}
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const dec = new TextDecoder();
  const code = await start(
    program,
    opts.argv0 ?? 'prog',
    args,
    [
      opts.stdin !== undefined ? bytesSource(new TextEncoder().encode(opts.stdin)) : nullFile(),
      sinkFile((b) => void (stdout += dec.decode(b, { stream: true }))),
      sinkFile((b) => void (stderr += dec.decode(b, { stream: true }))),
    ],
    (m) => void (stderr += m),
    opts.extra,
    opts.cwd
  );
  return { code, stdout, stderr };
}

type Stage = { program: WasmProgram; argv0: string; args: string[] };

async function pipeline(stages: Stage[], stdin?: string): Promise<Run & { codes: number[] }> {
  let stdout = '';
  let stderr = '';
  const dec = new TextDecoder();
  let input: OpenFile =
    stdin !== undefined ? bytesSource(new TextEncoder().encode(stdin)) : nullFile();
  const exits = stages.map((s, i) => {
    const pipe = i < stages.length - 1 ? openPipe() : undefined;
    const out = pipe?.write ?? sinkFile((b) => void (stdout += dec.decode(b, { stream: true })));
    const errSink = sinkFile((b) => void (stderr += dec.decode(b)));
    const exit = start(
      s.program,
      s.argv0,
      s.args,
      [input, out, errSink],
      (m) => void (stderr += m)
    );
    if (pipe) input = pipe.read;
    return exit;
  });
  const codes = await Promise.all(exits);
  return { codes, code: codes[codes.length - 1], stdout, stderr };
}

beforeAll(async () => {
  worker = await bundleProcessWorker();
  const vfs = await VirtualFS.create({ dbName: `wasi-${Math.random()}`, wipe: true });
  for (const d of ['/workspace/proj/src', '/tmp', '/home']) await vfs.mkdir(d, { recursive: true });
  await vfs.writeFile('/workspace/proj/rel.txt', 'relative hello\n');
  await vfs.writeFile('/workspace/proj/src/lib.rs', 'fn a() {}\n// TODO: beta\n');
  await vfs.writeFile('/workspace/proj/src/main.go', 'package main\n// TODO: go\n');

  await vfs.mount(
    '/mnt',
    LocalMountBackend.fromHandle(createDirectoryHandle({}), { mountId: 'wasi' })
  );
  await vfs.mkdir('/mnt/live', { recursive: true });
  await vfs.writeFile('/mnt/live/rel.txt', 'in the mount\n');
  fs = new VfsAdapter(vfs);
}, 120_000);

afterAll(() => worker?.dispose());

const text = async (path: string) => new TextDecoder().decode(await fs.readFileBuffer(path));

describe('WASI preview1 programs in the wasm realm', () => {
  it('C (wasi-libc): create, append, rename, stat, symlink, readdir and remove on the VFS', async () => {
    const r = await run(await wasi(`${FIXTURES}wasitest.wasm`), ['files', '/tmp']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(
      [
        'read 11 alpha',
        'beta',
        'size 11 end 11 reg 1',
        'link -> b.txt',
        'ls /tmp/sub: b.txt link',
        'a.txt: ENOENT',
        'ls /tmp:',
        '',
      ].join('\n')
    );
    expect(r.code).toBe(0);
  });

  it('C: relative paths from the cwd; pread, pwrite and ftruncate reach the VFS', async () => {
    const c = await wasi(`${FIXTURES}wasitest.wasm`);
    expect((await run(c, ['cat', 'rel.txt'])).stdout).toBe('relative hello\n');
    expect((await run(c, ['rw', 'rw.bin'])).stdout).toBe('pread 23AB67 size 7\n');
    expect(await text('/workspace/proj/rw.bin')).toBe('0123AB6');
    expect((await run(c, ['ls', 'src'])).stdout).toBe('ls src: lib.rs main.go\n');
  });

  it('C: stdio, argv and env, exit codes, sleep, isatty, devices and /dev/fd', async () => {
    const c = await wasi(`${FIXTURES}wasitest.wasm`);
    expect(await run(c, ['upper'], { stdin: 'hello\n' })).toMatchObject({
      code: 0,
      stdout: 'HELLO\n',
    });
    expect((await run(c, ['env'], { argv0: 'wt' })).stdout).toBe('argv0 wt argc 2 HOME=/home\n');
    expect((await run(c, ['exit', '7'])).code).toBe(7);
    expect((await run(c, ['sleep'])).stdout).toBe('slept enough\n');
    expect((await run(c, ['tty'], { stdin: '' })).stdout).toBe(
      'isatty 0=0 1=0\nlseek stdin ESPIPE\n'
    );
    expect((await run(c, ['dev'])).stdout).toBe('devnull write 1\nurandom 8\nvia /dev/fd/1\n');
  });

  it('Zig: fd 3 is its cwd; relative and absolute paths both land on the VFS', async () => {
    const zig = await wasi(`${FIXTURES}zigtest.wasm`);
    const up = await run(zig, ['upper'], { stdin: 'one\ntwo\n' });
    expect(up).toMatchObject({ code: 0, stdout: 'ONE\nTWO\n' });
    expect(up.stderr).toContain('zig: 2 lines');
    const rel = await run(zig, ['files', '.']);
    expect(rel).toMatchObject({ code: 0, stderr: '' });
    expect(rel.stdout).toBe('read zig was here\nsize 13 kind file\nls: rel.txt rw.bin src zsub\n');
    expect((await run(zig, ['files', '/home'])).code).toBe(0);
    expect(await fs.readdir('/home')).toContain('zsub');
    expect((await run(zig, ['exit', '3'])).code).toBe(3);
  });

  it('pipes: WASI → Emscripten → WASI, byte-exact', async () => {
    const r = await pipeline(
      [
        { program: await wasi(`${FIXTURES}wasitest.wasm`), argv0: 'wasitest', args: ['upper'] },
        {
          program: await loadProgram(`${FIXTURES}wasitest-em`),
          argv0: 'wasitest-em',
          args: ['cat', '/dev/stdin'],
        },
        { program: await wasi(`${FIXTURES}zigtest.wasm`), argv0: 'zigtest', args: ['upper'] },
      ],
      'mixed abi\nline two\n'
    );
    expect(r.stdout).toBe('MIXED ABI\nLINE TWO\n');
    expect(r.codes).toEqual([0, 0, 0]);
  });

  it('a writer whose reader is gone ends with 141 (SIGPIPE), so `spin | …` ends', async () => {
    const r = await pipeline([
      {
        program: await wasi(`${FIXTURES}wasitest.wasm`),
        argv0: 'wasitest',
        args: ['spin', '100000000'],
      },
      { program: await wasi(`${FIXTURES}zigtest.wasm`), argv0: 'zigtest', args: ['exit', '0'] },
    ]);
    expect(r.codes).toEqual([141, 0]);
  });

  it('relative paths resolve from a cwd inside a mount (the harness’s /emscripten)', async () => {
    const c = await wasi(`${FIXTURES}wasitest.wasm`);
    const r = await run(c, ['cat', 'rel.txt'], { cwd: '/mnt/live' });
    expect(r).toMatchObject({ code: 0, stdout: 'in the mount\n' });
    expect((await run(c, ['ls', '.'], { cwd: '/mnt/live' })).stdout).toBe('ls .: rel.txt\n');
  });

  it('an inherited fd in the preopens’ way moves above them', async () => {
    const r = await run(await wasi(`${FIXTURES}wasitest.wasm`), ['cat', 'rel.txt'], {
      extra: [[3, nullFile()]],
    });
    expect(r).toMatchObject({ code: 0, stdout: 'relative hello\n' });
  });

  it('refuses a module preview1 cannot run, saying why (exit 126)', async () => {
    const em = await loadProgram(`${FIXTURES}wasitest-em`);
    const r = await run({ abi: 'wasi', glue: '', module: em.module }, []);
    expect(r.code).toBe(126);
    expect(r.stderr).toContain('no WASI preview1 program');
  });
});

describe.skipIf(!big('go-demo/wasidemo-go.wasm'))('WASI programs from the big toolchains', () => {
  it('Go: stdin, files, env, time.Sleep through poll_oneoff', async () => {
    const go = await wasi(big('go-demo/wasidemo-go.wasm') as string);
    expect((await run(go, ['upper'], { stdin: 'go\n' })).stdout).toBe('GO\n');
    const files = await run(go, ['files', '/workspace/proj']);
    expect(files.stdout).toContain('cwd /workspace/proj');
    expect(files.stdout).toContain('rel "relative hello\\n"');
    expect((await run(go, ['env', 'x'])).stdout).toBe(
      'HOME=/home args=[x]\nslept>=20ms true rand ok\n'
    );
  });

  it('Rust: ripgrep into uutils sort, and `yes | head -n 1`', async () => {
    const rg = big('rust/bin/rg.wasm');
    const cu = big('rust/bin/coreutils.wasm');
    if (!rg || !cu) return;
    const r = await pipeline([
      { program: await wasi(rg), argv0: 'rg', args: ['-n', 'TODO', 'src'] },
      { program: await wasi(cu), argv0: 'sort', args: [] },
    ]);
    expect(r.stdout).toBe('src/lib.rs:2:// TODO: beta\nsrc/main.go:2:// TODO: go\n');
    const yes = await pipeline([
      { program: await wasi(cu), argv0: 'yes', args: [] },
      { program: await wasi(cu), argv0: 'head', args: ['-n', '1'] },
    ]);
    expect(yes).toMatchObject({ codes: [141, 0], stdout: 'y\n' });
  });
});
