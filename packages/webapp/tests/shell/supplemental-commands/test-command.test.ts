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
  it('detects the tap reporter failure markers', () => {
    const tap = 'ok 1 - a\nnot ok 2 - b\n1..2\n# tests 2\n# pass 1\n# fail 1\n';
    expect(hasTstFailureMarker(tap)).toBe(true);
  });

  it('detects the pretty (spec) reporter failure summary', () => {
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
