/**
 * Native git in the wasm realm: the published `@ai-ecoverse/wasm-git`, GNU
 * bash, less and coreutils as wasm-realm processes in worker threads, on a
 * VirtualFS, against the production kernel host, SAB bridge and runtime.
 * Children resolve by name through the packages' `slicc.commands`, as the
 * `wasm` command resolves them.
 *
 * - git trusts a repository the realm user made (ownership);
 * - `git log` on a terminal pages through less, and `q` returns to the shell
 *   (exec closes the close-on-exec descriptors; atexit runs after a fork);
 * - `git ls-remote http://… | head` ends when head does, through the
 *   `git remote-http` helper chain, against a TS smart-HTTP listener;
 * - push, clone (by path and file://) and fetch against a local bare
 *   repository: upload-pack / receive-pack run through `sh -c`, and
 *   index-pack's fsync must not suspend the (Asyncify) process;
 * - fetch into a clone that checked nothing out: git (NO_MMAP) reads the
 *   pack with pread, which must read at its offset, not the shared one.
 *
 * The packages are not fixtures: point SLICC_WASM_MODULES at a
 * `node_modules` that holds them to run this.
 */
import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import type { ChildForker, ChildSpawner } from '../../../src/kernel/wasm-realm/children.js';
import { FdTable, nullFile, sinkFile } from '../../../src/kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess } from '../../../src/kernel/wasm-realm/host.js';
import { JobTable } from '../../../src/kernel/wasm-realm/jobs.js';
import type { ForkState, WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { KernelTty } from '../../../src/kernel/wasm-realm/tty.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { bundleProcessWorker, loadProgram, nodeWorker } from './helpers/node-wasm-process.js';

const MODULES = process.env.SLICC_WASM_MODULES;
const PACKAGES = ['wasm-bash', 'wasm-git', 'wasm-less', 'wasm-coreutils'];
const EXEC_PATH = '/usr/libexec/git-core';

interface Command {
  program: WasmProgram;
  argv0: string;
  env: Record<string, string>;
}

let worker: { file: string; dispose(): void };
const commands = new Map<string, Command>();
let fs: VfsAdapter;
let nextPid = 9000;

beforeAll(async () => {
  if (!MODULES) return;
  worker = await bundleProcessWorker();
  const programs = new Map<string, Promise<WasmProgram>>();
  for (const name of PACKAGES) {
    const dir = `${MODULES}/@ai-ecoverse/${name}`;
    const manifest = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as {
      slicc: { commands: Record<string, { glue: string; argv0?: string }> };
    };
    for (const [command, spec] of Object.entries(manifest.slicc.commands)) {
      const glue = `${dir}/${spec.glue}`;
      if (!existsSync(glue)) continue; // declared, not shipped (wasm-git 2.55.0-2's upload-pack)
      if (!programs.has(glue)) programs.set(glue, loadProgram(glue));
      const env: Record<string, string> = name === 'wasm-git' ? { GIT_EXEC_PATH: EXEC_PATH } : {};
      commands.set(command, {
        program: await (programs.get(glue) as Promise<WasmProgram>),
        argv0: spec.argv0 ?? command,
        env,
      });
    }
  }
  const sh = commands.get('bash') as Command;
  commands.set('sh', { ...sh, argv0: 'sh' });
  const vfs = await VirtualFS.create({ dbName: `wasm-git-${Math.random()}`, wipe: true });
  // Programs search $PATH (and git its exec path) for an executable file.
  for (const dir of ['/usr/bin', EXEC_PATH]) {
    await vfs.mkdir(dir, { recursive: true });
    for (const command of commands.keys()) {
      await vfs.writeFile(`${dir}/${command}`, '#!wasm\n');
      await vfs.chmod(`${dir}/${command}`, 0o755);
    }
  }
  await vfs.mkdir('/home', { recursive: true });
  await vfs.mkdir('/tmp', { recursive: true });
  fs = new VfsAdapter(vfs);
}, 120_000);

afterAll(() => worker?.dispose());

interface Shell {
  /** What reached the terminal, or stdout. */
  output(): string;
  stderr(): string;
  type(keys: string): void;
  until(pattern: RegExp): Promise<void>;
  exited: Promise<number>;
}

/** `bash -c script`: on a terminal (a session it controls), or on /dev/null and sinks. */
function bash(script: string, opts: { terminal?: boolean; net?: LoopbackNet } = {}): Shell {
  let out = '';
  let err = '';
  const decoder = new TextDecoder();
  const jobs = new JobTable();
  let leader = 0;
  const tty: KernelTty = new KernelTty({ write: (b) => void (out += decoder.decode(b)) }, (sig) =>
    jobs.signalForeground(tty, leader, sig)
  );
  const net = opts.net ?? new LoopbackNet();
  const start = (
    command: string,
    args: string[],
    fds: FdTable,
    at: { cwd: string; env: Record<string, string> },
    ppid?: number,
    fork?: ForkState
  ) => {
    const { program, argv0, env } = commands.get(command) as Command;
    const pid = nextPid++;
    const handle = spawnWasmProcess({
      pid,
      program,
      argv0,
      args,
      env: { ...env, ...at.env },
      cwd: fork?.cwd ?? at.cwd,
      fds,
      fs: fs as never,
      net,
      jobs,
      createWorker: () => nodeWorker(worker.file),
      onError: (message) => void (err += message),
      spawner: spawnerOf(pid),
      forker: forkerOf(pid, command, at),
      ...(fork ? { fork } : {}),
    });
    const terminal = ppid === undefined && opts.terminal ? tty : undefined;
    jobs.add(pid, ppid, (sig) => handle.signal(sig), terminal);
    void handle.exited.then(() => jobs.remove(pid));
    return { pid, exited: handle.exited, termsig: handle.termsig };
  };
  const spawnerOf =
    (ppid: number): ChildSpawner =>
    async (req, fds) => {
      const command = req.file.split('/').pop() ?? req.file;
      if (!commands.has(command)) throw new Error(`no command ${command}`);
      return start(command, req.argv.slice(1), fds, { cwd: req.cwd, env: req.env }, ppid);
    };
  const forkerOf =
    (
      ppid: number,
      command: string,
      at: { cwd: string; env: Record<string, string> }
    ): ChildForker =>
    async (state, fds) =>
      start(command, [], fds, at, ppid, state);
  const fds = new FdTable();
  if (opts.terminal) {
    const file = tty.file();
    fds.installAt(0, file);
    fds.installAt(1, file.retain());
    fds.installAt(2, file.retain());
  } else {
    fds.installAt(0, nullFile());
    fds.installAt(
      1,
      sinkFile((b) => void (out += decoder.decode(b)))
    );
    fds.installAt(
      2,
      sinkFile((b) => void (err += decoder.decode(b)))
    );
  }
  const env = { PATH: '/usr/bin', HOME: '/home', TERM: 'xterm-256color' };
  const shell = start('bash', ['-c', script], fds, { cwd: '/home', env });
  leader = shell.pid;
  return {
    output: () => out,
    stderr: () => err,
    type: (keys) => tty.receive(new TextEncoder().encode(keys)),
    async until(pattern) {
      while (!pattern.test(out)) await new Promise((resolve) => setTimeout(resolve, 20));
    },
    exited: shell.exited,
  };
}

const REPO =
  'mkdir -p /tmp/repo && cd /tmp/repo && git init -q -b main . && ' +
  'git config user.email realm@slicc && git config user.name Realm && ' +
  'for i in 1 2 3 4 5; do echo $i > f$i && git add f$i && git commit -qm "commit $i"; done';

describe.skipIf(!MODULES)('native git in the wasm realm (real programs)', () => {
  it('trusts a repository the realm user made', async () => {
    const sh = bash(`${REPO} && stat -c '%u %g' . && git log --oneline | cat`);
    expect(await sh.exited).toBe(0);
    expect(sh.stderr()).not.toMatch(/dubious ownership/);
    expect(sh.output()).toMatch(/^1000 1000\n([0-9a-f]+ commit \d\n){5}$/);
  }, 60_000);

  it('pushes to, clones and fetches from a local bare repository (index-pack fsyncs)', async () => {
    const sh = bash(
      'set -e; rm -rf /tmp/g && mkdir -p /tmp/g && cd /tmp/g && git init -q --bare -b main repo.git && ' +
        'git init -q -b main w && cd w && git config user.email realm@slicc && ' +
        'git config user.name Realm && echo one > a.txt && git add a.txt && git commit -qm one && ' +
        'git remote add origin /tmp/g/repo.git && git push -q origin main && cd /tmp/g && ' +
        'git clone -q /tmp/g/repo.git c1 && git clone -q file:///tmp/g/repo.git c2 && ' +
        'cd c1 && git config user.email realm@slicc && git config user.name Realm && ' +
        'echo two >> a.txt && git commit -qam two && git push -q origin main && ' +
        'cd /tmp/g/c2 && git fetch -q origin && ' +
        'echo "c1=$(cat /tmp/g/c1/a.txt | tr "\\n" ,) c2=$(cat /tmp/g/c2/a.txt)" && ' +
        'echo "bare=$(git --git-dir=/tmp/g/repo.git rev-list --count main)" && ' +
        'echo "fetched=$(git rev-list --count origin/main)"'
    );
    expect(await sh.exited, sh.stderr()).toBe(0);
    expect(sh.output()).toBe('c1=one,two, c2=one\nbare=2\nfetched=2\n');
  }, 120_000);

  it('fetches into a clone whose remote HEAD named no branch (git reads packs with pread)', async () => {
    const sh = bash(
      'rm -rf /tmp/h && mkdir -p /tmp/h && cd /tmp/h && git init -q --bare repo.git && ' +
        'git init -q -b main w && cd w && git config user.email realm@slicc && ' +
        'git config user.name Realm && echo one > a.txt && git add a.txt && git commit -qm one && ' +
        'git remote add origin /tmp/h/repo.git && git push -q origin main && cd /tmp/h && ' +
        'git clone -q file:///tmp/h/repo.git c && cd c && git fetch -q origin && ' +
        'echo "fetched=$(git rev-list --count origin/main)"'
    );
    expect(await sh.exited, sh.stderr()).toBe(0);
    expect(sh.output()).toBe('fetched=1\n');
  }, 120_000);

  it('pages `git log` through less on the terminal; q returns to the shell', async () => {
    const sh = bash('cd /tmp/repo && git log; echo "after git: $?"', { terminal: true });
    await sh.until(/commit 5/);
    expect(sh.output()).not.toMatch(/after git/); // git waits for its pager
    sh.type('q');
    expect(await sh.exited).toBe(0);
    expect(sh.output()).toMatch(/after git: 0\r\n$/);
  }, 60_000);

  it('ends `git ls-remote | head` through the remote-http helper when head exits', async () => {
    const net = new LoopbackNet();
    const listener = net.listen({ family: 'inet', host: '127.0.0.1', port: 8080 });
    const encoder = new TextEncoder();
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
    const oid = '0123456789abcdef0123456789abcdef01234567';
    // More refs than a pipe holds: git is still writing when head exits.
    let body = `${pkt('# service=git-upload-pack\n')}0000${pkt(`${oid} HEAD\0ofs-delta\n`)}`;
    for (let i = 0; i < 3000; i++) body += pkt(`${oid} refs/tags/v${i}\n`);
    const advertisement = encoder.encode(`${body}0000`);
    void (async () => {
      for (;;) {
        const conn = await listener.accept().catch(() => undefined);
        if (!conn) return;
        let request = '';
        while (!request.includes('\r\n\r\n')) {
          const chunk = await conn.read(4096);
          if (chunk.length === 0) break;
          request += new TextDecoder().decode(chunk);
        }
        const head =
          'HTTP/1.1 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\n' +
          `Content-Length: ${advertisement.length}\r\nConnection: close\r\n\r\n`;
        await conn.write(encoder.encode(head)).catch(() => 0);
        await conn.write(advertisement).catch(() => 0);
        conn.close();
      }
    })();
    try {
      const sh = bash(
        'git ls-remote http://127.0.0.1:8080/r.git | head -3; echo "status ${PIPESTATUS[*]}"',
        { net }
      );
      expect(await sh.exited).toBe(0);
      expect(sh.output()).toBe(
        `${oid}\tHEAD\n${oid}\trefs/tags/v0\n${oid}\trefs/tags/v1\nstatus 141 0\n`
      );
    } finally {
      listener.close();
    }
  }, 60_000);
});
