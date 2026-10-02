/**
 * GnuPG in the wasm realm: `@ai-ecoverse/wasix-gnupg` (WASIX: gpg,
 * gpg-agent, gpgconf, gpg-connect-agent) next to the Emscripten GNU bash,
 * coreutils and `@ai-ecoverse/wasm-git`, as wasm-realm processes in worker
 * threads on a VirtualFS, against the production kernel host.
 *
 * Every `bash -c` is an invocation of its own (a job table of its own, as
 * the agent's bash tool runs them), on one loopback namespace (the owner's):
 * gpg starts gpg-agent detached on its first use, and later invocations
 * reach that agent through `$GNUPGHOME/S.gpg-agent`.
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
import { importedMemory } from '../../../src/kernel/wasm-realm/wasi/wasi-module.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { bundleProcessWorker, loadProgram, nodeWorker } from './helpers/node-wasm-process.js';

const MODULES = process.env.SLICC_WASM_MODULES;
const PACKAGES = ['wasm-bash', 'wasm-git', 'wasm-coreutils', 'wasix-gnupg'];
const READY =
  MODULES !== undefined &&
  PACKAGES.every((name) => existsSync(`${MODULES}/@ai-ecoverse/${name}/package.json`));

interface Command {
  program: WasmProgram;
  argv0: string;
}

interface Manifest {
  slicc: {
    abi?: string;
    commands: Record<string, { glue?: string; wasm: string; argv0?: string }>;
  };
}

let worker: { file: string; dispose(): void };
const commands = new Map<string, Command>();
let fs: VfsAdapter;
let nextPid = 7000;
/** The owner's loopback namespace: every invocation's. */
const net = new LoopbackNet();
/** Every process still running (the agent outlives its invocation): killed at the end. */
const live = new Map<number, (code: number) => void>();

async function wasiProgram(path: string): Promise<WasmProgram> {
  const bytes = readFileSync(path);
  const memory = importedMemory(bytes);
  return {
    abi: 'wasi',
    glue: '',
    module: await WebAssembly.compile(bytes),
    ...(memory ? { memory } : {}),
  };
}

beforeAll(async () => {
  if (!READY) return;
  worker = await bundleProcessWorker();
  const programs = new Map<string, Promise<WasmProgram>>();
  for (const name of PACKAGES) {
    const dir = `${MODULES}/@ai-ecoverse/${name}`;
    const manifest = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as Manifest;
    const wasi = manifest.slicc.abi === 'wasi';
    for (const [command, spec] of Object.entries(manifest.slicc.commands)) {
      const path = `${dir}/${wasi ? spec.wasm : spec.glue}`;
      if (!existsSync(path)) continue;
      if (!programs.has(path)) programs.set(path, wasi ? wasiProgram(path) : loadProgram(path));
      commands.set(command, {
        program: await (programs.get(path) as Promise<WasmProgram>),
        argv0: spec.argv0 ?? command,
      });
    }
  }
  const vfs = await VirtualFS.create({ dbName: `wasix-gnupg-${Math.random()}`, wipe: true });
  // Programs search $PATH for an executable file.
  await vfs.mkdir('/usr/bin', { recursive: true });
  for (const command of commands.keys()) {
    await vfs.writeFile(`/usr/bin/${command}`, '#!wasm\n');
    await vfs.chmod(`/usr/bin/${command}`, 0o755);
  }
  await vfs.mkdir('/home', { recursive: true });
  await vfs.mkdir('/tmp', { recursive: true });
  fs = new VfsAdapter(vfs);
}, 120_000);

afterAll(() => {
  for (const kill of live.values()) kill(137);
  worker?.dispose();
});

interface Shell {
  output(): string;
  stderr(): string;
  type(keys: string): void;
  until(pattern: RegExp): Promise<void>;
  exited: Promise<number>;
}

/** `bash -c script`, an invocation of its own: on a terminal, or on /dev/null and sinks. */
function bash(script: string, opts: { terminal?: boolean } = {}): Shell {
  let out = '';
  let err = '';
  const decoder = new TextDecoder();
  const jobs = new JobTable();
  let leader = 0;
  const tty: KernelTty = new KernelTty({ write: (b) => void (out += decoder.decode(b)) }, (sig) =>
    jobs.signalForeground(tty, leader, sig)
  );
  const start = (
    command: string,
    args: string[],
    fds: FdTable,
    at: { cwd: string; env: Record<string, string> },
    ppid?: number,
    fork?: ForkState
  ) => {
    const { program, argv0 } = commands.get(command) as Command;
    const pid = nextPid++;
    const handle = spawnWasmProcess({
      pid,
      program,
      argv0,
      args,
      env: at.env,
      cwd: fork?.cwd ?? at.cwd,
      fds,
      fs: fs as never,
      net,
      jobs,
      createWorker: () => nodeWorker(worker.file),
      onError: (message) => void (err += `[${command} ${pid}] ${message}\n`),
      spawner: spawnerOf(pid),
      forker: forkerOf(pid, command, at),
      ...(ppid !== undefined ? { ppid } : {}),
      ...(fork ? { fork } : {}),
    });
    const terminal = ppid === undefined && opts.terminal ? tty : undefined;
    jobs.add(pid, ppid, (sig) => handle.signal(sig), terminal);
    live.set(pid, (code) => handle.kill(code));
    void handle.exited.then(() => {
      jobs.remove(pid);
      live.delete(pid);
    });
    return { pid, exited: handle.exited, termsig: handle.termsig };
  };
  const spawnerOf =
    (ppid: number): ChildSpawner =>
    async (req, fds) => {
      const command = req.file.split('/').pop() ?? req.file;
      if (!commands.has(command))
        throw Object.assign(new Error(`ENOENT ${command}`), { code: 'ENOENT' });
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
  const env = { PATH: '/usr/bin', HOME: '/home', TERM: 'xterm-256color', USER: 'realm' };
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

/** Run `script` to its end; its output, stderr and status. */
async function run(script: string): Promise<{ code: number; out: string; err: string }> {
  const sh = bash(script);
  const code = await sh.exited;
  return { code, out: sh.output(), err: sh.stderr() };
}

describe.skipIf(!READY)('GnuPG in the wasm realm (real programs)', () => {
  it('reports its version', async () => {
    const r = await run('gpg --version');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^gpg \(GnuPG\) 2\.4\.\d+/);
  }, 60_000);

  it('makes a key, starting gpg-agent, which a later invocation reuses', async () => {
    const gen = await run(
      "gpg --batch --passphrase '' --quick-gen-key 'Realm Test <realm@slicc.test>' default default never"
    );
    expect(gen.err).toMatch(/revocation certificate stored/);
    expect(gen.code).toBe(0);
    const first = await run("gpg-connect-agent 'getinfo pid' /bye");
    const second = await run("gpg-connect-agent 'getinfo pid' /bye; gpg -K --with-colons");
    expect(first.code).toBe(0);
    const pid = /^D (\d+)$/m.exec(first.out)?.[1];
    expect(pid).toBeDefined();
    expect(second.out).toContain(`D ${pid}\n`);
    expect(second.out).toMatch(/^uid:.*Realm Test <realm@slicc\.test>/m);
  }, 180_000);

  it('signs and verifies, encrypts and decrypts', async () => {
    const r = await run(
      'echo "signed text" | gpg --clearsign > /tmp/msg.asc && gpg --verify /tmp/msg.asc && ' +
        'echo "secret text" | gpg --trust-model always -e -r realm@slicc.test -a > /tmp/enc.asc && ' +
        'gpg -q -d /tmp/enc.asc'
    );
    expect(r.err).toMatch(/Good signature from "Realm Test <realm@slicc\.test>"/);
    expect(r.code).toBe(0);
    expect(r.out).toBe('secret text\n');
  }, 180_000);
  it('signs and verifies git commits and tags through gpg.program', async () => {
    const r = await run(
      'mkdir -p /tmp/repo && cd /tmp/repo && git init -q -b main . && ' +
        'git config user.email realm@slicc.test && git config user.name "Realm Test" && ' +
        'git config gpg.program gpg && echo one > f && git add f && ' +
        'git commit -q -S -m signed && git verify-commit HEAD && ' +
        'git tag -s -m "signed tag" v1 && git verify-tag v1 && ' +
        'git log --show-signature -1 --format=%s'
    );
    expect(r.err).toMatch(/Good signature from "Realm Test <realm@slicc\.test>"/);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Good signature from "Realm Test <realm@slicc\.test>"[\s\S]*\nsigned\n$/);
  }, 180_000);
  it('asks for a protected key passphrase on /dev/tty under git, then the agent remembers it', async () => {
    const home = 'export GNUPGHOME=/home/gnupg-pw';
    const gen = await run(
      `${home} && mkdir -m 700 $GNUPGHOME && gpg --batch --pinentry-mode loopback --passphrase sekrit ` +
        "--quick-gen-key 'Locked Test <locked@slicc.test>' default default never && " +
        'mkdir -p /tmp/locked && cd /tmp/locked && git init -q -b main . && ' +
        'git config user.email locked@slicc.test && git config user.name "Locked Test" && ' +
        'git config commit.gpgsign true'
    );
    expect(gen.code).toBe(0);
    // No gpg.conf: loopback is the package's default (no pinentry program). git pipes
    // gpg's stdio, so the prompt and the answer go through the terminal.
    const first = bash(
      `${home} && cd /tmp/locked && echo 1 > f && git add f && git commit -q -m one; echo "first: $?"`,
      { terminal: true }
    );
    await first.until(/passphrase/i);
    first.type('sekrit\r');
    expect(await first.exited).toBe(0);
    expect(first.output()).toMatch(/first: 0\r\n$/);
    expect(first.output()).not.toContain('sekrit');
    const second = bash(
      `${home} && cd /tmp/locked && echo 2 > f && git commit -qam two; echo "second: $?"; ` +
        'git verify-commit HEAD && echo verified',
      { terminal: true }
    );
    expect(await second.exited).toBe(0);
    expect(second.output()).not.toMatch(/passphrase/i);
    expect(second.output()).toMatch(
      /second: 0\r\n[\s\S]*Good signature from "Locked Test[\s\S]*verified\r\n$/
    );
  }, 180_000);
});
