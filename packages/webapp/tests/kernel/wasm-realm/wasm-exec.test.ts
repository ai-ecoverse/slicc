/**
 * Fork, exec, ownership and the controlling terminal with a real C program:
 * `proctest` (`tests/fixtures/wasm-exec`, built with the SLICC toolchain's
 * fork, exec, spawn, jobs and libc shims) runs as wasm-realm processes in
 * worker threads, against the production kernel host, SAB bridge and
 * runtime. Its children, forked or spawned, are proctest again.
 *
 * These are the realm's parts of running git: files owned by the user git
 * runs as, a parent that learns of its child's exec through a close-on-exec
 * pipe (start_command), atexit handlers after a fork (waiting for the pager),
 * and a pager's keys from /dev/tty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import {
  bundleProcessWorker,
  loadProgram,
  type RunOptions,
  runProgram,
} from './helpers/node-wasm-process.js';

const FIXTURE = new URL('../../fixtures/wasm-exec/proctest', import.meta.url).pathname;

let worker: { file: string; dispose(): void };
let proctest: WasmProgram;

beforeAll(async () => {
  worker = await bundleProcessWorker();
  proctest = await loadProgram(FIXTURE);
}, 60_000);

afterAll(() => worker?.dispose());

async function run(
  args: string[],
  files: Record<string, string> = {},
  options: RunOptions = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = runProgram(
    worker.file,
    proctest,
    args,
    new LoopbackNet(),
    'proctest',
    {},
    files,
    undefined,
    options
  );
  const code = await p.exited;
  return { code, stdout: p.stdout(), stderr: p.stderr() };
}

describe('wasm-realm fork, exec and terminal (real C programs)', () => {
  it('stats every file as owned by the user programs run as', async () => {
    const r = await run(['owner', '/data/file', '/data', '/tmp', '/dev/null'], {
      '/data/file': 'x',
    });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        'euid 1000 egid 1000',
        // A VFS file and directory, the program's own /tmp, a device.
        '/data/file 1000 1000',
        '/data 1000 1000',
        '/tmp 1000 1000',
        '/dev/null 1000 1000',
        'pipe 1000 1000',
        'socket 1000 1000',
        '/dev/fd/0 1000 1000',
        '',
      ].join('\n')
    );
  }, 30_000);

  it('closes the close-on-exec pipe when a forked child execs, not when the program ends', async () => {
    const r = await run(['notify']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    // EOF comes with the exec: the parent goes on while the program sleeps.
    expect(r.stdout).toBe('exec seen: EOF\nslept\nchild exited 0\n');
  }, 30_000);

  it('runs atexit handlers and flushes stdio when a process that forked exits', async () => {
    const r = await run(['atexit']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('buffered atexit ran\n');
  }, 30_000);

  it("opens the session's controlling terminal as /dev/tty, off its stdio too", async () => {
    const r = await run(['detached'], {}, { terminal: true });
    expect(r.code).toBe(0);
    // The child's stdio is /dev/null: its session's terminal is still /dev/tty.
    // A new session (setsid) has none.
    expect(r.stdout.replaceAll('\r\n', '\n')).toBe(
      'same session:\non the terminal, isatty 1\nnew session:\n/dev/tty: ENXIO\n'
    );
  }, 30_000);

  it('answers ENXIO for /dev/tty without a terminal', async () => {
    const r = await run(['tty']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('/dev/tty: ENXIO\n');
  }, 30_000);
});
