import type { CommandContext } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/kernel/wasm-realm/host.js', () => ({ spawnWasmProcess: spawn }));
vi.mock('../../../../src/kernel/realm/wasm-compiler.js', () => ({
  compileWasmFromVfs: async () => ({}),
  compileWasmModule: async () => ({}),
}));

import type { ChildSpawner } from '../../../../src/kernel/wasm-realm/children.js';
import { bytesSource, FdTable, sinkFile } from '../../../../src/kernel/wasm-realm/fd-table.js';
import { LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';
import { KernelTty } from '../../../../src/kernel/wasm-realm/tty.js';
import type { WasmCommand } from '../../../../src/shell/ipk/wasm-programs.js';
import {
  expandDefaults,
  installedCommands,
  isModuleFile,
  isWasiTarget,
  SECRET_FUNCTION,
  SECRET_FUNCTION_ENV,
  WasmSession,
} from '../../../../src/shell/supplemental-commands/wasm/launch.js';

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
      writeFile: async (p: string, content: string) => {
        files[p] = content;
      },
      mkdir: async () => {},
      stat: async (p: string) => {
        if (!has(p)) throw new Error(`ENOENT: ${p}`);
        return { isFile: p in files, size: (files[p] ?? '').length, mtime: new Date(0) };
      },
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

  it("runs a glue copy without its own module as its package's program (git's dashed builtins)", async () => {
    const GIT = '/shared/lib/node_modules/@ai-ecoverse/wasm-git';

    const glue = 'var Module;function findWasmBinary(){return locateFile("git.wasm")}';
    const files = {
      [`${GIT}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-git',
        slicc: {
          env: { GIT_EXEC_PATH: 'libexec/git-core' },
          commands: { git: { glue: 'bin/git', wasm: 'bin/git.wasm' } },
        },
      }),
      [`${GIT}/bin/git`]: glue,
      [`${GIT}/bin/git.wasm`]: 'W',
      [`${GIT}/libexec/git-core/git-upload-pack`]: glue,
      [`${GIT}/libexec/git-core/git-lost`]: 'var Module;locateFile("lost.wasm")',

      [`${PKG}/package.json`]: installed[`${PKG}/package.json`],
      [`${PKG}/bin/other`]: glue,
    };
    const session = new WasmSession(ctx(files), undefined, () => {});
    const target = await session.resolve(
      `${GIT}/libexec/git-core/git-upload-pack`,
      'git-upload-pack',
      '/w'
    );
    expect(target).toMatchObject({
      glue: `${GIT}/bin/git`,
      module: `${GIT}/bin/git.wasm`,
      argv0: 'git-upload-pack',
    });
    expect(target?.defaults?.GIT_EXEC_PATH).toBe(`${GIT}/libexec/git-core`);
    expect(
      await session.resolve(`${GIT}/libexec/git-core/git-lost`, 'git-lost', '/w')
    ).toBeUndefined();
    expect(await session.resolve(`${PKG}/bin/other`, 'other', '/w')).toBeUndefined();
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

    expect((await session.resolve('/usr/bin/tac', 'tac', '/w'))?.argv0).toBe('tac');
    expect((await session.resolve('/bin/tac', 'tac', '/w'))?.glue).toBe(`${PKG}/bin/core`);
    expect(await session.resolve('/usr/bin/sed', 'sed', '/w')).toBeUndefined();
    expect(await session.resolve('sed', 'sed', '/w')).toBeUndefined();
  });

  it('prepends fixed arguments when a child spawns an installed command', async () => {
    fakeProcesses();
    const files = {
      ...installed,
      [`${PKG}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-gnu',
        slicc: {
          commands: { tac: { glue: 'bin/core', wasm: 'bin/core.wasm', args: ['-S', 'tac'] } },
        },
      }),
    };
    const session = new WasmSession(ctx(files), undefined, () => {});
    await parentSpawner(session);
    const parent = spawn.mock.calls.at(-1)![0];
    await parent.spawner({ file: 'tac', argv: ['tac', '--version'], env: {}, cwd: '/w' }, stdio());
    expect(spawn.mock.calls.at(-1)![0].args).toEqual(['-S', 'tac', '--version']);
  });

  it("puts every invocation of one owner on that owner's loopback network", async () => {
    fakeProcesses();
    const launch = async (config: ConstructorParameters<typeof WasmSession>[1]) => {
      const session = new WasmSession(ctx(installed), config, () => {});
      await session.launch({
        glue: '/w/tool.js',
        module: '/w/tool.wasm',
        argv0: 'tool',
        args: [],
        env: {},
        cwd: '/w',
        fds: stdio(),
      });
      return spawn.mock.calls.at(-1)?.[0].net;
    };
    const cone = processConfig().config;
    const scoop = { ...cone, owner: { kind: 'scoop', scoopJid: 's1' } } as typeof cone;
    const first = await launch(cone);
    expect(first).toBeInstanceOf(LoopbackNet);
    expect(await launch(processConfig().config)).toBe(first);
    expect(await launch(scoop)).not.toBe(first);
  });

  it('runs an installed GNU bash as a program’s /bin/sh, unless a package provides sh', async () => {
    const BASH = '/shared/lib/node_modules/@ai-ecoverse/wasm-bash';
    const withBash = {
      ...installed,
      [`${BASH}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-bash',
        slicc: { commands: { bash: { glue: 'bin/bash', wasm: 'bin/bash.wasm' } } },
      }),
    };
    expect(
      await new WasmSession(ctx(installed), undefined, () => {}).resolve('/bin/sh', 'sh', '/w')
    ).toBeUndefined();
    const session = new WasmSession(ctx(withBash), undefined, () => {});

    expect(await session.resolve('/bin/sh', 'sh', '/w')).toEqual({
      glue: `${BASH}/bin/bash`,
      module: `${BASH}/bin/bash.wasm`,
      argv0: 'sh',
    });
    expect((await session.resolve('sh', 'sh', '/w'))?.glue).toBe(`${BASH}/bin/bash`);
    const DASH = '/shared/lib/node_modules/@ai-ecoverse/wasm-dash';
    const withSh = {
      ...withBash,
      [`${DASH}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-dash',
        slicc: { commands: { sh: { glue: 'bin/dash', wasm: 'bin/dash.wasm' } } },
      }),
    };
    const own = new WasmSession(ctx(withSh), undefined, () => {});
    expect((await own.resolve('/bin/sh', 'sh', '/w'))?.glue).toBe(`${DASH}/bin/dash`);
  });

  it('gives every bash it starts GNU bash’s secret function, a program’s /bin/sh too', async () => {
    const BASH = '/shared/lib/node_modules/@ai-ecoverse/wasm-bash';
    const files = {
      ...installed,
      [`${BASH}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-bash',
        slicc: { commands: { bash: { glue: 'bin/bash', wasm: 'bin/bash.wasm' } } },
      }),
      [`${BASH}/bin/bash`]: 'BASH',
      [`${BASH}/bin/bash.wasm`]: 'W',
    };
    fakeProcesses();
    const session = new WasmSession(ctx(files), undefined, () => {});

    const spawner = await parentSpawner(session);
    expect(spawn.mock.calls.at(-1)![0].env).not.toHaveProperty(SECRET_FUNCTION_ENV);
    await spawner(
      { file: '/bin/sh', argv: ['sh', '-c', 'x'], env: { A: '1' }, cwd: '/w' },
      stdio()
    );
    expect(spawn.mock.calls.at(-1)![0].env).toEqual({
      A: '1',
      [SECRET_FUNCTION_ENV]: SECRET_FUNCTION,
    });
    await spawner({ file: 'bash', argv: ['bash'], env: {}, cwd: '/w' }, stdio());
    expect(spawn.mock.calls.at(-1)![0].env[SECRET_FUNCTION_ENV]).toBe(SECRET_FUNCTION);

    const own = { [SECRET_FUNCTION_ENV]: '() { :; }' };
    await spawner({ file: 'bash', argv: ['bash'], env: own, cwd: '/w' }, stdio());
    expect(spawn.mock.calls.at(-1)![0].env).toEqual(own);
    await spawner({ file: 'tac', argv: ['tac'], env: {}, cwd: '/w' }, stdio());
    expect(spawn.mock.calls.at(-1)![0].env).toEqual({});
  });

  it('asks the shell’s catalog on every lookup: an install or removal mid-session counts', async () => {
    const known = new Map<string, WasmCommand>();
    const session = new WasmSession(
      ctx(installed),
      undefined,
      () => {},
      undefined,
      async () => known
    );

    expect(await session.resolve('tac', 'tac', '/w')).toBeUndefined();
    known.set('tac', {
      name: 'tac',
      glue: `${PKG}/bin/core`,
      wasm: `${PKG}/bin/core.wasm`,
      argv0: 'tac',
      pkg: 'gnu',
    });
    expect((await session.resolve('/usr/bin/tac', 'tac', '/w'))?.glue).toBe(`${PKG}/bin/core`);
    known.delete('tac');
    expect(await session.resolve('/usr/bin/tac', 'tac', '/w')).toBeUndefined();
  });

  it('asks the gate before a program runs natively; a denied one reports and exits', async () => {
    fakeProcesses();
    const { config } = processConfig();
    const gate = vi.fn(async (name: string) =>
      name === 'tac' ? { stderr: 'sudo: denied\n', exitCode: 77 } : null
    );
    const session = new WasmSession(ctx(installed), config, () => {}, gate);
    const spawner = await parentSpawner(session);
    const launched = spawn.mock.calls.length;
    const err: Uint8Array[] = [];
    const fds = new FdTable();
    fds.install(bytesSource(new Uint8Array(0)));
    fds.install(sinkFile(() => {}));
    fds.install(sinkFile((b) => err.push(b)));
    const child = await spawner(
      { file: '/usr/bin/tac', argv: ['tac', '-r'], env: { R: 'why' }, cwd: '/w' },
      fds
    );
    expect(gate).toHaveBeenCalledWith('tac', ['-r'], { R: 'why' });
    expect(await child.exited).toBe(77);
    expect(new TextDecoder().decode(err[0])).toBe('sudo: denied\n');
    expect(spawn.mock.calls.length).toBe(launched);
  });

  it('starts a program with its own command’s env defaults; the caller’s env wins', async () => {
    fakeProcesses();
    const files = {
      ...installed,
      [`${PKG}/etc/conf`]: 'x',
      [`${PKG}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-gnu',
        slicc: {
          env: { CONF: 'etc/conf', MODE: 'default' },

          commands: {
            tac: { glue: 'bin/core', wasm: 'bin/core.wasm', argv0: 'tac', env: { WHO: 'tac' } },
            rev: { glue: 'bin/core', wasm: 'bin/core.wasm', argv0: 'rev', env: { WHO: 'rev' } },
          },
        },
      }),
    };
    const session = new WasmSession(ctx(files), undefined, () => {});
    const target = await session.resolve('tac', 'tac', '/w');
    await session.launch({
      ...target!,
      args: [],
      env: { MODE: 'mine', A: '1' },
      cwd: '/w',
      fds: stdio(),
    });
    expect(spawn.mock.calls.at(-1)![0].env).toEqual({
      CONF: `${PKG}/etc/conf`,
      WHO: 'tac',
      MODE: 'mine',
      A: '1',
    });
  });

  it('sets LOGNAME to USER unless the caller set one (not the runtime’s web_user)', async () => {
    fakeProcesses();
    const session = new WasmSession(ctx(installed), undefined, () => {});
    const target = await session.resolve('tac', 'tac', '/w');
    const envOf = async (env: Record<string, string>) => {
      await session.launch({ ...target!, args: [], env, cwd: '/w', fds: stdio() });
      return spawn.mock.calls.at(-1)![0].env;
    };
    expect(await envOf({ USER: 'user' })).toEqual({ USER: 'user', LOGNAME: 'user' });
    expect(await envOf({ USER: 'scoop', LOGNAME: 'other' })).toEqual({
      USER: 'scoop',
      LOGNAME: 'other',
    });
    expect(await envOf({ A: '1' })).toEqual({ A: '1' });
  });

  it('an installed Python interpreter starts with the installed Python packages on its path (.pth)', async () => {
    fakeProcesses();
    const py = '/shared/lib/node_modules/@ai-ecoverse/py-cpython';
    const lib = (name: string, python: object) => ({
      [`/shared/lib/node_modules/@ai-ecoverse/${name}/package.json`]: JSON.stringify({
        name: `@ai-ecoverse/${name}`,
        slicc: { python },
      }),
    });
    const files: Record<string, string> = {
      ...installed,
      [`${py}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/py-cpython',
        slicc: {
          abi: 'wasi',
          commands: { python3: { wasm: 'bin/python.wasm' } },
          python: { version: '3.14', abi: 'cp314', platform: 'wasix_wasm32' },
        },
      }),
      [`${py}/bin/python.wasm`]: 'W',
      ...lib('py-numpy', {
        sitePackages: 'lib/python3.14/site-packages',
        requires: { abi: 'cp314', platform: 'wasix_wasm32' },
      }),
      ...lib('py-old', {
        sitePackages: 'lib/python3.12/site-packages',
        requires: { abi: 'cp312' },
      }),
    };
    const session = new WasmSession(ctx(files), undefined, () => {});
    const target = await session.resolve('python3', 'python3', '/w');
    let stderr = '';
    const fds = new FdTable();
    fds.install(bytesSource(new Uint8Array(0)));
    fds.install(sinkFile(() => {}));
    fds.install(sinkFile((b) => void (stderr += text(b))));
    await session.launch({ ...target!, args: [], env: { HOME: '/home/u' }, cwd: '/w', fds });
    const pth = files['/home/u/.local/lib/python3.14/site-packages/_slicc_packages.pth'];
    expect(pth).toContain(
      'site.addsitedir("/shared/lib/node_modules/@ai-ecoverse/py-numpy/lib/python3.14/site-packages")'
    );
    expect(pth).not.toContain('py-old');
    expect(stderr).toBe(
      'python3: not for cp314-wasix_wasm32, left off the path: @ai-ecoverse/py-old\n'
    );

    delete files['/home/u/.local/lib/python3.14/site-packages/_slicc_packages.pth'];
    await parentSpawner(session);
    expect(Object.keys(files).some((f) => f.endsWith('.pth'))).toBe(false);
  });

  it('scans the Python packages once per installed set, again after an install', async () => {
    fakeProcesses();
    const py = '/shared/lib/node_modules/@ai-ecoverse/py-cpython';
    const files: Record<string, string> = {
      [`${py}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/py-cpython',
        slicc: {
          abi: 'wasi',
          commands: { python3: { wasm: 'bin/python.wasm' } },
          python: { version: '3.14', abi: 'cp314', platform: 'wasix_wasm32' },
        },
      }),
      [`${py}/bin/python.wasm`]: 'W',
    };
    const c = ctx(files);
    const readdir = vi.spyOn(c.fs, 'readdir');

    let catalog = await installedCommands(c);
    const session = new WasmSession(
      c,
      undefined,
      () => {},
      undefined,
      async () => catalog
    );
    const target = await session.resolve('python3', 'python3', '/w');
    const start = () =>
      session.launch({ ...target!, args: [], env: { HOME: '/home/u' }, cwd: '/w', fds: stdio() });
    readdir.mockClear();
    await start();
    const scans = readdir.mock.calls.length;
    expect(scans).toBeGreaterThan(0);
    await start();
    await start();
    expect(readdir.mock.calls.length).toBe(scans);
    catalog = new Map(catalog);
    await start();
    expect(readdir.mock.calls.length).toBe(2 * scans);
  });

  it("keeps the realm's git system config over a package's GIT_CONFIG_NOSYSTEM default", async () => {
    fakeProcesses();
    const files = {
      ...installed,
      [`${PKG}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-gnu',
        slicc: {
          env: { GIT_CONFIG_NOSYSTEM: '1' },
          commands: { tac: { glue: 'bin/core', wasm: 'bin/core.wasm', argv0: 'tac' } },
        },
      }),
    };
    const session = new WasmSession(ctx(files), undefined, () => {});
    const target = await session.resolve('tac', 'tac', '/w');
    const launch = (env: Record<string, string>) =>
      session.launch({ ...target!, args: [], env, cwd: '/w', fds: stdio() });
    const realm = { GIT_CONFIG_SYSTEM: '/home/u/.config/slicc/gitconfig' };

    await launch(realm);
    expect(spawn.mock.calls.at(-1)![0].env).toEqual(realm);

    await launch({ GIT_CONFIG_SYSTEM: '/etc/mine' });
    expect(spawn.mock.calls.at(-1)![0].env.GIT_CONFIG_NOSYSTEM).toBe('1');

    await launch({ ...realm, GIT_CONFIG_NOSYSTEM: '1' });
    expect(spawn.mock.calls.at(-1)![0].env.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it("expands ${NAME} in a package's env defaults from the caller's environment", async () => {
    fakeProcesses();
    const files = {
      ...installed,
      [`${PKG}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasi-zig',
        slicc: {
          env: { ZIG_GLOBAL_CACHE_DIR: '${HOME}/.cache/zig', ZIG_LIB_DIR: '${package}/lib' },
          commands: { tac: { glue: 'bin/core', wasm: 'bin/core.wasm', argv0: 'tac' } },
        },
      }),
    };
    const session = new WasmSession(ctx(files), undefined, () => {});
    const target = await session.resolve('tac', 'tac', '/w');
    const launch = (env: Record<string, string>) =>
      session.launch({ ...target!, args: [], env, cwd: '/w', fds: stdio() });
    await launch({ HOME: '/home/u' });
    expect(spawn.mock.calls.at(-1)![0].env).toEqual({
      HOME: '/home/u',
      ZIG_GLOBAL_CACHE_DIR: '/home/u/.cache/zig',
      ZIG_LIB_DIR: `${PKG}/lib`,
    });

    await launch({});
    expect(spawn.mock.calls.at(-1)![0].env).toEqual({ ZIG_LIB_DIR: `${PKG}/lib` });
  });

  it('expandDefaults substitutes every reference and keeps other text literal', () => {
    expect(
      expandDefaults(
        { A: '${X}:${Y}', B: 'plain $X {Y}', C: '${UNSET}/x', D: '${X}${X}' },
        { X: '1', Y: '2' }
      )
    ).toEqual({ A: '1:2', B: 'plain $X {Y}', D: '11' });
  });

  it('expandDefaults takes no Object.prototype member for a variable', () => {
    expect(expandDefaults({ A: '${toString}', B: '${constructor}/x', C: 'ok' }, {})).toEqual({
      C: 'ok',
    });
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
    expect(fds.has(0)).toBe(false);
  });

  it('runs a `#!` script by path with its interpreter, as execve does (git’s hooks on GNU bash)', async () => {
    fakeProcesses();
    const BASH = '/shared/lib/node_modules/@ai-ecoverse/wasm-bash';
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const files = {
      ...installed,
      [`${BASH}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-bash',
        slicc: { commands: { bash: { glue: 'bin/bash', wasm: 'bin/bash.wasm' } } },
      }),
      [`${BASH}/bin/bash`]: 'BASH',
      [`${BASH}/bin/bash.wasm`]: 'W',
      '/r/.git/hooks/pre-commit': '#!/bin/sh\necho hook\n',
      '/r/tool-with-arg': '#!/usr/bin/bash -e\necho\n',
      '/r/perl-script': '#!/usr/bin/perl\nprint 1\n',
    };
    const gate = vi.fn(async () => null);
    const session = new WasmSession(ctx(files, exec), undefined, () => {}, gate);
    const spawner = await parentSpawner(session);
    await spawner(
      { file: '.git/hooks/pre-commit', argv: ['.git/hooks/pre-commit', 'x'], env: {}, cwd: '/r' },
      stdio()
    );
    let opts = spawn.mock.calls.at(-1)![0];

    expect(opts.program.glue).toBe('BASH');
    expect(opts.argv0).toBe('sh');
    expect(opts.args).toEqual(['.git/hooks/pre-commit', 'x']);

    expect(gate).toHaveBeenLastCalledWith('sh', ['.git/hooks/pre-commit', 'x'], {});

    await spawner(
      { file: '/r/tool-with-arg', argv: ['/r/tool-with-arg'], env: {}, cwd: '/r' },
      stdio()
    );
    opts = spawn.mock.calls.at(-1)![0];
    expect(opts.args).toEqual(['-e', '/r/tool-with-arg']);

    const perl = await spawner(
      { file: '/r/perl-script', argv: ['/r/perl-script'], env: {}, cwd: '/r' },
      stdio()
    );
    expect(await perl.exited).toBe(0);
    expect(exec).toHaveBeenCalledWith('/r/perl-script', expect.objectContaining({ args: [] }));
  });

  it("runs a package's script command (a compiler driver) with its interpreter and env defaults", async () => {
    fakeProcesses();
    const BASH = '/shared/lib/node_modules/@ai-ecoverse/wasm-bash';
    const CLANG = '/shared/lib/node_modules/@ai-ecoverse/wasm-clang';
    const files = {
      ...installed,
      [`${BASH}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-bash',
        slicc: { commands: { bash: { glue: 'bin/bash', wasm: 'bin/bash.wasm' } } },
      }),
      [`${BASH}/bin/bash`]: 'BASH',
      [`${BASH}/bin/bash.wasm`]: 'W',
      [`${CLANG}/package.json`]: JSON.stringify({
        name: '@ai-ecoverse/wasm-clang',
        slicc: {
          env: { SYSROOT: '${package}/sysroot' },
          commands: { cc: { script: 'bin/cc' } },
        },
      }),
      [`${CLANG}/bin/cc`]: '#!/bin/sh\nexec clang "$@"\n',
    };
    const gate = vi.fn(async () => null);
    const session = new WasmSession(ctx(files), undefined, () => {}, gate);

    expect(await session.resolve('cc', 'cc', '/w')).toBeUndefined();
    const spawner = await parentSpawner(session);

    await spawner(
      { file: '/usr/bin/cc', argv: ['cc', '-c', 'x.c'], env: { A: '1' }, cwd: '/d' },
      stdio()
    );
    const opts = spawn.mock.calls.at(-1)![0];
    expect(opts.program.glue).toBe('BASH');
    expect(opts.argv0).toBe('sh');
    expect(opts.args).toEqual([`${CLANG}/bin/cc`, '-c', 'x.c']);

    expect(opts.env).toMatchObject({ A: '1', SYSROOT: `${CLANG}/sysroot` });
    expect(gate).toHaveBeenLastCalledWith('sh', [`${CLANG}/bin/cc`, '-c', 'x.c'], { A: '1' });

    const run = await session.interpreted({ file: 'cc', argv: ['cc', 'y.c'], cwd: '/w' });
    expect(run?.args).toEqual([`${CLANG}/bin/cc`, 'y.c']);
    expect(run?.target.defaults).toMatchObject({ SYSROOT: `${CLANG}/sysroot` });
  });

  it('refuses a shell child without an exec (ENOSYS)', async () => {
    fakeProcesses();
    const session = new WasmSession(ctx(installed), undefined, () => {});
    const spawner = await parentSpawner(session);
    await expect(
      spawner({ file: 'sed', argv: ['sed'], env: {}, cwd: '/w' }, stdio())
    ).rejects.toMatchObject({ code: 'ENOSYS' });
  });

  it('fails the spawn with ENOENT for a program nothing runs, as execve does', async () => {
    fakeProcesses();

    const exec = vi.fn(async (cmd: string, opts: { args?: string[] }) =>
      cmd === 'command'
        ? { stdout: '', stderr: '', exitCode: opts.args?.[1] === 'test' ? 0 : 1 }
        : { stdout: '', stderr: '', exitCode: 0 }
    );
    const { pm, config } = processConfig();
    const shell = {
      ...ctx(installed, exec as unknown as CommandContext['exec']),
      getRegisteredCommands: () => ['sed'],
    } as CommandContext;
    const session = new WasmSession(shell, config, () => {});
    const spawner = await parentSpawner(session);
    const records = pm.spawn.mock.calls.length;

    for (const file of ['fc-list', '/usr/bin/fc-list']) {
      const fds = stdio();
      await expect(
        spawner({ file, argv: ['fc-list'], env: { PATH: '/usr/bin' }, cwd: '/d' }, fds)
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await vi.waitFor(() => expect(fds.has(0)).toBe(false));
    }
    expect(exec).toHaveBeenCalledWith('command', {
      args: ['-v', 'fc-list'],
      cwd: '/d',
      env: { PATH: '/usr/bin' },
      replaceEnv: true,
    });

    await expect(
      spawner({ file: '/usr/local/bin/sed', argv: ['sed'], env: {}, cwd: '/d' }, stdio())
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(pm.spawn).toHaveBeenCalledTimes(records);

    exec.mockClear();
    const sed = await spawner({ file: '/usr/bin/sed', argv: ['sed'], env: {}, cwd: '/d' }, stdio());
    expect(await sed.exited).toBe(0);
    expect(exec.mock.calls.map((c) => c[0])).toEqual(['/usr/bin/sed']);
    const test = await spawner(
      { file: 'test', argv: ['test', '-e', 'x'], env: {}, cwd: '/d' },
      stdio()
    );
    expect(await test.exited).toBe(0);
    expect(exec).toHaveBeenLastCalledWith('test', expect.objectContaining({ args: ['-e', 'x'] }));

    const script = await spawner(
      { file: '/w/script.sh', argv: ['script.sh'], env: {}, cwd: '/d' },
      stdio()
    );
    expect(await script.exited).toBe(0);
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
    expect(kill(900, 0)).toBe(true);
    expect(kill(900, 15)).toBe(true);
    expect(pm.signal).toHaveBeenCalledWith(900, 'SIGTERM');
    expect(kill(900, 10)).toBe(false);
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
    expect(kill(-parent.pid, 20)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kill(-parent.pid, 2)).toBe(true);
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

    const record = pm.spawn.mock.results.at(-1)!.value as { abort: AbortController };
    record.abort.abort();
    listener?.({ pid: child.pid }, 'SIGTERM');
    expect(await child.exited).toBe(130);
    expect(child.termsig?.()).toBe(15);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('kill(2) of a process outside the invocation goes through the command policy', async () => {
    fakeProcesses();
    const { pm, config } = processConfig();
    pm.signal.mockReturnValue(true);
    const gate = vi.fn(async (_name: string, args: string[]) =>
      args[1] === '900' ? { stderr: 'denied\n', exitCode: 77 } : null
    );
    const session = new WasmSession(ctx(installed), config, () => {}, gate);
    await parentSpawner(session);
    const kill = spawn.mock.calls.at(-1)![0].kill as (pid: number, sig: number) => Promise<boolean>;
    await expect(kill(900, 15)).rejects.toMatchObject({ code: 'EPERM' });
    expect(gate).toHaveBeenCalledWith('kill', ['-TERM', '900'], {});
    expect(pm.signal).not.toHaveBeenCalled();
    expect(await kill(901, 2)).toBe(true);
    expect(pm.signal).toHaveBeenCalledWith(901, 'SIGINT');
  });

  it('ends a shell child on its own process signal, and on killAll', async () => {
    fakeProcesses();

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

    const record = pm.spawn.mock.results.at(-1)!.value as { abort: AbortController };
    record.abort.abort();
    expect(await first.exited).toBe(130);
    const second = await spawner(req, stdio());
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
    session.killAll(1);
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
    expect(kill(child.pid, 17)).toBe(true);
    expect(kill(child.pid, 0)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ended).toBe(false);
    expect(kill(child.pid, 10)).toBe(true);
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

  it('runs a wasm module by itself (the `\\0asm` magic) as a WASI program: no glue to read', async () => {
    fakeProcesses();
    const WASM = '\0asm\x01\0\0\0';
    const files = { ...installed, '/w/rg.wasm': WASM, '/w/notes.wasm': 'plain text' };
    const session = new WasmSession(ctx(files), undefined, () => {});
    const target = await session.resolve('/w/rg.wasm', './rg.wasm', '/w');
    expect(target).toEqual({ glue: '/w/rg.wasm', module: '/w/rg.wasm', argv0: 'rg' });
    expect(isWasiTarget(target!)).toBe(true);

    expect(await session.resolve('/w/notes.wasm', 'notes.wasm', '/w')).toBeUndefined();
    await session.launch({ ...target!, args: ['-n', 'x'], env: {}, cwd: '/w', fds: stdio() });
    const opts = spawn.mock.calls.at(-1)![0];
    expect(opts.program).toMatchObject({ abi: 'wasi', glue: '' });
    expect(opts.argv0).toBe('rg');
    expect(opts.args).toEqual(['-n', 'x']);
  });

  it('isModuleFile: only an existing regular file starting with the wasm magic', async () => {
    const c = ctx({ '/w/m.wasm': '\0asm\x01', '/w/d/x': '', '/w/s.sh': '#!/bin/sh' });
    expect(await isModuleFile(c, '/w/m.wasm')).toBe(true);
    expect(await isModuleFile(c, '/w/m.wasm')).toBe(true);
    expect(await isModuleFile(c, '/w/s.sh')).toBe(false);
    expect(await isModuleFile(c, '/w/d')).toBe(false);
    expect(await isModuleFile(c, '/w/missing')).toBe(false);
  });
});
