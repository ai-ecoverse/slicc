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
      exists: async (p: string) => Object.keys(files).some((f) => f === p || f.startsWith(`${p}/`)),
      readdir: async (p: string) => {
        const names = Object.keys(files)
          .filter((f) => f.startsWith(`${p}/`))
          .map((f) => f.slice(p.length + 1).split('/')[0]);
        if (names.length === 0) throw new Error(`ENOENT: no such directory, '${p}'`);
        return [...new Set(names)];
      },
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

  it('registers the process in the process table and ends it on a signal', async () => {
    compile.mockResolvedValue({});
    let settle!: (code: number) => void;
    const kill = vi.fn((code: number) => settle(code));
    // An uncaught SIGTERM's default action: the kernel ends the process with 128 + 15.
    const signal = vi.fn((sig: number) => settle(128 + sig));
    spawn.mockImplementation((opts) => ({
      pid: opts.pid,
      exited: new Promise<number>((resolve) => (settle = resolve)),
      kill,
      signal,
    }));
    let listener: ((proc: { pid: number }, sig: string) => void) | undefined;
    const pm = {
      spawn: vi.fn(() => ({ pid: 777 })),
      exit: vi.fn(),
      onSignal: vi.fn((l: typeof listener) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      }),
    };
    const config = {
      processManager: pm,
      owner: { kind: 'cone' },
      getParentPid: () => 42,
    } as unknown as NonNullable<Parameters<typeof runWasmCommand>[2]>['processConfig'];
    const files = { '/w/loop.js': 'G', '/w/loop.wasm': 'W' };
    const running = runWasmCommand(['loop.js', 'x'], ctx(files), { processConfig: config });
    await vi.waitFor(() => expect(listener).toBeDefined());
    expect(pm.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'wasm', argv: ['loop', 'x'], cwd: '/w', ppid: 42 })
    );
    expect(spawn.mock.calls[0][0].pid).toBe(777);
    listener?.({ pid: 1 }, 'SIGTERM'); // another process: ignored
    expect(signal).not.toHaveBeenCalled();
    listener?.({ pid: 777 }, 'SIGTERM');
    expect(signal).toHaveBeenCalledWith(15);
    expect((await running).exitCode).toBe(143);
    expect(pm.exit).toHaveBeenCalledWith(777, 143);
    expect(listener).toBeUndefined(); // unsubscribed
  });

  it('stops a runaway producer at the output limit', async () => {
    compile.mockResolvedValue({});
    const kill = vi.fn();
    spawn.mockImplementation((opts) => {
      let settle!: (code: number) => void;
      const exited = new Promise<number>((resolve) => (settle = resolve));
      kill.mockImplementation((code: number) => settle(code));
      void (async () => {
        for (let i = 0; i < 10; i++) await opts.fds.get(1).file.write(bytes('y\n'.repeat(4)));
      })();
      return { pid: opts.pid, exited, kill };
    });
    const c = { ...ctx({ '/w/yes.js': 'G', '/w/yes.wasm': 'W' }), limits: { maxOutputSize: 20 } };
    const r = await runWasmCommand(['yes.js'], c as unknown as CommandContext);
    expect(kill).toHaveBeenCalledWith(1);
    expect(r.exitCode).toBe(1);
    expect(r.stdout.length).toBeLessThanOrEqual(20);
    expect(r.stderr).toMatch(/output exceeded 20 bytes/);
  });

  it('never starts a program canceled while it was read or compiled', async () => {
    const controller = new AbortController();
    compile.mockImplementation(async () => {
      controller.abort(); // e.g. `timeout` fired during the compile
      return {};
    });
    const c = { ...ctx({ '/w/p.js': 'G', '/w/p.wasm': 'W' }), signal: controller.signal };
    const r = await runWasmCommand(['p.js'], c as unknown as CommandContext);
    expect(r.exitCode).toBe(130);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('explains a page without SharedArrayBuffer (not cross-origin isolated)', async () => {
    vi.stubGlobal('SharedArrayBuffer', undefined);
    try {
      const r = await runWasmCommand(['p.js'], ctx({ '/w/p.js': 'G', '/w/p.wasm': 'W' }));
      expect(r.exitCode).toBe(126);
      expect(r.stderr).toMatch(/needs SharedArrayBuffer/);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('installed programs', () => {
    const pkg = '/shared/lib/node_modules/@ai-ecoverse/wasm-gnu';
    const installed = {
      [`${pkg}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-gnu',
        slicc: {
          commands: {
            tac: { glue: 'bin/coreutils', wasm: 'lib/coreutils.wasm', argv0: 'tac' },
            sed: { glue: 'bin/sed', wasm: 'bin/sed.wasm' },
          },
        },
      }),
      [`${pkg}/bin/coreutils`]: 'CORE',
      [`${pkg}/lib/coreutils.wasm`]: 'W',
      [`${pkg}/bin/sed`]: 'SED',
      [`${pkg}/bin/sed.wasm`]: 'W',
    };

    beforeEach(() => {
      compile.mockResolvedValue({});
      spawn.mockImplementation((opts) => ({
        pid: opts.pid,
        exited: Promise.resolve(0),
        kill: vi.fn(),
      }));
    });

    it('lists them with --list', async () => {
      const r = await runWasmCommand(['--list'], ctx(installed));
      expect(r).toEqual({
        stdout: 'sed  @ai-ecoverse/wasm-gnu\ntac  @ai-ecoverse/wasm-gnu\n',
        stderr: '',
        exitCode: 0,
      });
    });

    it('runs a bare name with its glue, module and argv0', async () => {
      await runWasmCommand(['tac', '-s', 'x'], ctx(installed));
      const opts = spawn.mock.calls[0][0];
      expect(opts.program.glue).toBe('CORE');
      expect(opts.argv0).toBe('tac');
      expect(opts.args).toEqual(['-s', 'x']);
      expect(compile.mock.calls[0][1]).toBe(`${pkg}/lib/coreutils.wasm`);
    });

    it('prefers a file of that name in the working directory', async () => {
      await runWasmCommand(['sed'], ctx({ ...installed, '/w/sed': 'LOCAL', '/w/sed.wasm': 'W' }));
      expect(spawn.mock.calls[0][0].program.glue).toBe('LOCAL');
    });

    it('takes the module from --module', async () => {
      const files = { '/w/g.js': 'G', '/w/elsewhere.wasm': 'W' };
      await runWasmCommand(['--module', 'elsewhere.wasm', '--argv0', 'z', 'g.js'], ctx(files));
      expect(compile.mock.calls[0][1]).toBe('/w/elsewhere.wasm');
      expect(spawn.mock.calls[0][0].argv0).toBe('z');
    });

    it('rejects an option without a value', async () => {
      expect((await runWasmCommand(['--module'], ctx({}))).exitCode).toBe(2);
    });
  });

  describe('-t (the panel terminal)', () => {
    it('runs on a TTY over the leased terminal and gives it back', async () => {
      compile.mockResolvedValue({});
      const screen: string[] = [];
      const release = vi.fn();
      let input!: (b: Uint8Array) => void;
      const lease = {
        cols: 100,
        rows: 30,
        write: (b: Uint8Array) => void screen.push(new TextDecoder().decode(b)),
        onInput: (l: (b: Uint8Array) => void) => void (input = l),
        onResize: vi.fn(),
        release,
      };
      spawn.mockImplementation((opts) => {
        expect(opts.env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor' });
        const tty = opts.fds.get(0).file.tty;
        expect(opts.fds.get(1).file.tty).toBe(tty);
        expect(opts.fds.get(2).file.tty).toBe(tty);
        expect(tty.winsize()).toEqual([30, 100]);
        void opts.fds.get(1).file.write(bytes('hello\n'));
        input(bytes('typed\r'));
        return {
          pid: opts.pid,
          exited: opts.fds
            .get(0)
            .file.read(64)
            .then(() => 0),
          kill: vi.fn(),
          signal: vi.fn(),
        };
      });
      const r = await runWasmCommand(['-t', 'sh.js'], ctx({ '/w/sh.js': 'G', '/w/sh.wasm': 'W' }), {
        terminal: { lease: () => lease },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(''); // it went to the screen
      expect(screen.join('')).toBe('hello\r\ntyped\r\n');
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('keeps a real TERM the shell exports, and leaves piped programs’ env alone', async () => {
      compile.mockResolvedValue({});
      const envs: Record<string, string>[] = [];
      spawn.mockImplementation((opts) => {
        envs.push(opts.env);
        return { pid: opts.pid, exited: Promise.resolve(0), kill: vi.fn(), signal: vi.fn() };
      });
      const lease = {
        cols: 80,
        rows: 24,
        write: () => {},
        onInput: () => {},
        onResize: () => {},
        release: () => {},
      };
      const files = { '/w/sh.js': 'G', '/w/sh.wasm': 'W' };
      const screen = ctx(files);
      screen.exportedEnv = { TERM: 'screen-256color' };
      await runWasmCommand(['-t', 'sh.js'], screen, { terminal: { lease: () => lease } });
      await runWasmCommand(['sh.js'], ctx(files));
      expect(envs[0]).toEqual({ TERM: 'screen-256color' });
      expect(envs[1]).toEqual({ A: '1' });
    });

    it('fails without a terminal to lease', async () => {
      const r = await runWasmCommand(['-t', 'sh.js'], ctx({ '/w/sh.js': 'G', '/w/sh.wasm': 'W' }), {
        terminal: { lease: () => null },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/-t: no terminal/);
      const none = await runWasmCommand(
        ['-t', 'sh.js'],
        ctx({ '/w/sh.js': 'G', '/w/sh.wasm': 'W' })
      );
      expect(none.exitCode).toBe(1);
    });
  });
});
