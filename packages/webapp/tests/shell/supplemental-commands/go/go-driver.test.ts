import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../../src/fs/index.js';
import { GLOBAL_NODE_MODULES } from '../../../../src/shell/ipk/global-prefix.js';
import type { ToolRunner } from '../../../../src/shell/supplemental-commands/go/go-build.js';
import {
  type GoDriverDeps,
  parseBuildFlags,
  runGoCommand,
} from '../../../../src/shell/supplemental-commands/go/go-driver.js';
import { createGoCommand } from '../../../../src/shell/supplemental-commands/go-command.js';
import { VfsAdapter } from '../../../../src/shell/vfs-adapter.js';
import { mockCommandContext } from '../../helpers/mock-command-context.js';

const PKG = `${GLOBAL_NODE_MODULES}/@ai-ecoverse/wasm-go`;

let vfs: VirtualFS;
let fs: VfsAdapter;
let calls: Array<{ tool: string; args: readonly string[] }>;

const runner: ToolRunner = async (tool, args) => {
  calls.push({ tool: tool.split('/').pop() as string, args });
  if (tool.endsWith('/link')) await vfs.writeFile(args[1] as string, '\0asm');
  return { exitCode: 0, stdout: '', stderr: '' };
};

async function write(path: string, text: string): Promise<void> {
  await vfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await vfs.writeFile(path, text);
}

async function installToolchain(targets = ['wasip1/wasm']): Promise<void> {
  await write(
    `${PKG}/package.json`,
    JSON.stringify({
      name: '@ai-ecoverse/wasm-go',
      slicc: {
        go: {
          version: 'go1.26.5',
          goroot: 'goroot',
          std: targets.map((t) => ({ target: t, dir: `goroot/pkg/${t.replace('/', '_')}` })),
        },
      },
    })
  );
  for (const t of targets) {
    for (const p of ['fmt', 'os', 'runtime'])
      await write(`${PKG}/goroot/pkg/${t.replace('/', '_')}/${p}.a`, '');
  }
}

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `go-cmd-${Math.random()}`, wipe: true });
  fs = new VfsAdapter(vfs);
  calls = [];
  await vfs.mkdir('/tmp', { recursive: true });
  await write('/w/go.mod', 'module example.com/app\n\ngo 1.22\n');
  await write('/w/main.go', 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println() }\n');
  await write('/w/lib/lib.go', 'package lib\n\nimport "os"\n\nvar X = os.Args\n');
});

function ctx(env: Record<string, string> = {}, cwd = '/w') {
  const all = { TMPDIR: '/tmp', ...env };
  return mockCommandContext({
    cwd,
    env: new Map(Object.entries(all)),
    exportedEnv: all,
    overrides: { fs },
  });
}

const go = (
  args: string[],
  env?: Record<string, string>,
  deps: GoDriverDeps = { runner },
  cwd?: string
) => runGoCommand(args, ctx(env, cwd), {}, deps);

describe('go: toolchain and target', () => {
  it('usage without a command; help; an unknown command names the ones there are', async () => {
    expect(await go([])).toMatchObject({
      exitCode: 2,
      stderr: expect.stringContaining('go <command>'),
    });
    expect(await go(['help'])).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('run '),
    });
    expect(await go(['test'])).toMatchObject({
      exitCode: 2,
      stderr: expect.stringContaining(
        "go test: unknown command (SLICC's go supports build, run, env and version)"
      ),
    });
  });

  it('without a toolchain: version and build say to install one; env still answers', async () => {
    expect(await go(['version'])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('no Go toolchain installed'),
    });
    expect(await go(['build'])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('no Go toolchain installed'),
    });
    expect((await go(['env', 'GOOS', 'GOROOT'])).stdout).toBe('wasip1\n\n');
  });

  it('version and env: the toolchain, the realm target unless GOOS / GOARCH say otherwise', async () => {
    await installToolchain();
    expect((await go(['version'])).stdout).toBe('go version go1.26.5 wasip1/wasm\n');
    expect((await go(['version'], { GOOS: 'linux', GOARCH: 'arm64' })).stdout).toBe(
      'go version go1.26.5 linux/arm64\n'
    );
    const env = (await go(['env'])).stdout;
    expect(env).toContain(`GOROOT='${PKG}/goroot'\n`);
    expect(env).toContain(`GOTOOLDIR='${PKG}/goroot/pkg/tool/wasip1_wasm'\n`);
    expect(env).toContain("GOMOD='/w/go.mod'\n");
    expect(env).toContain("CGO_ENABLED='0'\n");
    expect((await go(['env', 'GOMOD'], {}, { runner }, '/')).stdout).toBe('/dev/null\n');
    expect((await go(['env', '-json', 'GOVERSION', 'HOME'], { HOME: '/h' })).stdout).toBe(
      'go1.26.5\n/h\n'
    );
  });

  it('a target without its standard library installed is an error', async () => {
    await installToolchain();
    expect(await go(['build'], { GOOS: 'linux', GOARCH: 'amd64' })).toMatchObject({
      exitCode: 1,
      stderr: 'go: no standard library for linux/amd64 (go1.26.5) installed\n',
    });
  });
});

describe('go build', () => {
  beforeEach(() => installToolchain(['wasip1/wasm', 'windows/amd64']));

  it('writes the main package’s executable to the cwd, executable; the scratch goes', async () => {
    const r = await go(['build']);
    expect(r).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(calls.map((c) => c.tool)).toEqual(['compile', 'link']);
    expect(calls[1]?.args[1]).toBe('/w/app');
    expect(((await vfs.stat('/w/app')).mode ?? 0) & 0o111).not.toBe(0);
    expect((await vfs.readDir('/tmp')).map((e) => e.name)).toEqual([]);
    expect(calls[0]?.args[3]).toBe('main');
  });

  it('-o names the file, or (ending in / or an existing directory) where it goes; windows adds .exe', async () => {
    await go(['build', '-o', 'out/hello.wasm', '.']);
    expect(calls.at(-1)?.args[1]).toBe('/w/out/hello.wasm');
    await vfs.mkdir('/w/bin', { recursive: true });
    await go(['build', '-o', 'bin']);
    expect(calls.at(-1)?.args[1]).toBe('/w/bin/app');
    await go(['build', '-o=dist/']);
    expect(calls.at(-1)?.args[1]).toBe('/w/dist/app');
    await go(['build'], { GOOS: 'windows', GOARCH: 'amd64' });
    expect(calls.at(-1)?.args[1]).toBe('/w/app.exe');
  });

  it('a library package compiles, links nothing; -o for it, or for several, is an error', async () => {
    expect(await go(['build', './lib'])).toMatchObject({ exitCode: 0 });
    expect(calls.map((c) => c.tool)).toEqual(['compile']);
    expect(await go(['build', '-o', 'x', './lib'])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('not a main package'),
    });
    expect(await go(['build', '-o', 'x', '.', './lib'])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('several packages'),
    });
    await vfs.mkdir('/w/bin', { recursive: true });
    calls = [];
    expect(await go(['build', '-o', 'bin/', './...'])).toMatchObject({ exitCode: 0 });
    expect(calls.filter((c) => c.tool === 'link').map((c) => c.args[1])).toEqual(['/w/bin/app']);
  });

  it('-v lists packages, -x the commands; a compile error is go’s', async () => {
    const v = await go(['build', '-v', '-x', '-a', '-trimpath']);
    expect(v.stderr).toMatch(/^example\.com\/app\n.*\/compile -o /m);
    const failing: ToolRunner = async () => ({
      exitCode: 2,
      stdout: '',
      stderr: '/w/main.go:5:15: undefined: y\n',
    });
    expect(await go(['build'], {}, { runner: failing })).toEqual({
      stdout: '',
      stderr: '# example.com/app\n./main.go:5:15: undefined: y\n',
      exitCode: 1,
    });
    expect((await vfs.readDir('/tmp')).map((e) => e.name)).toEqual([]);
  });
});

describe('go run', () => {
  beforeEach(() => installToolchain(['wasip1/wasm', 'linux/amd64']));

  it('builds into the scratch and runs it with the arguments; a failure is `exit status N`', async () => {
    const runs: string[][] = [];
    const deps = (exitCode: number): GoDriverDeps => ({
      runner,
      runProgram: async (argv) => {
        runs.push(argv);
        return { stdout: 'out\n', stderr: '', exitCode };
      },
    });
    expect(await go(['run', '.', 'a', '-b'], {}, deps(0))).toMatchObject({
      exitCode: 0,
      stdout: 'out\n',
    });
    expect(runs[0]?.slice(1)).toEqual(['a', '-b']);
    expect(runs[0]?.[0]).toMatch(/^\/tmp\/go-build\w+\/exe\/app$/);
    expect(await go(['run', 'main.go', 'x'], {}, deps(3))).toEqual({
      stdout: 'out\n',
      stderr: 'exit status 3\n',
      exitCode: 1,
    });
    expect(runs[1]?.slice(1)).toEqual(['x']);
    expect((await vfs.readDir('/tmp')).map((e) => e.name)).toEqual([]);
  });

  it('only wasip1 runs here; a library is not a program; something must be named', async () => {
    expect(await go(['run', '.'], { GOOS: 'linux', GOARCH: 'amd64' })).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('cannot run linux/amd64 programs here'),
    });
    expect(await go(['run', './lib'])).toMatchObject({
      exitCode: 1,
      stderr: 'package example.com/app/lib is not a main package\n',
    });
    expect(await go(['run'])).toMatchObject({ exitCode: 1, stderr: 'go: no go files listed\n' });
  });
});

describe('build flags', () => {
  it('values inline or next, -- ends them; refused and unknown flags say so', () => {
    expect(
      parseBuildFlags([
        '-o',
        'x',
        '-tags=a,b',
        '-gcflags',
        'all=-N -l',
        "-ldflags=-X 'main.v=1'",
        '-v',
        '--',
        '-z',
      ])
    ).toEqual({
      flags: {
        output: 'x',
        tags: ['a', 'b'],
        gcflags: ['-N', '-l'],
        ldflags: ['-X', 'main.v=1'],
        verbose: true,
      },
      rest: ['-z'],
    });
    expect(parseBuildFlags(['-mod=mod', '.', 'arg']).rest).toEqual(['.', 'arg']);
    expect(() => parseBuildFlags(['-race'])).toThrow("go: -race is not supported by SLICC's go");
    expect(() => parseBuildFlags(['-buildmode=c-shared'])).toThrow(/not supported/);
    expect(() => parseBuildFlags(['-frobnicate'])).toThrow('go: unknown flag -frobnicate');
    expect(() => parseBuildFlags(['-o'])).toThrow('go: flag needs an argument: -o');
  });

  it('a bad flag through the command is exit 1 with go’s message', async () => {
    await installToolchain();
    expect(await go(['build', '-race'])).toMatchObject({
      exitCode: 1,
      stderr: "go: -race is not supported by SLICC's go\n",
    });
  });
});

describe('the go command', () => {
  it('loads the driver on first use', async () => {
    const cmd = createGoCommand();
    expect(cmd.name).toBe('go');
    const r = await cmd.execute(['version'], ctx());
    expect(r).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('no Go toolchain installed'),
    });
  });
});
