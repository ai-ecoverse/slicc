import type { CommandContext } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/kernel/wasm-realm/host.js', () => ({ spawnWasmProcess: spawn }));
vi.mock('../../../../src/kernel/realm/wasm-compiler.js', () => ({
  compileWasmFromVfs: async () => ({}),
}));

import type { ChildSpawner } from '../../../../src/kernel/wasm-realm/children.js';
import { bytesSource, FdTable, sinkFile } from '../../../../src/kernel/wasm-realm/fd-table.js';
import { KernelTty } from '../../../../src/kernel/wasm-realm/tty.js';
import { WasmSession } from '../../../../src/shell/supplemental-commands/wasm/launch.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const PKG = '/shared/lib/node_modules/@ai-ecoverse/wasm-gnu';

function ctx(files: Record<string, string>, exec?: CommandContext['exec']): CommandContext {
  const has = (p: string) => Object.keys(files).some((f) => f === p || f.startsWith(`${p}/`));
  return {
    cwd: '/w',
    env: new Map(),
    stdin: '',
    exec,
    fs: {
      resolvePath: (cwd: string, p: string) => (p.startsWith('/') ? p : `${cwd}/${p}`),
      exists: async (p: string) => has(p),
      readdir: async (p: string) => [
        ...new Set(
          Object.keys(files)
            .filter((f) => f.startsWith(`${p}/`))
            .map((f) => f.slice(p.length + 1).split('/')[0])
        ),
      ],
      readFile: async (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
      readFileBuffer: async (p: string) => bytes(files[p] ?? ''),
      stat: async (p: string) => ({ size: (files[p] ?? '').length, mtime: new Date(0) }),
    },
  } as unknown as CommandContext;
}

const installed = {
  [`${PKG}/package.json`]: JSON.stringify({
    name: '@ai-ecoverse/wasm-gnu',
    slicc: { commands: { tac: { glue: 'bin/core', wasm: 'bin/core.wasm', argv0: 'tac' } } },
  }),
  [`${PKG}/bin/core`]: 'CORE',
  [`${PKG}/bin/core.wasm`]: 'W',
  '/w/tool.js': 'TOOL',
  '/w/tool.wasm': 'W',
  '/w/script.sh': 'echo',
};

/** Fake worker processes: each spawn resolves when the test calls its `end`. */
function fakeProcesses() {
  const ends = new Map<number, (code: number) => void>();
  spawn.mockImplementation((opts) => {
    let end!: (code: number) => void;
    const exited = new Promise<number>((resolve) => (end = resolve));
    ends.set(opts.pid, end);
    return {
      pid: opts.pid,
      exited,
      kill: vi.fn((code: number) => end(code)),
      signal: vi.fn(),
      onState: vi.fn(),
    };
  });
  return ends;
}

function processConfig() {
  let next = 500;
  const pm = {
    spawn: vi.fn(() => ({ pid: next++, abort: new AbortController() })),
    exit: vi.fn(),
    onSignal: vi.fn(() => () => {}),
    get: vi.fn((_pid: number): object | null => null),
    signal: vi.fn((_pid: number, _sig: string) => false),
  };
  const config = { processManager: pm, owner: { kind: 'cone' }, getParentPid: () => 42 };
  return { pm, config: config as unknown as ConstructorParameters<typeof WasmSession>[1] };
}

const stdio = () => {
  const t = new FdTable();
  t.install(bytesSource(new Uint8Array(0)));
  t.install(sinkFile(() => {}));
  t.install(sinkFile(() => {}));
  return t;
};

async function parentSpawner(session: WasmSession): Promise<ChildSpawner> {
  await session.launch({
    glue: '/w/tool.js',
    module: '/w/tool.wasm',
    argv0: 'tool',
    args: [],
    env: {},
    cwd: '/w',
    fds: stdio(),
  });
  return spawn.mock.calls.at(-1)![0].spawner;
}

describe('WasmSession', () => {
  beforeEach(() => {
    spawn.mockReset();
  });

  it('resolves installed names and paths with a module; nothing else', async () => {
    const session = new WasmSession(ctx(installed), undefined, () => {});
    expect(await session.resolve('tac', 'tac', '/w')).toEqual({
      glue: `${PKG}/bin/core`,
      module: `${PKG}/bin/core.wasm`,
      argv0: 'tac',
    });
    expect(await session.resolve('/w/tool.js', './tool.js', '/w')).toEqual({
      glue: '/w/tool.js',
      module: '/w/tool.wasm',
      argv0: 'tool.js',
    });
    expect(await session.resolve('/w/script.sh', 'script.sh', '/w')).toBeUndefined();
    // What a $PATH search finds in the command registry is the bare name.
    expect((await session.resolve('/usr/bin/tac', 'tac', '/w'))?.argv0).toBe('tac');
    expect((await session.resolve('/bin/tac', 'tac', '/w'))?.glue).toBe(`${PKG}/bin/core`);
    expect(await session.resolve('/usr/bin/sed', 'sed', '/w')).toBeUndefined();
    expect(await session.resolve('sed', 'sed', '/w')).toBeUndefined();
  });

  it('starts a wasm child as a process parented to its spawner', async () => {
    const ends = fakeProcesses();
    const { pm, config } = processConfig();
    const session = new WasmSession(ctx(installed), config, () => {});
    const spawner = await parentSpawner(session);
    const child = await spawner(
      { file: 'tac', argv: ['tac', '-r'], env: { A: '1' }, cwd: '/w' },
      stdio()
    );
    const opts = spawn.mock.calls.at(-1)![0];
    expect(opts.argv0).toBe('tac');
    expect(opts.args).toEqual(['-r']);
    expect(opts.program.glue).toBe('CORE');
    expect(pm.spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'wasm', argv: ['tac', '-r'], ppid: 500 })
    );
    ends.get(child.pid)!(3);
    expect(await child.exited).toBe(3);
    await Promise.resolve();
    expect(pm.exit).toHaveBeenCalledWith(child.pid, 3);
  });

  it('runs any other child through the shell on its descriptors', async () => {
    fakeProcesses();
    const exec = vi.fn(async () => ({ stdout: 'OUT', stderr: 'ERR', exitCode: 4 }));
    const { pm, config } = processConfig();
    const session = new WasmSession(ctx(installed, exec), config, () => {});
    const spawner = await parentSpawner(session);
    const out: string[] = [];
    const fds = new FdTable();
    fds.install(bytesSource(bytes('piped')));
    fds.install(sinkFile((b) => out.push(text(b))));
    fds.install(sinkFile((b) => out.push(`2:${text(b)}`)));
    const child = await spawner(
      { file: 'sed', argv: ['sed', 's/a/b/'], env: { X: '1' }, cwd: '/d' },
      fds
    );
    expect(await child.exited).toBe(4);
    expect(exec).toHaveBeenCalledWith('sed', {
      args: ['s/a/b/'],
      cwd: '/d',
      // Its stdio are pipes, not a terminal: said in the environment.
      env: { X: '1', SLICC_STDIN_ISATTY: '0', SLICC_STDOUT_ISATTY: '0' },
      replaceEnv: true,
      stdin: 'piped',
      stdinKind: 'bytes',
      signal: expect.any(AbortSignal),
    });
    expect(out).toEqual(['OUT', '2:ERR']);
    expect(pm.spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'shell', ppid: 500 })
    );
    expect(fds.has(0)).toBe(false); // released
  });

  it('refuses a shell child without an exec (ENOSYS)', async () => {
    fakeProcesses();
    const session = new WasmSession(ctx(installed), undefined, () => {});
    const spawner = await parentSpawner(session);
    await expect(
      spawner({ file: 'sed', argv: ['sed'], env: {}, cwd: '/w' }, stdio())
    ).rejects.toMatchObject({ code: 'ENOSYS' });
  });

  it('ends the whole tree on killAll, and never starts a canceled program', async () => {
    fakeProcesses();
    const session = new WasmSession(ctx(installed), undefined, () => {});
    const spawner = await parentSpawner(session);
    const child = await spawner({ file: 'tac', argv: ['tac'], env: {}, cwd: '/w' }, stdio());
    session.killAll(130);
    expect(await child.exited).toBe(130);
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.launch({
        glue: '/w/tool.js',
        module: '/w/tool.wasm',
        argv0: 'tool',
        args: [],
        env: {},
        cwd: '/w',
        fds: stdio(),
        signal: controller.signal,
      })
    ).rejects.toBeDefined();
  });

  it('routes kill(2) from a program to session processes and the process table', async () => {
    const ends = fakeProcesses();
    spawn.mockImplementation((opts) => {
      let end!: (code: number) => void;
      const exited = new Promise<number>((resolve) => (end = resolve));
      ends.set(opts.pid, end);
      return { pid: opts.pid, exited, kill: vi.fn(), signal: vi.fn() };
    });
    const { pm, config } = processConfig();
    pm.get.mockImplementation((pid) => (pid === 900 ? {} : null));
    pm.signal.mockReturnValue(true);
    const session = new WasmSession(ctx(installed), config, () => {});
    await parentSpawner(session);
    const first = spawn.mock.calls.at(-1)![0];
    await first.spawner({ file: 'tac', argv: ['tac'], env: {}, cwd: '/w' }, stdio());
    const child = spawn.mock.results.at(-1)!.value;
    const kill = first.kill as (pid: number, sig: number) => boolean;
    expect(kill(child.pid, 10)).toBe(true);
    expect(child.signal).toHaveBeenCalledWith(10);
    expect(kill(900, 0)).toBe(true); // exists in the process table
    expect(kill(900, 15)).toBe(true);
    expect(pm.signal).toHaveBeenCalledWith(900, 'SIGTERM');
    expect(kill(900, 10)).toBe(false); // the table has no SIGUSR1
    expect(kill(901, 0)).toBe(false);
  });

  it('runs a shell child on a terminal stdin at once, with no stdin (it never ends)', async () => {
    fakeProcesses();
    const exec = vi.fn(async (_cmd: string, _opts: { env?: Record<string, string> }) => ({
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
    }));
    const { config } = processConfig();
    const session = new WasmSession(
      ctx(installed, exec as unknown as CommandContext['exec']),
      config,
      () => {}
    );
    const spawner = await parentSpawner(session);
    const out: Uint8Array[] = [];
    const fds = new FdTable();
    const tty = new KernelTty({ write: () => {} }, () => {});
    fds.install(tty.file());
    fds.install(sinkFile((b) => out.push(b)));
    fds.install(sinkFile(() => {}));
    const child = await spawner({ file: 'which', argv: ['which', 'ls'], env: {}, cwd: '/w' }, fds);
    expect(await child.exited).toBe(0);
    expect(exec).toHaveBeenCalledWith('which', expect.objectContaining({ stdin: '' }));
    // stdin is the terminal: no hint; stdout is a pipe/sink: "no terminal".
    expect(exec.mock.calls[0]![1].env).toEqual({ SLICC_STDOUT_ISATTY: '0' });
    expect(new TextDecoder().decode(out[0])).toBe('ok\n');
  });

  it('a shell child joins its parent’s process group and reports the signal that ended it', async () => {
    fakeProcesses();
    const exec = vi.fn(
      (_cmd: string, opts: { signal: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          opts.signal.addEventListener('abort', () =>
            resolve({ stdout: '', stderr: '', exitCode: 130 })
          );
        })
    );
    const { config } = processConfig();
    const session = new WasmSession(
      ctx(installed, exec as unknown as CommandContext['exec']),
      config,
      () => {}
    );
    const spawner = await parentSpawner(session);
    const parent = spawn.mock.calls.at(-1)![0];
    const kill = parent.kill as (pid: number, sig: number) => boolean;
    const child = await spawner(
      { file: 'sleep', argv: ['sleep', '9'], env: {}, cwd: '/w' },
      stdio()
    );
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    expect(exec.mock.calls[0]![1]).toMatchObject({
      env: { SLICC_STDIN_ISATTY: '0', SLICC_STDOUT_ISATTY: '0' },
    });
    expect(kill(-parent.pid, 20)).toBe(true); // SIGTSTP to the group: a shell command cannot stop
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kill(-parent.pid, 2)).toBe(true); // SIGINT to the group ends it
    expect(await child.exited).toBe(130);
    expect(child.termsig?.()).toBe(2);
  });

  it('a shell child killed through the process table reports the signal (WIFSIGNALED)', async () => {
    fakeProcesses();
    const exec = vi.fn(
      (_cmd: string, opts: { signal: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          opts.signal.addEventListener('abort', () =>
            resolve({ stdout: '', stderr: '', exitCode: 130 })
          );
        })
    ) as unknown as CommandContext['exec'];
    const { pm, config } = processConfig();
    let listener: ((proc: { pid: number }, sig: string) => void) | undefined;
    const unsubscribe = vi.fn();
    pm.onSignal.mockImplementation(((l: typeof listener) => {
      listener = l;
      return unsubscribe;
    }) as never);
    const session = new WasmSession(ctx(installed, exec), config, () => {});
    const spawner = await parentSpawner(session);
    const child = await spawner(
      { file: 'sleep', argv: ['sleep', '9'], env: {}, cwd: '/w' },
      stdio()
    );
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    // What ProcessManager.signal does: abort the record, and tell its listeners.
    const record = pm.spawn.mock.results.at(-1)!.value as { abort: AbortController };
    record.abort.abort();
    listener?.({ pid: child.pid }, 'SIGTERM');
    expect(await child.exited).toBe(130);
    expect(child.termsig?.()).toBe(15);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('ends a shell child on its own process signal, and on killAll', async () => {
    fakeProcesses();
    // An exec that runs until its signal aborts, like `sleep 100`.
    const exec = vi.fn(
      (_cmd: string, opts: { signal: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          const stop = () => resolve({ stdout: '', stderr: '', exitCode: 130 });
          if (opts.signal.aborted) stop();
          else opts.signal.addEventListener('abort', stop);
        })
    ) as unknown as CommandContext['exec'];
    const { pm, config } = processConfig();
    const session = new WasmSession(ctx(installed, exec), config, () => {});
    const spawner = await parentSpawner(session);
    const req = { file: 'sleep', argv: ['sleep', '100'], env: {}, cwd: '/w' };
    const first = await spawner(req, stdio());
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    // `kill <pid>`: the process manager aborts the record's controller.
    const record = pm.spawn.mock.results.at(-1)!.value as { abort: AbortController };
    record.abort.abort();
    expect(await first.exited).toBe(130);
    const second = await spawner(req, stdio());
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
    session.killAll(1); // the output limit
    expect(await second.exited).toBe(130);
  });

  it('kill(2) of a shell child ends it for every signal whose default action terminates', async () => {
    fakeProcesses();
    const exec = vi.fn(
      (_cmd: string, opts: { signal: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          opts.signal.addEventListener('abort', () =>
            resolve({ stdout: '', stderr: '', exitCode: 130 })
          );
        })
    ) as unknown as CommandContext['exec'];
    const { config } = processConfig();
    const session = new WasmSession(ctx(installed, exec), config, () => {});
    const spawner = await parentSpawner(session);
    const kill = spawn.mock.calls.at(-1)![0].kill as (pid: number, sig: number) => boolean;
    const child = await spawner(
      { file: 'sleep', argv: ['sleep', '9'], env: {}, cwd: '/w' },
      stdio()
    );
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    let ended = false;
    void child.exited.then(() => (ended = true));
    expect(kill(child.pid, 17)).toBe(true); // SIGCHLD: ignored by default
    expect(kill(child.pid, 0)).toBe(true); // a probe
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ended).toBe(false);
    expect(kill(child.pid, 10)).toBe(true); // SIGUSR1: terminates
    expect(await child.exited).toBe(130);
  });

  it('forks a process into the same program, resumed from the parent state', async () => {
    fakeProcesses();
    const { pm, config } = processConfig();
    const session = new WasmSession(ctx(installed), config, () => {});
    await parentSpawner(session);
    const parent = spawn.mock.calls.at(-1)![0];
    const state = {
      memory: new Uint8Array(1),
      currData: 0,
      forkSp: 0,
      callStackNames: [],
      ppid: 500,
      cwd: '/w/sub',
    };
    const child = await parent.forker(state, stdio());
    const opts = spawn.mock.calls.at(-1)![0];
    expect(opts.fork).toBe(state);
    expect(opts.program).toBe(parent.program);
    expect(opts.cwd).toBe('/w/sub');
    expect(opts.argv0).toBe('tool');
    expect(pm.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'wasm', ppid: 500 }));
    expect(child.pid).toBe(opts.pid);
  });
});
