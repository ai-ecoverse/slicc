/**
 * Planning a Go build (#3530 phase 5e): the module, which packages and
 * files, their order; the toolchain packages' manifests; the compile and
 * link steps. Over an in-memory filesystem and a recording tool runner —
 * the real toolchain runs in `../../../kernel/wasm-realm/go-driver-realm.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  build,
  exeName,
  toolEnv,
} from '../../../../src/shell/supplemental-commands/go/go-build.js';
import {
  findModule,
  GoError,
  type GoFs,
  GoPlanner,
  normalize,
  shown,
} from '../../../../src/shell/supplemental-commands/go/go-plan.js';
import {
  goOf,
  scanGo,
  stdArchives,
  toolPath,
} from '../../../../src/shell/supplemental-commands/go/go-toolchain.js';

/** A filesystem of `files` (path → text) and the directories they imply. */
export function memFs(files: Record<string, string>): GoFs & { files: Record<string, string> } {
  const dirs = new Set<string>(['/']);
  for (const f of Object.keys(files)) {
    for (let d = f.slice(0, f.lastIndexOf('/')); d; d = d.slice(0, d.lastIndexOf('/'))) dirs.add(d);
  }
  return {
    files,
    readText: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p] as string;
    },
    readdir: async (p) => {
      const prefix = p === '/' ? '/' : `${p}/`;
      const names = new Map<string, boolean>();
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const i = rest.indexOf('/');
        names.set(i < 0 ? rest : rest.slice(0, i), i >= 0);
      }
      return [...names].sort().map(([name, isDir]) => ({ name, isDir }));
    },
    exists: async (p) => p in files || dirs.has(p),
  };
}

const TARGET = { goos: 'wasip1', goarch: 'wasm', version: 'go1.26.5' };
const STD = new Set(['fmt', 'os', 'strings', 'errors']);

const MODULE = {
  '/w/go.mod': 'module example.com/app\n\ngo 1.22\n',
  '/w/main.go':
    'package main\n\nimport (\n\t"fmt"\n\t"example.com/app/lib"\n)\n\nfunc main() { fmt.Println(lib.X) }\n',
  '/w/lib/lib.go': 'package lib\n\nimport "example.com/app/lib/deep"\n\nvar X = deep.Y\n',
  '/w/lib/lib_test.go': 'package lib\n\nimport "testing"\n',
  '/w/lib/lib_linux.go': 'package lib\n\nimport "golang.org/x/sys/unix"\n',
  '/w/lib/deep/deep.go': 'package deep\n\nimport "strings"\n\nvar Y = strings.ToUpper("y")\n',
  '/w/lib/deep/other.go': '//go:build !wasip1\n\npackage deep\n\nimport "net"\n',
  '/w/lib/deep/notes.txt': 'not go',
};

async function planOf(files: Record<string, string>, args: string[], cwd = '/w') {
  const fs = memFs(files);
  const module = await findModule(fs, cwd);
  return new GoPlanner(fs, TARGET, STD, module, cwd).plan(args);
}

describe('GoPlanner', () => {
  it('the module, the main package, and what it imports from the module, dependencies first', async () => {
    const plan = await planOf(MODULE, []);
    expect(plan.module).toMatchObject({ dir: '/w', module: 'example.com/app', goVersion: '1.22' });
    expect(plan.packages.map((p) => [p.path, p.name, p.files])).toEqual([
      ['example.com/app/lib/deep', 'deep', ['/w/lib/deep/deep.go']],
      ['example.com/app/lib', 'lib', ['/w/lib/lib.go']],
      ['example.com/app', 'main', ['/w/main.go']],
    ]);
    expect(plan.roots.map((p) => p.path)).toEqual(['example.com/app']);
    expect(plan.packages[2]?.imports).toEqual(['fmt', 'example.com/app/lib']);
  });

  it('from a subdirectory; by import path; ./... names every package beneath', async () => {
    const sub = await planOf(MODULE, ['..'], '/w/lib');
    expect(sub.roots.map((p) => p.path)).toEqual(['example.com/app']);
    const byPath = await planOf(MODULE, ['example.com/app/lib']);
    expect(byPath.roots.map((p) => p.path)).toEqual(['example.com/app/lib']);
    const all = await planOf(
      { ...MODULE, '/w/testdata/x.go': 'package x\n', '/w/_old/y.go': 'package y\n' },
      ['./...']
    );
    expect(all.roots.map((p) => p.path).sort()).toEqual([
      'example.com/app',
      'example.com/app/lib',
      'example.com/app/lib/deep',
    ]);
  });

  it('.go files on the command line are one package, command-line-arguments', async () => {
    const plan = await planOf(
      { '/t/hello.go': 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println() }\n' },
      ['hello.go'],
      '/t'
    );
    expect(plan.module).toBeUndefined();
    expect(plan.roots.map((p) => [p.path, p.files])).toEqual([
      ['command-line-arguments', ['/t/hello.go']],
    ]);
    await expect(planOf(MODULE, ['main.go', '.'])).rejects.toThrow(/cannot mix/);
    await expect(planOf(MODULE, ['missing.go'])).rejects.toThrow('go: no such file: ./missing.go');
    await expect(
      planOf({ '/a/x.go': 'package main\n', '/b/y.go': 'package main\n' }, ['/a/x.go', '/b/y.go'])
    ).rejects.toThrow(/one directory/);
  });

  it('says what it does not build: cgo, embed, assembly, other modules, std the target lacks', async () => {
    const fail = (files: Record<string, string>, args: string[] = []) =>
      planOf({ '/w/go.mod': 'module m\n', ...files }, args);
    await expect(fail({ '/w/a.go': 'package main\n\nimport "C"\n' })).rejects.toThrow(
      './a.go:3:8: import "C": cgo is not supported'
    );
    await expect(
      fail({ '/w/a.go': 'package main\n\n//go:embed f\nvar f string\n' })
    ).rejects.toThrow('./a.go:3: //go:embed is not supported');
    await expect(fail({ '/w/a.go': 'package main\n', '/w/a_wasm.s': '' })).rejects.toThrow(
      /non-Go source files/
    );
    // Assembly for another target is no obstacle.
    await expect(fail({ '/w/a.go': 'package main\n', '/w/a_amd64.s': '' })).resolves.toBeDefined();
    await expect(fail({ '/w/a.go': 'package main\n\nimport "github.com/x/y"\n' })).rejects.toThrow(
      './a.go:3:8: package github.com/x/y is not in std or in module m'
    );
    await expect(fail({ '/w/a.go': 'package main\n\nimport "net"\n' })).rejects.toThrow(
      './a.go:3:8: package net is not in std for wasip1/wasm'
    );
    await expect(fail({ '/w/a.go': 'package main\n\nimport "unsafe"\n' })).resolves.toBeDefined();
  });

  it('packages that cannot be: none, excluded, two names, a cycle, outside the module', async () => {
    const fail = (files: Record<string, string>, args: string[] = [], cwd = '/w') =>
      planOf({ '/w/go.mod': 'module m\n', ...files }, args, cwd);
    await expect(fail({ '/w/README': '' })).rejects.toThrow('package m: no Go files in /w');
    await expect(fail({ '/w/a_linux.go': 'package main\n' })).rejects.toThrow(
      'build constraints exclude all Go files in /w'
    );
    await expect(fail({ '/w/a.go': '//go:build linux\n\npackage main\n' })).rejects.toThrow(
      'build constraints exclude all Go files'
    );
    await expect(
      fail({ '/w/a.go': 'package main\n', '/w/b.go': 'package other\n' })
    ).rejects.toThrow('found packages main and other in /w');
    await expect(
      fail({
        '/w/a.go': 'package main\n\nimport "m/b"\n',
        '/w/b/b.go': 'package b\n\nimport "m/c"\n',
        '/w/c/c.go': 'package c\n\nimport "m/b"\n',
      })
    ).rejects.toThrow('package m/b: import cycle not allowed');
    await expect(fail({ '/w/a.go': 'package main\n\nimport "m/gone"\n' })).rejects.toThrow(
      'package m/gone: directory ./gone does not exist'
    );
    await expect(fail({ '/w/a.go': 'package main\n' }, ['/elsewhere'])).rejects.toThrow(
      'outside main module'
    );
    await expect(fail({ '/w/a.go': 'package main\n' }, ['fmt'])).rejects.toThrow(/precompiled/);
    await expect(fail({ '/w/a.go': 'package main\n' }, ['github.com/x/y'])).rejects.toThrow(
      /not in std or in module m/
    );
    await expect(fail({ '/w/a.go': 'package main\n' }, ['./nothing/...'])).rejects.toThrow(
      /matched no packages/
    );
    await expect(fail({ '/w/a.go': '//go:build (\n\npackage main\n' })).rejects.toThrow(
      /malformed/
    );
    await expect(fail({ '/w/a.go': 'func main() {}\n' })).rejects.toThrow(
      './a.go: expected package clause'
    );
    await expect(fail({ '/w/go.mod': 'go 1.22\n' })).rejects.toThrow(/no module directive/);
    await expect(
      new GoPlanner(memFs({ '/t/a.go': 'package main\n' }), TARGET, STD, undefined, '/t').plan([])
    ).rejects.toThrow(/go.mod file not found/);
    expect(new GoError('x')).toBeInstanceOf(Error);
  });

  it('shows paths relative to the cwd, and normalizes', () => {
    expect(shown('/w/a.go', '/w')).toBe('./a.go');
    expect(shown('/w', '/w')).toBe('.');
    expect(shown('/x/a.go', '/w')).toBe('/x/a.go');
    expect(shown('/a.go', '/')).toBe('./a.go');
    expect(normalize('/a/./b/../c/')).toBe('/a/c');
  });
});

describe('toolchain packages', () => {
  it('slicc.go: a toolchain (version + goroot) and std parts; nothing leaves the package', () => {
    expect(
      goOf('/nm/go', 'go', {
        version: 'go1.26.5',
        goroot: 'goroot/',
        std: [
          { target: 'wasip1/wasm', dir: 'goroot/pkg/wasip1_wasm' },
          { target: 'linux/amd64', dir: 'std', version: 'go1.26.4' },
          { target: 'bad target', dir: 'x' },
          { target: 'linux/arm64', dir: '../escape' },
        ],
      })
    ).toEqual({
      toolchain: { pkg: 'go', goroot: '/nm/go/goroot', version: 'go1.26.5' },
      std: [
        {
          pkg: 'go',
          version: 'go1.26.5',
          target: 'wasip1/wasm',
          dir: '/nm/go/goroot/pkg/wasip1_wasm',
        },
        { pkg: 'go', version: 'go1.26.4', target: 'linux/amd64', dir: '/nm/go/std' },
      ],
    });
    expect(goOf('/nm/go', 'go', { version: 'go1.26.5' }).toolchain?.goroot).toBe('/nm/go');
    expect(goOf('/nm/go', 'go', { version: 'go1.26.5', goroot: '/abs' }).toolchain).toBeUndefined();
    expect(goOf('/nm/s', 's', { std: [{ target: 'wasip1/wasm', dir: 'd' }] })).toEqual({ std: [] });
    expect(goOf('/nm/x', 'x', undefined)).toEqual({ std: [] });
  });

  it('scans the installed packages, and indexes a target’s archives across parts', async () => {
    const fs = memFs({
      '/nm/@ai-ecoverse/go/package.json': JSON.stringify({
        name: '@ai-ecoverse/go',
        slicc: {
          go: {
            version: 'go1.26.5',
            goroot: 'r',
            std: [{ target: 'wasip1/wasm', dir: 'r/pkg/w' }],
          },
        },
      }),
      '/nm/@ai-ecoverse/go/r/pkg/w/fmt.a': '',
      '/nm/@ai-ecoverse/go/r/pkg/w/internal/abi.a': '',
      '/nm/@ai-ecoverse/go-net/package.json': JSON.stringify({
        slicc: { go: { std: [{ version: 'go1.26.5', target: 'wasip1/wasm', dir: 'w' }] } },
      }),
      '/nm/@ai-ecoverse/go-net/w/net.a': '',
      '/nm/@ai-ecoverse/go-net/w/fmt.a': '',
      '/nm/@ai-ecoverse/go-net/w/README': '',
      '/nm/plain/package.json': '{ not json',
      '/nm/README.md': '',
    });
    const { toolchains, std } = await scanGo(fs, '/nm');
    expect(toolchains).toEqual([
      { pkg: '@ai-ecoverse/go', goroot: '/nm/@ai-ecoverse/go/r', version: 'go1.26.5' },
    ]);
    expect(std.map((s) => s.pkg)).toEqual(['@ai-ecoverse/go', '@ai-ecoverse/go-net']);
    const archives = await stdArchives(fs, std, 'go1.26.5', 'wasip1/wasm');
    expect([...archives]).toEqual([
      ['fmt', '/nm/@ai-ecoverse/go/r/pkg/w/fmt.a'],
      ['internal/abi', '/nm/@ai-ecoverse/go/r/pkg/w/internal/abi.a'],
      ['net', '/nm/@ai-ecoverse/go-net/w/net.a'],
    ]);
    expect((await stdArchives(fs, std, 'go1.25.0', 'wasip1/wasm')).size).toBe(0);
    expect(await scanGo(fs, '/none')).toEqual({ toolchains: [], std: [] });
    expect(toolPath(toolchains[0] as never, 'link')).toBe(
      '/nm/@ai-ecoverse/go/r/pkg/tool/wasip1_wasm/link'
    );
  });
});

describe('build', () => {
  const toolchain = { pkg: 'go', goroot: '/g', version: 'go1.26.5' };

  it('compiles each package against its imports, then links the main package against everything', async () => {
    const plan = await planOf(MODULE, []);
    const written: Record<string, string> = {};
    const calls: Array<{
      tool: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
    }> = [];
    const log: string[] = [];
    await build(
      plan,
      { writeFile: async (p, c) => void (written[p] = c), mkdir: async () => {} },
      async (tool, args, env) => {
        calls.push({ tool, args, env });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      {
        toolchain,
        goos: 'wasip1',
        goarch: 'wasm',
        std: new Map([
          ['fmt', '/std/fmt.a'],
          ['strings', '/std/strings.a'],
        ]),
        work: '/tmp/wk',
        cwd: '/w',
        outputs: new Map([['example.com/app', '/w/app']]),
        gcflags: ['-N'],
        ldflags: ['-s'],
        verbose: true,
        trace: true,
        log: (t) => log.push(t),
      }
    );
    expect(calls.map((c) => c.tool.split('/').pop())).toEqual([
      'compile',
      'compile',
      'compile',
      'link',
    ]);
    expect(calls[0]?.args).toEqual([
      '-o',
      '/tmp/wk/b001/_pkg_.a',
      '-p',
      'example.com/app/lib/deep',
      '-lang=go1.22',
      '-complete',
      '-importcfg',
      '/tmp/wk/b001/importcfg',
      '-N',
      '-pack',
      '/w/lib/deep/deep.go',
    ]);
    expect(calls[2]?.args.slice(2, 4)).toEqual(['-p', 'main']);
    expect(calls[3]?.args).toEqual([
      '-o',
      '/w/app',
      '-importcfg',
      '/tmp/wk/importcfg.link',
      '-buildmode=exe',
      '-s',
      '/tmp/wk/b003/_pkg_.a',
    ]);
    expect(calls[0]?.env).toEqual({
      GOOS: 'wasip1',
      GOARCH: 'wasm',
      GOROOT: '/g',
      CGO_ENABLED: '0',
    });
    expect(written['/tmp/wk/b003/importcfg']).toBe(
      '# import config\npackagefile fmt=/std/fmt.a\npackagefile example.com/app/lib=/tmp/wk/b002/_pkg_.a\n'
    );
    expect(written['/tmp/wk/importcfg.link']).toContain('packagefile strings=/std/strings.a\n');
    expect(log.filter((l) => !l.startsWith('/g/'))).toEqual([
      'example.com/app/lib/deep\n',
      'example.com/app/lib\n',
      'example.com/app\n',
    ]);
    expect(toolEnv({ toolchain, goos: 'linux', goarch: 'arm64' }).GOOS).toBe('linux');
  });

  it("a tool's failure is go's: `# pkg`, paths relative to the cwd", async () => {
    const plan = await planOf(MODULE, []);
    const log: string[] = [];
    await expect(
      build(
        plan,
        { writeFile: async () => {}, mkdir: async () => {} },
        async () => ({ exitCode: 1, stdout: '', stderr: '/w/lib/deep/deep.go:5:9: undefined: x' }),
        {
          toolchain,
          goos: 'wasip1',
          goarch: 'wasm',
          std: new Map(),
          work: '/tmp/wk',
          cwd: '/w',
          outputs: new Map(),
          log: (t) => log.push(t),
        }
      )
    ).rejects.toBeInstanceOf(GoError);
    expect(log).toEqual(['# example.com/app/lib/deep\n./lib/deep/deep.go:5:9: undefined: x\n']);
  });

  it('names executables as go does', () => {
    const pkg = (path: string, files = ['/w/x.go']) => ({
      path,
      dir: '/w',
      name: 'main',
      files,
      imports: [],
    });
    expect(exeName(pkg('example.com/app'), 'wasip1')).toBe('app');
    expect(exeName(pkg('example.com/tool/v2'), 'linux')).toBe('tool');
    expect(exeName(pkg('example.com/app'), 'windows')).toBe('app.exe');
    expect(exeName(pkg('command-line-arguments', ['/t/hello.go']), 'wasip1')).toBe('hello');
  });
});
