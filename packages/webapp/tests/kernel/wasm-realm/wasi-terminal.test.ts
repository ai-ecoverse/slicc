import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { FdTable } from '../../../src/kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess, type WasmProcessHandle } from '../../../src/kernel/wasm-realm/host.js';
import { JobTable } from '../../../src/kernel/wasm-realm/jobs.js';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { SIG } from '../../../src/kernel/wasm-realm/signals.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { KernelTty } from '../../../src/kernel/wasm-realm/tty.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { bundleProcessWorker, nodeWorker } from './helpers/node-wasm-process.js';

const FIXTURE = new URL('../../fixtures/wasm-wasi/wasitest.wasm', import.meta.url).pathname;

let worker: { file: string; dispose(): void };
let fs: VfsAdapter;
let program: WasmProgram;
let nextPid = 37000;

beforeAll(async () => {
  worker = await bundleProcessWorker();
  const vfs = await VirtualFS.create({ dbName: `wasi-tty-${Math.random()}`, wipe: true });
  await vfs.mkdir('/w', { recursive: true });
  fs = new VfsAdapter(vfs);
  program = { abi: 'wasi', glue: '', module: await WebAssembly.compile(readFileSync(FIXTURE)) };
}, 120_000);

afterAll(() => worker?.dispose());

function onTerminal(args: string[]) {
  let screen = '';
  const jobs = new JobTable();
  const pid = nextPid++;
  const tty: KernelTty = new KernelTty(
    { write: (b) => void (screen += new TextDecoder().decode(b)) },
    (sig) => jobs.signalForeground(tty, pid, sig)
  );
  const fds = new FdTable();
  const file = tty.file();
  fds.installAt(0, file);
  fds.installAt(1, file.retain());
  fds.installAt(2, file.retain());
  const handle: WasmProcessHandle = spawnWasmProcess({
    pid,
    program,
    argv0: 'wasitest',
    args,
    env: {},
    cwd: '/w',
    fds,
    fs: fs as never,
    net: new LoopbackNet(),
    jobs,
    createWorker: () => nodeWorker(worker.file),
  });
  jobs.add(pid, undefined, (sig) => handle.signal(sig), tty);
  const type = (keys: string) => tty.receive(new TextEncoder().encode(keys));
  return { handle, type, screen: () => screen };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
  if (!done()) throw new Error('timed out');
}

describe('a WASI program on a terminal', () => {
  it('sees a terminal on its stdio (isatty; no seeking it)', async () => {
    const t = onTerminal(['tty']);
    expect(await t.handle.exited).toBe(0);
    expect(t.screen()).toBe('isatty 0=1 1=1\r\nlseek stdin ESPIPE\r\n');
  });

  it('reads lines as the line discipline hands them over (echo, erase), ^D ends its input', async () => {
    const t = onTerminal(['upper']);
    t.type('abx\x7fc\n');
    await until(() => t.screen().includes('ABC'));
    t.type('\x04');
    expect(await t.handle.exited).toBe(0);

    expect(t.screen()).toBe('abx\b \bc\r\nABC\r\n');
  });

  it('^C ends it with SIGINT (130)', async () => {
    const t = onTerminal(['upper']);
    t.type('one\n');
    await until(() => t.screen().includes('ONE'));
    t.type('\x03');
    expect(await t.handle.exited).toBe(130);
    expect(t.handle.termsig()).toBe(SIG.INT);
  });

  it('^Z stops it (its read waits), SIGCONT goes on', async () => {
    const t = onTerminal(['upper']);
    const states: string[] = [];
    t.handle.onState((state) => states.push(state));
    t.type('\x1a');
    await until(() => states.includes('stopped'));
    t.type('late\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(t.screen()).not.toContain('LATE');
    t.handle.signal(SIG.CONT);
    await until(() => t.screen().includes('LATE'));
    t.type('\x04');
    expect(await t.handle.exited).toBe(0);
    expect(states).toEqual(['stopped', 'continued']);
  });
});
