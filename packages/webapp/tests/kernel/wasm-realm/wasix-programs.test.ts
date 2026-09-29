import 'fake-indexeddb/auto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import type { ChildForker, ChildSpawner } from '../../../src/kernel/wasm-realm/children.js';
import {
  bytesSource,
  FdTable,
  nullFile,
  sinkFile,
} from '../../../src/kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess } from '../../../src/kernel/wasm-realm/host.js';
import { JobTable } from '../../../src/kernel/wasm-realm/jobs.js';
import type { ForkState, WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { importedMemory } from '../../../src/kernel/wasm-realm/wasi/wasi-module.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { bundleProcessWorker, nodeWorker } from './helpers/node-wasm-process.js';

const FIXTURES = new URL('../../fixtures/wasm-wasi/', import.meta.url).pathname;
const RESEARCH = process.env.WASI_RESEARCH;
const registry = (rel: string) =>
  RESEARCH && existsSync(`${RESEARCH}/wasix/${rel}`) ? `${RESEARCH}/wasix/${rel}` : undefined;
const BASH = registry('wasmer_bash/modules/bash');
const COREUTILS = registry('wasmer_coreutils/modules/coreutils');
const PYTHON = registry('wasmer_python');
const UTILS = ['cat', 'ls', 'wc', 'sort', 'head', 'tr', 'true', 'false', 'yes'];

let worker: { file: string; dispose(): void };
let fs: VfsAdapter;
let vfs: VirtualFS;
const programs = new Map<string, WasmProgram>();
let nextPid = 42000;

function load(path: string): WasmProgram {
  const bytes = readFileSync(path);
  const memory = importedMemory(bytes);
  return {
    abi: 'wasi',
    glue: '',
    module: new WebAssembly.Module(bytes),
    ...(memory ? { memory } : {}),
  };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  procs: number;
}

function run(
  name: string,
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {}
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  let procs = 0;
  const dec = new TextDecoder();
  const jobs = new JobTable();
  const net = new LoopbackNet();
  const live = new Map<number, (sig: number) => void>();
  const kill = (target: number, sig: number) => {
    if (target < 0) return jobs.killGroup(-target, sig);
    const send = live.get(target);
    if (send && sig !== 0) send(sig);
    return send !== undefined;
  };
  const env = { HOME: '/home', PATH: '/usr/bin:/bin', PYTHONHOME: '/cpython', ...opts.env };
  const start = (
    prog: string,
    argv: string[],
    fds: FdTable,
    cwd: string,
    ppid?: number,
    fork?: ForkState
  ) => {
    const program = programs.get(prog);
    if (!program) throw Object.assign(new Error(`ENOENT ${prog}`), { code: 'ENOENT' });
    const pid = nextPid++;
    procs++;
    const h = spawnWasmProcess({
      pid,
      program,
      argv0: argv[0] ?? prog,
      args: argv.slice(1),
      env,
      cwd,
      fds,
      fs: fs as never,
      net,
      jobs,
      kill,
      createWorker: () => nodeWorker(worker.file),
      onError: (m) => void (stderr += `[${prog} ${pid}] ${m}\n`),
      spawner: spawnerOf(pid),
      forker: forkerOf(pid, prog),
      ...(ppid !== undefined ? { ppid } : {}),
      ...(fork ? { fork } : {}),
    });
    live.set(pid, (sig) => h.signal(sig));
    jobs.add(pid, ppid, (sig) => h.signal(sig));
    void h.exited.then(() => jobs.remove(pid));
    void h.exited.then(() => live.delete(pid));
    return { pid, exited: h.exited, termsig: h.termsig };
  };
  const spawnerOf =
    (ppid: number): ChildSpawner =>
    async (req, fds) =>
      start(req.file.split('/').pop() ?? req.file, req.argv, fds, req.cwd, ppid);
  const forkerOf =
    (ppid: number, prog: string): ChildForker =>
    async (state, fds) =>
      start(prog, [prog], fds, state.wasi?.cwd ?? '/workspace', ppid, state);
  const fds = new FdTable();
  fds.installAt(
    0,
    opts.stdin !== undefined ? bytesSource(new TextEncoder().encode(opts.stdin)) : nullFile()
  );
  fds.installAt(
    1,
    sinkFile((b) => void (stdout += dec.decode(b, { stream: true })))
  );
  fds.installAt(
    2,
    sinkFile((b) => void (stderr += dec.decode(b, { stream: true })))
  );
  return start(name, [name, ...args], fds, '/workspace').exited.then((code) => ({
    code,
    stdout,
    stderr,
    procs,
  }));
}

async function copyTree(from: string, to: string, skip: RegExp): Promise<void> {
  await vfs.mkdir(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (skip.test(name)) continue;
    const src = `${from}/${name}`;
    if (statSync(src).isDirectory()) await copyTree(src, `${to}/${name}`, skip);
    else await vfs.writeFile(`${to}/${name}`, readFileSync(src));
  }
}

beforeAll(async () => {
  worker = await bundleProcessWorker();
  programs.set('wasixtest', load(`${FIXTURES}wasixtest.wasm`));
  programs.set('wasitest', load(`${FIXTURES}wasitest.wasm`));
  vfs = await VirtualFS.create({ dbName: `wasix-${Math.random()}`, wipe: true });
  for (const d of ['/workspace/sub', '/home', '/tmp', '/usr/bin', '/bin'])
    await vfs.mkdir(d, { recursive: true });
  await vfs.writeFile('/workspace/sub/inside.txt', 'inside sub\n');
  await vfs.writeFile('/workspace/fruit.txt', 'pear\napple\nfig\n');
  const bins = ['wasitest', 'wasixtest'];
  if (BASH && COREUTILS) {
    programs.set('bash', load(BASH));
    programs.set('sh', programs.get('bash') as WasmProgram);
    const cu = load(COREUTILS);
    for (const u of UTILS) programs.set(u, cu);
    bins.push('bash', 'sh', ...UTILS);
  }
  if (PYTHON) {
    programs.set('python', load(`${PYTHON}/modules/python`));
    bins.push('python');
    await copyTree(
      `${PYTHON}/cpython`,
      '/cpython',
      /^(__pycache__|test|tests|idlelib|tkinter|turtledemo|lib2to3|ensurepip|bin|include)$/
    );
  }
  for (const b of bins) {
    await vfs.writeFile(`/usr/bin/${b}`, '#!wasm\n');
    await vfs.chmod(`/usr/bin/${b}`, 0o755);
  }
  fs = new VfsAdapter(vfs);
}, 300_000);

afterAll(() => worker?.dispose());

describe('WASIX (wasixtest, C/wasix-libc)', () => {
  it('fork: a new worker resumes from proc_fork with its own memory; the parent waits for its status', async () => {
    const r = await run('wasixtest', ['fork']);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toBe('child sees 8\nparent still sees 7\nchild: exit 3\n');
    expect(r.procs).toBe(2);
  });

  it('pipe + fork + exec: the child execs wasitest upper on the pipe', async () => {
    const r = await run('wasixtest', ['pipe']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('THROUGH A PIPE\nAND AN EXEC\nupper: exit 0\n');
  });

  it('a close-on-exec error pipe reaches EOF at the exec, then the child reads its stdin to EOF', async () => {
    const r = await run('wasixtest', ['subprocess']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('errpipe EOF 1\nHI\nsubprocess: exit 0\n');
  });

  it('pthreads (thread_spawn_v2): one descriptor table, then a fork of the threaded process', async () => {
    const r = await run('wasixtest', ['threads']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('doubled 2 4 6\nread threaded\nchild read threaded\nchild: exit 0\n');
  });

  it('a file open across a fork keeps one offset (the buffered file is handed to the kernel)', async () => {
    const r = await run('wasixtest', ['file', '/tmp/abc.txt']);
    expect(r.code).toBe(0);
    expect(new TextDecoder().decode(await fs.readFileBuffer('/tmp/abc.txt'))).toBe('abc');
  });

  it('setjmp / longjmp across frames', async () => {
    const r = await run('wasixtest', ['longjmp']);
    expect(r).toMatchObject({ code: 0, stdout: 'setjmp 0\nlongjmp back with 42\n' });
  });

  it('a child that signals itself ends WIFSIGNALED (the kernel applies the default action)', async () => {
    const r = await run('wasixtest', ['signal']);
    expect(r.stdout).toBe('killed child: signal 15\n');
  });

  it('chdir / getcwd, and relative paths follow', async () => {
    const r = await run('wasixtest', ['cwd']);
    expect(r).toMatchObject({
      code: 0,
      stdout: 'cwd /workspace\ncwd /workspace/sub\nread inside sub\n',
    });
  });

  it('posix_spawn (proc_spawn3) finds the program on $PATH', async () => {
    const r = await run('wasixtest', ['spawn']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('argv0 wasitest argc 2 HOME=/home\nspawned: exit 0\n');
  });
});

describe.skipIf(!BASH || !COREUTILS)('WASIX from the Wasmer registry, unchanged', () => {
  it('bash: builtins, exec of coreutils, pipelines across workers, $(…), statuses', async () => {
    expect((await run('bash', ['-c', 'echo hi; echo $((6*7))'])).stdout).toBe('hi\n42\n');
    expect((await run('bash', ['-c', 'cat fruit.txt; echo "status $?"'])).stdout).toBe(
      'pear\napple\nfig\nstatus 0\n'
    );
    const pipe = await run('bash', ['-c', 'sort fruit.txt | head -n 2 | tr a-z A-Z']);
    expect(pipe).toMatchObject({ code: 0, stdout: 'APPLE\nFIG\n' });
    const subst = await run('bash', [
      '-c',
      'n=$(wc -l < fruit.txt); echo "lines $n" > out.txt; (cat out.txt; echo sub)',
    ]);
    expect(subst.stdout).toBe('lines 3\nsub\n');
    const st = await run('bash', [
      '-c',
      'false; echo a=$?; (exit 3); echo b=$?; sh -c "exit 4"; echo c=$?; true | false; echo d=$?',
    ]);
    expect(st.stdout).toBe('a=1\nb=3\nc=4\nd=1\n');
    expect((await run('bash', ['-c', 'yes | head -n 1; echo done'])).stdout).toBe('y\ndone\n');
  }, 120_000);
});

describe.skipIf(!PYTHON || !COREUTILS)('WASIX python (wasmer/python, stdlib on the VFS)', () => {
  it('runs, and subprocess forks and execs a child', async () => {
    const hello = await run('python', [
      '-c',
      'import sys, os, json; print(sys.version.split()[0], os.getcwd(), json.dumps({"n": 6*7}))',
    ]);
    expect(hello.stdout).toBe('3.12.0 /workspace {"n": 42}\n');
    const sub = await run('python', [
      '-c',
      'import subprocess; print(subprocess.run(["cat", "fruit.txt"], capture_output=True).stdout.decode().split())',
    ]);
    expect(sub.stderr).toBe('');
    expect(sub.stdout).toBe("['pear', 'apple', 'fig']\n");

    const piped = await run('python', [
      '-c',
      'import subprocess; print(subprocess.run(["tr", "a-z", "A-Z"], input=b"hi", capture_output=True).stdout)',
    ]);
    expect(piped).toMatchObject({ code: 0, stdout: "b'HI'\n", stderr: '' });

    const threaded = await run('python', [
      '-c',
      'import threading; out = []; ts = [threading.Thread(target=out.append, args=(i,)) for i in range(3)]; [t.start() for t in ts]; [t.join() for t in ts]; print(sorted(out))',
    ]);
    expect(threaded).toMatchObject({ code: 0, stdout: '[0, 1, 2]\n', stderr: '' });
  }, 120_000);
});
