/**
 * SLICC's `go` driver over a real Go toolchain (#3530 phase 5e): the
 * toolchain's `compile` and `link` (WASI programs) run as realm processes in
 * node workers, against the precompiled standard library for wasip1/wasm,
 * and what they build runs in the realm too.
 *
 * The toolchain is not a fixture: point SLICC_GO_ROOT at a GOROOT laid out
 * as the contract says (`pkg/tool/wasip1_wasm/{compile,link}`,
 * `pkg/wasip1_wasm/<import path>.a`; `docs/shell-reference.md`, "Go") —
 * the reference `build.sh` makes one from the host's Go — to run this.
 */
import 'fake-indexeddb/auto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { GLOBAL_NODE_MODULES } from '../../../src/shell/ipk/global-prefix.js';
import { runGoCommand } from '../../../src/shell/supplemental-commands/go/go-driver.js';
import { runWasmCommand } from '../../../src/shell/supplemental-commands/wasm/run.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { mockCommandContext } from '../../shell/helpers/mock-command-context.js';
import { bundleProcessWorker, nodeWorker } from './helpers/node-wasm-process.js';

const GOROOT = process.env.SLICC_GO_ROOT;
const HAVE = Boolean(GOROOT && existsSync(`${GOROOT}/pkg/tool/wasip1_wasm/compile`));
const PKG = `${GLOBAL_NODE_MODULES}/@ai-ecoverse/wasm-go`;
const VERSION = HAVE ? readFileSync(`${GOROOT}/VERSION`, 'utf8').split('\n')[0] : '';

const workerFile = vi.hoisted(() => ({ path: '' }));
vi.mock('../../../src/kernel/wasm-realm/host.js', async (importOriginal) => {
  const host = await importOriginal<typeof import('../../../src/kernel/wasm-realm/host.js')>();
  return {
    ...host,
    spawnWasmProcess: (opts: Parameters<typeof host.spawnWasmProcess>[0]) =>
      host.spawnWasmProcess({ createWorker: () => nodeWorker(workerFile.path), ...opts }),
  };
});

let worker: { file: string; dispose(): void } | undefined;
let fs: VfsAdapter;
let vfs: VirtualFS;

function tree(root: string, rel = ''): string[] {
  return readdirSync(join(root, rel)).flatMap((name) => {
    const path = join(rel, name);
    return statSync(join(root, path)).isDirectory() ? tree(root, path) : [path];
  });
}

async function write(path: string, text: string): Promise<void> {
  await vfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await vfs.writeFile(path, text);
}

beforeAll(async () => {
  if (!HAVE) return;
  vfs = await VirtualFS.create({ dbName: `go-driver-${Math.random()}`, wipe: true });
  // The toolchain package, as `ipk add -g` would leave it.
  await write(
    `${PKG}/package.json`,
    JSON.stringify({
      name: '@ai-ecoverse/wasm-go',
      slicc: {
        go: {
          version: VERSION,
          goroot: 'goroot',
          std: [{ target: 'wasip1/wasm', dir: 'goroot/pkg/wasip1_wasm' }],
        },
      },
    })
  );
  for (const tool of ['compile', 'link']) {
    await vfs.mkdir(`${PKG}/goroot/pkg/tool/wasip1_wasm`, { recursive: true });
    await vfs.writeFile(
      `${PKG}/goroot/pkg/tool/wasip1_wasm/${tool}`,
      readFileSync(`${GOROOT}/pkg/tool/wasip1_wasm/${tool}`)
    );
  }
  const std = `${GOROOT}/pkg/wasip1_wasm`;
  const files = tree(std);
  for (const file of files) {
    const dest = `${PKG}/goroot/pkg/wasip1_wasm/${file}`;
    await vfs.mkdir(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
    await vfs.writeFile(dest, readFileSync(join(std, file)));
  }
  await write('/home/user/hello/go.mod', 'module example.com/hello\n\ngo 1.22\n');
  await write(
    '/home/user/hello/main.go',
    'package main\n\nimport (\n\t"fmt"\n\t"os"\n\t"strings"\n)\n\nfunc main() {\n\tfmt.Println("hello from", strings.ToUpper("wasip1"), os.Args[1:])\n\tif len(os.Args) > 2 {\n\t\tos.Exit(3)\n\t}\n}\n'
  );
  await write('/home/user/two/go.mod', 'module example.com/two\n\ngo 1.22\n');
  await write(
    '/home/user/two/main.go',
    'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/two/greet"\n)\n\nfunc main() { fmt.Println(greet.Hello("realm")) }\n'
  );
  await write(
    '/home/user/two/greet/greet.go',
    'package greet\n\nimport "strconv"\n\n// Hello greets who.\nfunc Hello(who string) string { return "hello, " + who + " #" + strconv.Itoa(len(who)) }\n'
  );
  await write(
    '/home/user/two/greet/greet_windows.go',
    'package greet\n\nfunc broken() { this does not compile }\n'
  );
  await write('/home/user/bad/go.mod', 'module example.com/bad\n\ngo 1.22\n');
  await write('/home/user/bad/main.go', 'package main\n\nfunc main() {\n\tnope()\n}\n');
  await write('/home/user/cgo/go.mod', 'module example.com/cgo\n\ngo 1.22\n');
  await write(
    '/home/user/cgo/main.go',
    'package main\n\n// int two() { return 2; }\nimport "C"\n\nfunc main() {}\n'
  );
  await write('/home/user/dep/go.mod', 'module example.com/dep\n\ngo 1.22\n');
  await write(
    '/home/user/dep/main.go',
    'package main\n\nimport "github.com/google/uuid"\n\nfunc main() { _ = uuid.New() }\n'
  );
  fs = new VfsAdapter(vfs);
  worker = await bundleProcessWorker();
  workerFile.path = worker.file;
}, 120_000);

afterAll(() => {
  worker?.dispose();
});

function ctx(cwd: string, env: Record<string, string> = {}) {
  const all = { HOME: '/home/user', PATH: '/usr/bin', TMPDIR: '/tmp', ...env };
  return mockCommandContext({
    cwd,
    env: new Map(Object.entries(all)),
    exportedEnv: all,
    overrides: { fs },
  });
}

const go = (args: string[], cwd: string, env?: Record<string, string>) =>
  runGoCommand(args, ctx(cwd, env));

describe.skipIf(!HAVE)('go (the driver) over a real toolchain', () => {
  it('go version and go env name the toolchain and the realm target', async () => {
    const v = await go(['version'], '/home/user/hello');
    expect(v).toMatchObject({ exitCode: 0, stdout: `go version ${VERSION} wasip1/wasm\n` });
    const e = await go(['env', 'GOOS', 'GOARCH', 'GOROOT', 'CGO_ENABLED'], '/home/user/hello');
    expect(e.stdout).toBe(`wasip1\nwasm\n${PKG}/goroot\n0\n`);
  });

  it('go build -o hello.wasm . writes an executable that runs in the realm', async () => {
    const b = await go(['build', '-o', 'hello.wasm', '.'], '/home/user/hello');
    expect(b.stderr).toBe('');
    expect(b.exitCode).toBe(0);
    const st = await vfs.stat('/home/user/hello/hello.wasm');
    expect((st.mode ?? 0) & 0o111).not.toBe(0);
    const r = await runWasmCommand(['./hello.wasm', 'a'], ctx('/home/user/hello'));
    expect(r).toMatchObject({ exitCode: 0, stdout: 'hello from WASIP1 [a]\n' });
    // No scratch left behind.
    expect((await vfs.readDir('/tmp')).filter((e) => e.name.startsWith('go-build'))).toEqual([]);
  }, 120_000);

  it("go run . passes the arguments; a failing program's status is go's `exit status N`", async () => {
    const ok = await go(['run', '.', 'x', 'y'], '/home/user/hello');
    expect(ok).toMatchObject({ exitCode: 1, stderr: 'exit status 3\n' });
    expect(ok.stdout).toBe('hello from WASIP1 [x y]\n');
    const one = await go(['run', '.', 'z'], '/home/user/hello');
    expect(one).toMatchObject({ exitCode: 0, stdout: 'hello from WASIP1 [z]\n' });
  }, 120_000);

  it('a two-package module builds, named after the module; a _windows file stays out', async () => {
    const b = await go(['build', '-v'], '/home/user/two');
    expect(b).toMatchObject({ exitCode: 0, stderr: 'example.com/two/greet\nexample.com/two\n' });
    const r = await runWasmCommand(['./two'], ctx('/home/user/two'));
    expect(r).toMatchObject({ exitCode: 0, stdout: 'hello, realm #5\n' });
  }, 120_000);

  it('a compile error, cgo and a third-party import each say what went wrong', async () => {
    const bad = await go(['build'], '/home/user/bad');
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toMatch(/^# example\.com\/bad\n\.\/main\.go:4:2: undefined: nope\n/);
    const cgo = await go(['build'], '/home/user/cgo');
    expect(cgo).toMatchObject({ exitCode: 1 });
    expect(cgo.stderr).toContain('./main.go:4:8: import "C": cgo is not supported');
    const dep = await go(['run', '.'], '/home/user/dep');
    expect(dep).toMatchObject({ exitCode: 1 });
    expect(dep.stderr).toContain(
      './main.go:3:8: package github.com/google/uuid is not in std or in module example.com/dep'
    );
  }, 120_000);
});
