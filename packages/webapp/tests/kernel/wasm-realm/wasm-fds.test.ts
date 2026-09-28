/**
 * Descriptors across exec and /dev/fd with a real C program: `fdtest`
 * (`tests/fixtures/wasm-fds`, built with the SLICC toolchain and its
 * `slicc_spawn.c` shim) runs as wasm-realm processes in worker threads,
 * against the production kernel host, SAB bridge and runtime. Its children
 * are `fdtest` again, spawned through the kernel.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { bundleProcessWorker, loadProgram, runProgram } from './helpers/node-wasm-process.js';

const FIXTURE = new URL('../../fixtures/wasm-fds/fdtest', import.meta.url).pathname;

let worker: { file: string; dispose(): void };
let fdtest: WasmProgram;

beforeAll(async () => {
  worker = await bundleProcessWorker();
  fdtest = await loadProgram(FIXTURE);
}, 60_000);

afterAll(() => worker?.dispose());

/** Run fdtest to the end; its children are fdtest too. */
async function runFdtest(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = runProgram(worker.file, fdtest, args, new LoopbackNet(), 'fdtest');
  const code = await p.exited;
  return { code, stdout: p.stdout(), stderr: p.stderr() };
}

describe('wasm-realm descriptors (real C programs)', () => {
  it('tracks FD_CLOEXEC and hands a spawned child every other fd at its number', async () => {
    const run = await runFdtest(['inherit']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const [a, d, dupOfB, b, c, cloexecDup, dup3Fd] = [3, 9, 13, 5, 7, 20, 30];
    expect(run.stdout).toBe(
      [
        'F_GETFD pipe=0 pipe2=1 setfd=1 dup=0 dupfd_cloexec=1 dup3=1',
        'O_CLOEXEC in F_GETFL: no',
        `fd ${a} open`,
        `fd ${d} open`,
        `fd ${dupOfB} open`,
        `fd ${b} closed`,
        `fd ${c} closed`,
        `fd ${cloexecDup} closed`,
        `fd ${dup3Fd} closed`,
        `/dev/fd/${a}: through a`,
        // Two pipes: FIFOs, and not one file (diff <(a) <(b) compares them).
        'fifo yes, same file no',
        'probe exited 0',
        // posix_spawn file actions beyond fd 2: a dup2 to 40, a close.
        'fd 40 open',
        `fd ${d} closed`,
        '/dev/fd/40: through e',
        'probe exited 0',
        '',
      ].join('\n')
    );
  }, 30_000);

  it('honors SOCK_CLOEXEC on socket, socketpair and accept4, and hands a child the rest', async () => {
    const r = await runFdtest(['sockets']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const [pair, listener, cloexecPair, conn] = [4, 3, 6, 9];
    expect(r.stdout).toBe(
      [
        'F_GETFD socket=1 client=0 pair=0 cloexec_pair=1 accept4=1',
        `fd ${pair} open`,
        `fd ${listener} closed`,
        `fd ${cloexecPair} closed`,
        `fd ${conn} closed`,
        `/dev/fd/${pair}: through a socket`,
        'probe exited 0',
        '',
      ].join('\n')
    );
  }, 30_000);

  it('opens /dev/fd/N as a dup of its own fd N', async () => {
    const run = await runFdtest(['devfd']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      [
        'new fd yes, fifo yes, same file yes, read piped',
        // /proc/self/fd/N shares the offset; O_CLOEXEC on the open sets FD_CLOEXEC.
        'file hello| world, F_GETFD 0 1',
        'closed fd: EBADF',
        // /dev/stdout is fd 1 (a pipe here), not the terminal.
        'via /dev/stdout',
        '',
      ].join('\n')
    );
  }, 30_000);
});
