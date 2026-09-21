import type { IFileSystem } from 'just-bash';
import { Bash, getCommandNames, getNetworkCommandNames } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
import { resetTypeScriptForTests } from '../../../src/shell/supplemental-commands/shared.js';
import {
  _resetTstHarnessForTests,
  createTestCommand,
  expandBraces,
  globToRegExp,
  hasTstFailureMarker,
  parseTestArgs,
  resolveTestFiles,
  TST_COMMAND_NAME,
} from '../../../src/shell/supplemental-commands/test-command.js';

/**
 * Interpreter-dispatch names that just-bash never looks up in
 * `customCommands`. POSIX `test` / `[` are the load-bearing ones
 * (#3122); `getCommandNames()` does not list them.
 */
const JUST_BASH_UNREACHABLE_NAMES: ReadonlySet<string> = new Set([
  'test',
  '[',
  '[[',
  'cd',
  'export',
  'unset',
  'eval',
  'source',
  '.',
  'true',
  'false',
  'help',
  'type',
  'command',
  'builtin',
  'hash',
  'exit',
  'return',
  'break',
  'continue',
  'shift',
  'set',
  'shopt',
  'local',
  'declare',
  'readonly',
  'let',
  'read',
  'getopts',
  'wait',
  'exec',
]);

function createMockCtx(
  overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string; stdin: string }> = {}
): Parameters<ReturnType<typeof createTestCommand>['execute']>[1] {
  const fileStore = new Map<string, string>();
  const dirSet = new Set<string>(['/', '/workspace']);
  const ensureDirs = (p: string): void => {
    const parts = p.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc += '/' + parts[i];
      dirSet.add(acc);
    }
  };
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) =>
      path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`,
    exists: vi.fn().mockImplementation(async (p: string) => fileStore.has(p) || dirSet.has(p)),
    readFile: vi.fn().mockImplementation(async (p: string) => {
      const v = fileStore.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    }),
    writeFile: vi.fn().mockImplementation(async (p: string, content: string | Uint8Array) => {
      ensureDirs(p);
      fileStore.set(p, typeof content === 'string' ? content : new TextDecoder().decode(content));
    }),
    readdir: vi.fn().mockImplementation(async (p: string) => {
      const norm = p === '/' ? '' : p;
      const prefix = `${norm}/`;
      const names = new Set<string>();
      for (const f of fileStore.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      for (const d of dirSet) {
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        if (rest.length === 0 || rest.includes('/')) continue;
        names.add(rest);
      }
      return [...names];
    }),
    stat: vi.fn().mockImplementation(async (p: string) => {
      if (fileStore.has(p)) {
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: 0o644,
          size: fileStore.get(p)!.length,
          mtime: new Date(),
        };
      }
      if (dirSet.has(p)) {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: 0o755,
          size: 0,
          mtime: new Date(),
        };
      }
      throw new Error(`ENOENT: ${p}`);
    }),
    ...overrides.fs,
  };
  return {
    fs: fs as IFileSystem,
    cwd: overrides.cwd ?? '/workspace',
    env: new Map<string, string>(),
    stdin: overrides.stdin ?? '',
  } as ReturnType<typeof createMockCtx> & {
    fs: IFileSystem;
    cwd: string;
    env: Map<string, string>;
    stdin: string;
  };
}

describe('parseTestArgs', () => {
  it('defaults to **/*.test.{js,ts} and tap reporter', () => {
    const parsed = parseTestArgs([]);
    expect(parsed.globs).toEqual(['**/*.test.{js,ts}']);
    expect(parsed.reporter).toBe('tap');
  });

  it('accepts --reporter=spec and a custom glob', () => {
    const parsed = parseTestArgs(['--reporter=spec', 'src/**/*.spec.js']);
    expect(parsed.reporter).toBe('spec');
    expect(parsed.globs).toEqual(['src/**/*.spec.js']);
  });

  it('accepts --reporter spec as separate args', () => {
    expect(parseTestArgs(['--reporter', 'spec']).reporter).toBe('spec');
  });

  it('rejects unknown reporters and unknown flags', () => {
    expect(() => parseTestArgs(['--reporter=junit'])).toThrow(/reporter/);
    expect(() => parseTestArgs(['--unknown'])).toThrow(/unknown option/);
  });

  it('accepts --coverage and --coverage-dir', () => {
    expect(parseTestArgs([]).coverage).toBe(false);
    expect(parseTestArgs(['--coverage']).coverage).toBe(true);
    const parsed = parseTestArgs(['--coverage-dir=/tmp/cov', 'a.test.js']);
    expect(parsed.coverage).toBe(true);
    expect(parsed.coverageDir).toBe('/tmp/cov');
    expect(parsed.globs).toEqual(['a.test.js']);
  });
});

describe('expandBraces / globToRegExp', () => {
  it('expands {js,ts}', () => {
    expect(expandBraces('a.{js,ts}')).toEqual(['a.js', 'a.ts']);
  });

  it('matches **/*.test.js across segments', () => {
    const re = globToRegExp('**/*.test.js');
    expect(re.test('foo.test.js')).toBe(true);
    expect(re.test('a/b/foo.test.js')).toBe(true);
    expect(re.test('foo.js')).toBe(false);
  });
});

describe('hasTstFailureMarker', () => {
  // Regression (PR #1085 EXT6): a failing test must propagate non-zero
  // REGARDLESS of reporter, even if the realm exit code is swallowed at
  // the realm-host boundary. tst emits `# fail N` for both reporters; the
  // tap reporter additionally emits `not ok` lines.
  it('detects the tap reporter failure markers', () => {
    const tap = 'ok 1 - a\nnot ok 2 - b\n1..2\n# tests 2\n# pass 1\n# fail 1\n';
    expect(hasTstFailureMarker(tap)).toBe(true);
  });

  it('detects the pretty (spec) reporter failure summary', () => {
    // tst's pretty summary wraps `# fail N` in ANSI color codes; the
    // substring check still matches.
    const pretty = '\u001b[31m× 1 — nope\u001b[0m\n───\n# total 1\n\u001b[31m# fail 1\u001b[0m\n';
    expect(hasTstFailureMarker(pretty)).toBe(true);
  });

  it('returns false for all-passing output', () => {
    const tap = 'ok 1 - a\nok 2 - b\n1..2\n# tests 2\n# pass 2\n# assertions 2\n';
    expect(hasTstFailureMarker(tap)).toBe(false);
  });

  it('does not false-positive on a passing test whose name contains "not ok"', () => {
    const tap = 'ok 1 - rejects when not okay\n1..1\n# tests 1\n# pass 1\n';
    expect(hasTstFailureMarker(tap)).toBe(false);
  });
});

describe('resolveTestFiles', () => {
  it('walks the VFS and returns absolute matching paths', async () => {
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/a.test.js', '');
    await ctx.fs.writeFile('/workspace/sub/b.test.ts', '');
    await ctx.fs.writeFile('/workspace/sub/notatest.js', '');
    const files = await resolveTestFiles(ctx.fs, '/workspace', ['**/*.test.{js,ts}']);
    expect(files).toEqual(['/workspace/a.test.js', '/workspace/sub/b.test.ts']);
  });
});

describe('createTestCommand (end-to-end via realm)', () => {
  it('registers as tst, which is not a just-bash builtin (#3122)', () => {
    const cmd = createTestCommand();
    expect(cmd.name).toBe(TST_COMMAND_NAME);
    expect(cmd.name).toBe('tst');
    expect(getCommandNames()).not.toContain('tst');
    expect(getNetworkCommandNames()).not.toContain('tst');
    const names = createSupplementalCommands().map((c) => c.name);
    expect(names).toContain('tst');
    expect(names).not.toContain('test');
  });

  it('does not register a name just-bash will silently swallow', () => {
    expect(JUST_BASH_UNREACHABLE_NAMES.has('test')).toBe(true);
    expect(JUST_BASH_UNREACHABLE_NAMES.has('[')).toBe(true);
    expect(JUST_BASH_UNREACHABLE_NAMES.has('tst')).toBe(false);
    const names = createSupplementalCommands().map((c) => c.name);
    expect(names.filter((n) => JUST_BASH_UNREACHABLE_NAMES.has(n))).toEqual([]);
  });

  it('is dispatched by just-bash; POSIX test stays the builtin', async () => {
    const bash = new Bash({
      files: { '/workspace/.keep': '' },
      cwd: '/workspace',
      customCommands: [createTestCommand()],
    });
    const help = await bash.exec('tst --help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('tst - run');

    const posix = await bash.exec('test --help');
    expect(posix.exitCode).toBe(0);
    expect(posix.stdout).toBe('');
    expect(posix.stderr).toBe('');
  });

  it('emits TAP for a passing fixture', async () => {
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/pass.test.js',
      `import test from 'tst';
test('one plus one', ({ is, ok }) => {
  ok(true);
  is(1 + 1, 2);
});
`
    );
    const result = await cmd.execute([], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok 1 - one plus one');
    expect(result.stdout).toContain('# pass 1');
    expect(result.stdout).not.toContain('not ok');
  }, 20_000);

  it('runs a file with one passing and one failing test and exits non-zero', async () => {
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/sample.test.js',
      `import test from 'tst';
test('arithmetic works', ({ is }) => {
  is(1 + 1, 2);
});
test('this one fails on purpose', ({ is }) => {
  is(1 + 1, 3);
});
`
    );
    const result = await cmd.execute(['sample.test.js'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('ok 1 - arithmetic works');
    expect(result.stdout).toContain('not ok 2 - this one fails on purpose');
    expect(result.stdout).toContain('# fail 1');
    expect(result.stdout).toContain('# pass 1');
  }, 20_000);

  it('exits non-zero and reports failure for a failing fixture', async () => {
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/fail.test.ts',
      `import test from 'tst';
test('intentional failure', ({ is }) => {
  is(1 + 1, 3);
});
`
    );
    const result = await cmd.execute([], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('not ok 1 - intentional failure');
    expect(result.stdout).toContain('# fail 1');
  }, 20_000);

  it('exits non-zero for an explicit single-file tap run with a throwing test', async () => {
    // Regression (PR #1085 EXT6 / F-C03): `tst fail.test.js` under the
    // default tap reporter must propagate non-zero. The per-file runner used
    // to read tst's resolved `state.failed` before a thrown test's rejection
    // had settled, so an explicit single-file tap run raced ahead and exited
    // 0 with no TAP output. The runner now drains a settle tick before
    // reading `failed`; the bare-glob and `--reporter=spec` paths were always
    // correct (extra async work let the failure record first).
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/fail.test.js',
      `import test from 'tst';
test('boom', () => {
  throw new Error('nope');
});
`
    );
    const result = await cmd.execute(['fail.test.js'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('not ok 1 - boom');
    expect(result.stdout).toContain('# fail 1');
  }, 20_000);

  it('honors --reporter=spec (tst pretty format)', async () => {
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/spec.test.js',
      `import test from 'tst';
test('spec mode', ({ ok }) => ok(true));
`
    );
    const result = await cmd.execute(['--reporter=spec'], ctx);
    expect(result.exitCode).toBe(0);
    // tst's pretty format prefixes tests with a ► marker and writes
    // a `# pass N` summary line.
    expect(result.stdout).toContain('► spec mode');
    expect(result.stdout).toContain('# pass 1');
  }, 20_000);

  it('resolves local imports (./add.js) from the entry test file', async () => {
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/add.js', `module.exports.add = (a, b) => a + b;\n`);
    await ctx.fs.writeFile(
      '/workspace/local.test.js',
      `import test from 'tst';
const { add } = require('./add.js');
test('uses local add', ({ is }) => {
  is(add(2, 3), 5);
});
`
    );
    const result = await cmd.execute([], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok 1 - uses local add');
    expect(result.stdout).toContain('# pass 1');
  }, 20_000);

  it('writes statement coverage for the entry file and a local helper', async () => {
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/add.js',
      `function add(a, b) {
  return a + b;
}
function unused(x) {
  return x;
}
module.exports = { add, unused };
`
    );
    await ctx.fs.writeFile(
      '/workspace/cov.test.js',
      `import test from 'tst';
const { add } = require('./add.js');
test('covers add, not unused', ({ is }) => {
  is(add(2, 3), 5);
});
`
    );
    const result = await cmd.execute(['--coverage', '--coverage-dir=/workspace/coverage'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok 1 - covers add, not unused');
    expect(result.stdout).not.toContain('__SLICC_COVERAGE__');
    expect(result.stdout).toMatch(/coverage statements /);
    const json = JSON.parse(await ctx.fs.readFile('/workspace/coverage/coverage.json'));
    expect(json.counts['/workspace/add.js']).toBeTruthy();
    const unusedHits = json.maps['/workspace/add.js']
      .filter((s: { line: number; id: number }) => s.line === 5)
      .map((s: { line: number; id: number }) => json.counts['/workspace/add.js'][s.id]);
    expect(unusedHits.some((n: number) => n === 0)).toBe(true);
    const lcov = await ctx.fs.readFile('/workspace/coverage/coverage.lcov');
    expect(lcov).toContain('SF:/workspace/add.js');
    expect(lcov).toContain('DA:5,0');
  }, 20_000);

  it('coverage probes survive a user binding named globalThis', async () => {
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/shadow.test.js',
      `import test from 'tst';
const globalThis = { shadowed: true };
test('still runs', ({ is }) => {
  is(globalThis.shadowed, true);
});
`
    );
    const result = await cmd.execute(
      ['--coverage', '--coverage-dir=cov-out', 'shadow.test.js'],
      ctx
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('# pass 1');
    const json = JSON.parse(await ctx.fs.readFile('/workspace/cov-out/coverage.json'));
    expect(json.counts['/workspace/shadow.test.js']).toBeTruthy();
  }, 20_000);

  it('falls through bare require(fs/path/sliccy) to the realm shim', async () => {
    // Regression: the harness used to bind the entry IIFE's `require` to
    // `__tstReq`, which only knew `tst` / `tst/assert` — so `require('fs')`
    // threw `tst: cannot require fs` even though the realm serves those
    // builtins. `__userRequire` now falls through to the realm shim.
    // Prefer async fs here: the vitest in-process realm has no sync-fs SW
    // bridge (ENOSYNC on readFileSync).
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile('/workspace/fixture.txt', 'hello-realm');
    await ctx.fs.writeFile(
      '/workspace/realm-require.test.js',
      `import test from 'tst';
const fs = require('fs');
const path = require('path');
const fmt = require('sliccy:fmt');
test('fs/path/sliccy resolve in the tst harness', async ({ is }) => {
  is(typeof fs.readFile, 'function');
  is(await fs.readFile('/workspace/fixture.txt', 'utf8'), 'hello-realm');
  is(path.join('/a', 'b'), '/a/b');
  is(typeof fmt.trunc, 'function');
  is(fmt.trunc('abcdef', 4), 'abc…');
});
`
    );
    const result = await cmd.execute(['realm-require.test.js'], ctx);
    expect(result.stderr || '').not.toMatch(/cannot require|local module not bundled/);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok 1 - fs/path/sliccy resolve in the tst harness');
    expect(result.stdout).toContain('# pass 1');
  }, 20_000);

  it('lets a local module require(path) via the same fallthrough', async () => {
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/paths.js',
      `const path = require('path');
module.exports.join = (...parts) => path.join(...parts);
`
    );
    await ctx.fs.writeFile(
      '/workspace/local-path.test.js',
      `import test from 'tst';
const { join } = require('./paths.js');
test('local dep reaches realm path', ({ is }) => {
  is(join('/workspace', 'x'), '/workspace/x');
});
`
    );
    const result = await cmd.execute(['local-path.test.js'], ctx);
    expect(result.stderr || '').not.toMatch(/cannot require|local module not bundled/);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok 1 - local dep reaches realm path');
  }, 20_000);

  it('scopes a nested local helper require via createRequire(absPath)', async () => {
    // Codex P2: inlined factories must not reuse the entry-scoped realm
    // require — a helper under /workspace/lib/ gets createRequire(absPath)
    // so nearer node_modules resolve from the helper, not the test entry.
    _resetTstHarnessForTests();
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    await ctx.fs.writeFile(
      '/workspace/lib/helper.js',
      `const path = require('path');
module.exports.join = (...parts) => path.join(...parts);
`
    );
    await ctx.fs.writeFile(
      '/workspace/scoped-local.test.js',
      `import test from 'tst';
const { join } = require('./lib/helper.js');
test('nested local helper reaches path via scoped require', ({ is }) => {
  is(join('/workspace', 'lib', 'x'), '/workspace/lib/x');
});
`
    );
    const result = await cmd.execute(['scoped-local.test.js'], ctx);
    expect(result.stderr || '').not.toMatch(/cannot require|local module not bundled/);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ok 1 - nested local helper reaches path via scoped require');
  }, 20_000);

  it('returns exit 1 when no test files match', async () => {
    const cmd = createTestCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute([], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no test files matched');
  });

  it('shows --help', async () => {
    const cmd = createTestCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tst - run');
  });

  it('surfaces the pinned TypeScript 6 install command in a browser float', async () => {
    resetTypeScriptForTests();
    vi.stubGlobal('process', undefined);
    try {
      const ctx = createMockCtx();
      await ctx.fs.writeFile('/workspace/example.test.ts', 'export {};');
      const result = await createTestCommand().execute([], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ipk add -g typescript@6.0.3');
    } finally {
      vi.unstubAllGlobals();
      resetTypeScriptForTests();
    }
  });
});
