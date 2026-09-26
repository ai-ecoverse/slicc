import type { CommandContext } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/kernel/wasm-realm/host.js', () => ({ spawnWasmProcess: spawn }));
const compile = vi.hoisted(() => vi.fn());
vi.mock('../../../src/kernel/realm/wasm-compiler.js', () => ({ compileWasmFromVfs: compile }));

import { runWasmCommand } from '../../../src/shell/supplemental-commands/wasm/run.js';

const bytes = (s: string) => new TextEncoder().encode(s);

function ctx(files: Record<string, string>, stdin = ''): CommandContext {
  return {
    cwd: '/w',
    env: new Map([['A', '1']]),
    exportedEnv: { A: '1' },
    stdin,
    fs: {
      resolvePath: (cwd: string, p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`),
      readFile: async (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: no such file, '${p}'`);
        return files[p];
      },
      readFileBuffer: async (p: string) => bytes(files[p] ?? ''),
      stat: async (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: no such file, '${p}'`);
        return { size: files[p].length, mtime: new Date(0) };
      },
    },
  } as unknown as CommandContext;
}

describe('wasm command', () => {
  beforeEach(() => {
    spawn.mockReset();
    compile.mockReset();
  });

  it('prints usage for --help, and exits 2 without a program', async () => {
    expect((await runWasmCommand(['--help'], ctx({}))).exitCode).toBe(0);
    const r = await runWasmCommand([], ctx({}));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/usage: wasm/);
  });

  it('exits 127 when the program or its module is missing', async () => {
    const r = await runWasmCommand(['nope.js'], ctx({}));
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toMatch(/^wasm: nope\.js: .*ENOENT/);
    const r2 = await runWasmCommand(['tool'], ctx({ '/w/tool': 'glue' }));
    expect(r2.exitCode).toBe(127);
    expect(r2.stderr).toMatch(/tool\.wasm/);
  });

  it('spawns the program with argv0, args, env and cwd, and returns its output as bytes', async () => {
    compile.mockResolvedValue({ compiled: true });
    spawn.mockImplementation((opts) => {
      // Write through the process's fd 1 and 2 as the worker would.
      void opts.fds.get(1).file.write(new Uint8Array([0xff, 0x00, 0x41]));
      void opts.fds.get(2).file.write(bytes('warn\n'));
      return { pid: opts.pid, exited: Promise.resolve(4), kill: vi.fn() };
    });
    const files = { '/w/bin/coreutils.js': 'GLUE', '/w/bin/coreutils.wasm': 'WASM' };
    const r = await runWasmCommand(['--argv0', 'sort', 'bin/coreutils.js', '-r'], ctx(files));
    const opts = spawn.mock.calls[0][0];
    expect(opts.program).toEqual({ glue: 'GLUE', module: { compiled: true } });
    expect(opts.argv0).toBe('sort');
    expect(opts.args).toEqual(['-r']);
    expect(opts.env).toEqual({ A: '1' });
    expect(opts.cwd).toBe('/w');
    expect(compile.mock.calls[0][1]).toBe('/w/bin/coreutils.wasm');
    expect(r).toEqual({ stdout: '\xff\x00A', stderr: 'warn\n', exitCode: 4, stdoutKind: 'bytes' });
  });

  it("defaults argv0 to the program's base name and feeds stdin to fd 0", async () => {
    compile.mockResolvedValue({});
    let fed = '';
    spawn.mockImplementation(async (opts) => ({
      pid: opts.pid,
      exited: opts.fds
        .get(0)
        .file.read(64)
        .then((b: Uint8Array) => {
          fed = new TextDecoder().decode(b);
          return 0;
        }),
      kill: vi.fn(),
    }));
    const files = { '/w/sed.js': 'G', '/w/sed.wasm': 'W' };
    await runWasmCommand(['sed.js'], ctx(files, 'piped in'));
    expect(spawn.mock.calls[0][0].argv0).toBe('sed');
    expect(fed).toBe('piped in');
  });

  it('reuses the compiled module for an unchanged program', async () => {
    compile.mockResolvedValue({});
    spawn.mockImplementation((opts) => ({
      pid: opts.pid,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    }));
    const files = { '/w/cache.js': 'G', '/w/cache.wasm': 'W' };
    await runWasmCommand(['cache.js'], ctx(files));
    await runWasmCommand(['cache.js'], ctx(files));
    expect(compile).toHaveBeenCalledTimes(1);
  });
});
