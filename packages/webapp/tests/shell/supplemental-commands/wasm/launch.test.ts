import type { CommandContext } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/kernel/wasm-realm/host.js', () => ({ spawnWasmProcess: spawn }));
vi.mock('../../../../src/kernel/realm/wasm-compiler.js', () => ({
  compileWasmFromVfs: async () => ({}),
}));

import type { ChildSpawner } from '../../../../src/kernel/wasm-realm/children.js';
import { bytesSource, FdTable, sinkFile } from '../../../../src/kernel/wasm-realm/fd-table.js';
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
    return { pid: opts.pid, exited, kill: vi.fn((code: number) => end(code)) };
  });
  return ends;
}

function processConfig() {
  let next = 500;
  const pm = {
    spawn: vi.fn(() => ({ pid: next++ })),
    exit: vi.fn(),
    onSignal: vi.fn(() => () => {}),
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
      env: { X: '1' },
      replaceEnv: true,
      stdin: 'piped',
      stdinKind: 'bytes',
      signal: undefined,
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
});
