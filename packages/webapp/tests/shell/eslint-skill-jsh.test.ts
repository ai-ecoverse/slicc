/**
 * Tests for the shipped `eslint` skill script.
 *
 * The SHIPPED `packages/vfs-root/workspace/skills/eslint/eslint.jsh` is loaded
 * from the on-disk vfs-root payload and run in a real `.jsh` realm, so what is
 * covered is the file users get, not a copy.
 *
 * ESLint itself is not installed in this VFS, so the linting is stood in for by
 * a fake `exec` that answers the `node <helper> <json>` call the script makes.
 * That is the seam worth testing: everything the CLI does AROUND `Linter` lives
 * in this script — argument parsing, flat-config discovery, target expansion,
 * fix write-back, the formatters, and the exit codes — while the rules and
 * messages are ESLint's.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { unsafeBytesFromLatin1 } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { createInProcessJsRealmFactory } from '../../src/kernel/realm/realm-inprocess.js';
import { executeJshFile } from '../../src/shell/jsh-executor.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const ESLINT_JSH = resolve(repoRoot, 'packages/vfs-root/workspace/skills/eslint/eslint.jsh');
const SCRIPT_PATH = '/workspace/skills/eslint/eslint.jsh';

const source = readFileSync(ESLINT_JSH, 'utf-8');

/** Minimal in-memory `IFileSystem` with real directory semantics. */
function makeFs(files: Record<string, string>, dirs: string[] = []): IFileSystem {
  const store = new Map<string, string>(Object.entries(files));
  const directories = new Set<string>(dirs);
  for (const path of store.keys()) {
    let dir = path.slice(0, path.lastIndexOf('/'));
    while (dir !== '') {
      directories.add(dir);
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
    directories.add('/');
  }
  const statFor = (p: string): FsStat => ({
    isFile: store.has(p),
    isDirectory: directories.has(p) && !store.has(p),
    isSymbolicLink: false,
    mode: 0o644,
    size: (store.get(p) ?? '').length,
    mtime: new Date(),
  });
  const fs: IFileSystem = {
    async readFile(p) {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async readFileBuffer(p) {
      return new TextEncoder().encode(await fs.readFile(p));
    },
    async writeFile(p, c) {
      store.set(p, typeof c === 'string' ? c : new TextDecoder().decode(c));
    },
    async appendFile(p, c) {
      store.set(
        p,
        (store.get(p) ?? '') + (typeof c === 'string' ? c : new TextDecoder().decode(c))
      );
    },
    async exists(p) {
      return store.has(p) || directories.has(p);
    },
    async stat(p) {
      if (!store.has(p) && !directories.has(p)) throw new Error(`ENOENT: ${p}`);
      return statFor(p);
    },
    async mkdir(p) {
      directories.add(p);
    },
    async readdir(p) {
      const prefix = p === '/' ? '/' : `${p}/`;
      const names = new Set<string>();
      for (const key of [...store.keys(), ...directories]) {
        if (!key.startsWith(prefix) || key === p) continue;
        names.add(key.slice(prefix.length).split('/')[0]);
      }
      return [...names];
    },
    async rm(p) {
      store.delete(p);
    },
    async cp() {},
    async mv() {},
    resolvePath(base, p) {
      if (p.startsWith('/')) return p;
      if (p === '.') return base;
      return base === '/' ? `/${p}` : `${base}/${p}`;
    },
    getAllPaths() {
      return [...store.keys()];
    },
    async chmod() {},
    async symlink() {},
    async link() {},
    async readlink() {
      return '';
    },
    async lstat(p) {
      return fs.stat(p);
    },
    async realpath(p) {
      return p;
    },
    async utimes() {},
  };
  return { fs, store } as unknown as IFileSystem & { store: Map<string, string> };
}

type ExecFn = NonNullable<CommandContext['exec']>;
type HelperReply = { stdout: string; stderr: string; exitCode: number };

interface Harness {
  ctx: CommandContext;
  /** Every command the script handed to `exec`, in order. */
  calls: string[];
  /**
   * Every invocation as the argv array the shell actually received. The helper
   * MUST arrive this way: a command string would let a target path or a stdin
   * buffer containing `$(...)` run as a command substitution.
   */
  argvCalls: string[][];
  /** The parsed request JSON of the last `node <helper> <json>` call. */
  lastRequest: () => Record<string, unknown> | null;
  read: (path: string) => string | undefined;
  helperSource: () => string | undefined;
}

function makeHarness(
  files: Record<string, string>,
  reply: (request: Record<string, unknown>) => HelperReply,
  opts: { cwd?: string; dirs?: string[]; stdin?: string } = {}
): Harness {
  const wrapped = makeFs({ [SCRIPT_PATH]: source, ...files }, opts.dirs) as IFileSystem & {
    fs: IFileSystem;
    store: Map<string, string>;
  };
  const fs = wrapped.fs;
  const store = wrapped.store;
  const calls: string[] = [];
  const argvCalls: string[][] = [];
  let request: Record<string, unknown> | null = null;
  let capturedHelper: string | undefined;

  // `exec.spawn(argv)` reaches `ctx.exec` as `(argv[0], { args: argv.slice(1) })`
  // — see `dispatchExec` in `realm-host.ts`. The string form is still accepted
  // here so a regression back to it is visible as an empty `argvCalls`.
  const exec = (async (command: string, opts?: { args?: string[] }) => {
    const argv = opts?.args ? [command, ...opts.args] : null;
    if (argv) argvCalls.push(argv);
    calls.push(argv ? argv.join(' ') : command);
    const parts = argv ?? /^node (\S+) (.*)$/s.exec(command)?.slice(1).map(String);
    if (!parts) return { stdout: '', stderr: '', exitCode: 127 };
    const [helperPath, payload] = argv ? [parts[1], parts[2]] : [parts[0], parts[1]];
    if (helperPath === undefined || payload === undefined) {
      return { stdout: '', stderr: '', exitCode: 127 };
    }
    // The helper is written to the VFS before the call and removed after, so
    // snapshot it here — this is the only moment it exists.
    capturedHelper = store.get(helperPath);
    request = JSON.parse(argv ? payload : (JSON.parse(payload) as string)) as Record<
      string,
      unknown
    >;
    return reply(request);
  }) as ExecFn;

  const ctx: CommandContext = {
    fs,
    cwd: opts.cwd ?? '/workspace/proj',
    env: new Map<string, string>([['TMPDIR', '/tmp']]),
    stdin: unsafeBytesFromLatin1(opts.stdin ?? ''),
    exec,
  };
  return {
    ctx,
    calls,
    argvCalls,
    lastRequest: () => request,
    read: (path) => store.get(path),
    helperSource: () => capturedHelper,
  };
}

function run(harness: Harness, args: string[]) {
  return executeJshFile(SCRIPT_PATH, args, harness.ctx, undefined, {
    realmFactory: createInProcessJsRealmFactory(),
  });
}

/** A helper reply with no findings for every requested file. */
const clean = (request: Record<string, unknown>): HelperReply => ({
  stdout: JSON.stringify(
    (request.files as { path: string }[]).map((f) => ({
      path: f.path,
      messages: [],
      output: null,
      wrapUnfixable: false,
    }))
  ),
  stderr: '',
  exitCode: 0,
});

const FLAT_CONFIG = 'export default [{ files: ["**/*.js"], rules: { semi: "error" } }];\n';

describe('eslint skill: usage surface', () => {
  it('--help prints usage and the install line, and exits 0', async () => {
    const harness = makeHarness({}, clean);
    const result = await run(harness, ['--help']);
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('ipk add -g eslint @eslint/js esbuild-wasm');
    // Nothing was linted, so the helper was never invoked.
    expect(harness.calls).toEqual([]);
  });

  it('no arguments prints help rather than failing', async () => {
    const harness = makeHarness({}, clean);
    const result = await run(harness, []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('an unknown option exits 2 and names the option', async () => {
    const harness = makeHarness({}, clean);
    const result = await run(harness, ['--nope', 'a.js']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown option: --nope');
  });

  it('an unknown formatter exits 2 and lists the supported ones', async () => {
    const harness = makeHarness({}, clean);
    const result = await run(harness, ['-f', 'checkstyle', 'a.js']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown formatter: checkstyle');
    expect(result.stderr).toContain('stylish');
  });

  it('--fix and --fix-dry-run together exit 2', async () => {
    const harness = makeHarness({}, clean);
    const result = await run(harness, ['--fix', '--fix-dry-run', 'a.js']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('cannot be used together');
  });

  it('--rule with invalid JSON exits 2 instead of throwing', async () => {
    const harness = makeHarness({}, clean);
    const result = await run(harness, ['--rule', '{oops', 'a.js']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--rule is not valid JSON');
    expect(result.stderr).not.toContain('SyntaxError');
  });

  it('--stdin with file arguments exits 2', async () => {
    const harness = makeHarness({}, clean);
    const result = await run(harness, ['--stdin', 'a.js']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--stdin cannot be combined with file arguments');
  });

  it('--version asks the helper and needs no config at all', async () => {
    const harness = makeHarness({}, () => ({
      stdout: JSON.stringify({ version: '10.10.0' }),
      stderr: '',
      exitCode: 0,
    }));
    const result = await run(harness, ['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('10.10.0');
    expect(harness.lastRequest()?.op).toBe('version');
  });
});

describe('eslint skill: config discovery', () => {
  it('walks toward / from the target file and reports the config it found', async () => {
    const harness = makeHarness(
      {
        '/workspace/proj/eslint.config.js': FLAT_CONFIG,
        '/workspace/proj/src/a.js': 'var a = 1\n',
      },
      clean
    );
    const result = await run(harness, ['src/a.js']);
    expect(result.exitCode).toBe(0);
    // The discovered config is a require() LITERAL in the helper, because a
    // runtime path would have no module-graph edge and could never load.
    expect(harness.helperSource()).toContain('require("/workspace/proj/eslint.config.js")');
    expect(harness.lastRequest()?.basePath).toBe('/workspace/proj');
  });

  it('starts at a DIRECTORY target itself, not its parent', async () => {
    // Starting one level up would walk straight past the project's own config.
    const harness = makeHarness(
      {
        '/workspace/proj/eslint.config.js': FLAT_CONFIG,
        '/workspace/proj/a.js': 'var a = 1\n',
      },
      clean,
      { cwd: '/workspace' }
    );
    const result = await run(harness, ['proj']);
    expect(result.exitCode).toBe(0);
    expect(harness.helperSource()).toContain('require("/workspace/proj/eslint.config.js")');
  });

  it('exits 2 with the searched names when no config is found', async () => {
    const harness = makeHarness({ '/workspace/proj/a.js': 'var a = 1\n' }, clean);
    const result = await run(harness, ['a.js']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no flat config found');
    expect(result.stderr).toContain('eslint.config.js');
    expect(result.stderr).toContain('--no-config-lookup');
  });

  it('exits 2 when an explicit --config does not exist', async () => {
    const harness = makeHarness({ '/workspace/proj/a.js': 'var a = 1\n' }, clean);
    const result = await run(harness, ['--config', 'missing.js', 'a.js']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no such file');
  });

  it('rejects a TypeScript config rather than failing obscurely inside the helper', async () => {
    const harness = makeHarness(
      {
        '/workspace/proj/eslint.config.ts': FLAT_CONFIG,
        '/workspace/proj/a.js': 'var a = 1\n',
      },
      clean
    );
    const result = await run(harness, ['a.js']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('TypeScript flat configs');
    expect(harness.calls).toEqual([]);
  });

  it('--no-config-lookup with --rule lints with no config file present', async () => {
    const harness = makeHarness({ '/workspace/proj/a.js': 'var a = 1\n' }, clean);
    const result = await run(harness, ['--no-config-lookup', '--rule', '{"semi":"error"}', 'a.js']);
    expect(result.exitCode).toBe(0);
    expect(harness.lastRequest()?.rules).toEqual({ semi: 'error' });
    // With no config file the inline rules must carry a NON-universal `files`
    // matcher, so the patterns come from the extension list.
    expect(harness.lastRequest()?.filePatterns).toContain('**/*.js');
    expect(harness.lastRequest()?.filePatterns).toContain('**/*.jsh');
    expect(harness.helperSource()).toContain('const loadedConfig = null;');
  });
});

describe('eslint skill: target expansion', () => {
  const tree = {
    '/workspace/proj/eslint.config.js': FLAT_CONFIG,
    '/workspace/proj/a.js': 'var a = 1\n',
    '/workspace/proj/b.mjs': 'var b = 1\n',
    '/workspace/proj/notes.md': '# notes\n',
    '/workspace/proj/nested/c.ts': 'var c = 1\n',
    '/workspace/proj/node_modules/dep/index.js': 'var d = 1\n',
    '/workspace/proj/.git/hooks/pre-commit.js': 'var e = 1\n',
  };

  it('walks a directory, skipping node_modules, .git, and non-lintable extensions', async () => {
    const harness = makeHarness(tree, clean);
    await run(harness, ['.']);
    const paths = (harness.lastRequest()?.files as { path: string }[]).map((f) => f.path);
    // The config file is itself lintable and is collected, as ESLint does.
    expect(paths).toEqual([
      '/workspace/proj/a.js',
      '/workspace/proj/b.mjs',
      '/workspace/proj/eslint.config.js',
      '/workspace/proj/nested/c.ts',
    ]);
  });

  it('--ext narrows what a directory walk collects', async () => {
    const harness = makeHarness(tree, clean);
    await run(harness, ['--ext', '.mjs', '.']);
    const paths = (harness.lastRequest()?.files as { path: string }[]).map((f) => f.path);
    expect(paths).toEqual(['/workspace/proj/b.mjs']);
  });

  it('marks a NAMED file explicit and a walked file not, so ignores report differently', async () => {
    const harness = makeHarness(tree, clean);
    await run(harness, ['a.js', 'nested']);
    const files = harness.lastRequest()?.files as { path: string; explicit: boolean }[];
    expect(files.find((f) => f.path === '/workspace/proj/a.js')?.explicit).toBe(true);
    expect(files.find((f) => f.path === '/workspace/proj/nested/c.ts')?.explicit).toBe(false);
  });

  it('reports a missing target on stderr and exits 2', async () => {
    const harness = makeHarness(tree, clean);
    const result = await run(harness, ['a.js', 'ghost.js']);
    expect(result.stderr).toContain('ghost.js: no such file or directory');
    expect(result.exitCode).toBe(2);
  });

  it('exits 0 with a note when a walk finds nothing lintable', async () => {
    // The config lives outside the walked directory, so nothing under it is
    // lintable at all.
    const harness = makeHarness(
      { '/workspace/eslint.config.js': FLAT_CONFIG, '/workspace/proj/docs/notes.md': '# n\n' },
      clean
    );
    const result = await run(harness, ['docs']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('no lintable files found');
    expect(harness.calls).toEqual([]);
  });

  it('lints stdin under --stdin-filename and sends the piped text, not a read', async () => {
    const harness = makeHarness({ '/workspace/proj/eslint.config.js': FLAT_CONFIG }, clean, {
      stdin: 'var piped = 1\n',
    });
    const result = await run(harness, ['--stdin-filename', 'piped.js']);
    expect(result.exitCode).toBe(0);
    const files = harness.lastRequest()?.files as { path: string; source: string }[];
    expect(files).toEqual([
      { path: '/workspace/proj/piped.js', source: 'var piped = 1\n', explicit: true },
    ]);
  });
});

describe('eslint skill: reporting and exit codes', () => {
  const files = {
    '/workspace/proj/eslint.config.js': FLAT_CONFIG,
    '/workspace/proj/a.js': 'var a = 1\n',
  };
  const findings = (): HelperReply => ({
    stdout: JSON.stringify([
      {
        path: '/workspace/proj/a.js',
        messages: [
          {
            ruleId: 'semi',
            severity: 2,
            message: 'Missing semicolon.',
            line: 1,
            column: 10,
            fix: { range: [9, 9], text: ';' },
          },
          {
            ruleId: 'no-unused-vars',
            severity: 1,
            message: "'a' is assigned a value but never used.",
            line: 1,
            column: 5,
          },
        ],
        output: null,
        wrapUnfixable: false,
      },
    ]),
    stderr: '',
    exitCode: 0,
  });

  it('stylish groups by file, tallies problems, and exits 1 on an error', async () => {
    const harness = makeHarness(files, findings);
    const result = await run(harness, ['a.js']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('/workspace/proj/a.js');
    expect(result.stdout).toContain('error');
    expect(result.stdout).toContain('Missing semicolon.');
    expect(result.stdout).toContain('semi');
    expect(result.stdout).toContain('2 problems (1 error, 1 warning)');
    expect(result.stdout).toContain('potentially fixable with the `--fix` option');
  });

  it('compact prints one line per finding', async () => {
    const harness = makeHarness(files, findings);
    const result = await run(harness, ['-f', 'compact', 'a.js']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      '/workspace/proj/a.js: line 1, col 10, error - Missing semicolon. (semi)'
    );
    expect(result.stdout.trim().split('\n')).toHaveLength(2);
  });

  it('json emits one parseable document and writes no diagnostics to stderr', async () => {
    const harness = makeHarness(files, findings);
    const result = await run(harness, ['--format', 'json', 'a.js']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report.summary).toEqual({
      errors: 1,
      warnings: 1,
      filesLinted: 1,
      fixedFiles: 0,
    });
    expect(report.results[0].filePath).toBe('/workspace/proj/a.js');
    expect(report.results[0].errorCount).toBe(1);
    expect(report.results[0].warningCount).toBe(1);
  });

  it('--quiet drops warnings and exits 0 when only warnings remain', async () => {
    const warningsOnly = (): HelperReply => ({
      stdout: JSON.stringify([
        {
          path: '/workspace/proj/a.js',
          messages: [
            { ruleId: 'no-unused-vars', severity: 1, message: 'unused', line: 1, column: 5 },
          ],
          output: null,
          wrapUnfixable: false,
        },
      ]),
      stderr: '',
      exitCode: 0,
    });
    const harness = makeHarness(files, warningsOnly);
    const result = await run(harness, ['--quiet', 'a.js']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('unused');
  });

  it('--quiet keeps a fatal parse error, which has no ruleId', async () => {
    const fatal = (): HelperReply => ({
      stdout: JSON.stringify([
        {
          path: '/workspace/proj/a.js',
          messages: [
            { ruleId: null, severity: 1, message: 'Parsing error: boom', line: 1, column: 1 },
          ],
          output: null,
          wrapUnfixable: false,
        },
      ]),
      stderr: '',
      exitCode: 0,
    });
    const harness = makeHarness(files, fatal);
    const result = await run(harness, ['--quiet', 'a.js']);
    expect(result.stdout).toContain('Parsing error: boom');
  });

  it('--max-warnings turns warnings into a failure', async () => {
    const twoWarnings = (): HelperReply => ({
      stdout: JSON.stringify([
        {
          path: '/workspace/proj/a.js',
          messages: [
            { ruleId: 'a', severity: 1, message: 'one', line: 1, column: 1 },
            { ruleId: 'b', severity: 1, message: 'two', line: 2, column: 1 },
          ],
          output: null,
          wrapUnfixable: false,
        },
      ]),
      stderr: '',
      exitCode: 0,
    });
    const under = await run(makeHarness(files, twoWarnings), ['--max-warnings', '2', 'a.js']);
    expect(under.exitCode).toBe(0);
    const over = await run(makeHarness(files, twoWarnings), ['--max-warnings', '1', 'a.js']);
    expect(over.exitCode).toBe(1);
    expect(over.stderr).toContain('exceeded the --max-warnings limit of 1');
  });
});

describe('eslint skill: fixes', () => {
  const files = {
    '/workspace/proj/eslint.config.js': FLAT_CONFIG,
    '/workspace/proj/a.js': 'var a = 1\n',
  };
  const fixed = (): HelperReply => ({
    stdout: JSON.stringify([
      {
        path: '/workspace/proj/a.js',
        messages: [],
        output: 'var a = 1;\n',
        wrapUnfixable: false,
      },
    ]),
    stderr: '',
    exitCode: 0,
  });

  it('--fix writes the fixed output back through the shell fs', async () => {
    const harness = makeHarness(files, fixed);
    const result = await run(harness, ['--fix', 'a.js']);
    expect(result.exitCode).toBe(0);
    expect(harness.read('/workspace/proj/a.js')).toBe('var a = 1;\n');
    expect(harness.lastRequest()?.fix).toBe(true);
  });

  it('--fix-dry-run reports the rewrite and leaves the file alone', async () => {
    const harness = makeHarness(files, fixed);
    const result = await run(harness, ['--fix-dry-run', 'a.js']);
    expect(result.exitCode).toBe(0);
    expect(harness.read('/workspace/proj/a.js')).toBe('var a = 1\n');
    expect(result.stderr).toContain('--fix would rewrite');
    // The helper still computes the fix; only the write-back is skipped.
    expect(harness.lastRequest()?.fix).toBe(true);
  });

  it('reports a .jsh whose fix rewrote the script wrapper, and does not write it', async () => {
    const harness = makeHarness(
      {
        '/workspace/proj/eslint.config.js': FLAT_CONFIG,
        '/workspace/proj/s.jsh': 'const x = 1\nreturn x\n',
      },
      () => ({
        stdout: JSON.stringify([
          {
            path: '/workspace/proj/s.jsh',
            messages: [],
            output: null,
            wrapUnfixable: true,
          },
        ]),
        stderr: '',
        exitCode: 0,
      })
    );
    const result = await run(harness, ['--fix', 's.jsh']);
    expect(result.stderr).toContain('rewrote the script wrapper');
    expect(harness.read('/workspace/proj/s.jsh')).toBe('const x = 1\nreturn x\n');
  });
});

describe('eslint skill: helper failures', () => {
  const files = {
    '/workspace/proj/eslint.config.js': FLAT_CONFIG,
    '/workspace/proj/a.js': 'var a = 1\n',
  };

  it('rewrites a missing-module failure into the ipk install line', async () => {
    const harness = makeHarness(files, () => ({
      stdout: '',
      stderr: "Error: Cannot find module 'eslint/universal' (run: ipk install eslint)\n",
      exitCode: 1,
    }));
    const result = await run(harness, ['a.js']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('eslint is not installed');
    expect(result.stderr).toContain('ipk add -g eslint @eslint/js esbuild-wasm');
  });

  it('names the scoped package when a scoped module is missing', async () => {
    const harness = makeHarness(files, () => ({
      stdout: '',
      stderr: "Error: Cannot find module '@eslint/js' (run: ipk install @eslint/js)\n",
      exitCode: 1,
    }));
    const result = await run(harness, ['a.js']);
    expect(result.stderr).toContain('@eslint/js is not installed');
  });

  it('surfaces unparseable helper output with the helper stderr attached', async () => {
    const harness = makeHarness(files, () => ({
      stdout: 'not json',
      stderr: 'something went sideways',
      exitCode: 0,
    }));
    const result = await run(harness, ['a.js']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('could not parse helper output');
    expect(result.stderr).toContain('something went sideways');
  });

  it('removes the generated helper from the VFS after the run', async () => {
    const harness = makeHarness(files, clean);
    await run(harness, ['a.js']);
    const helperPath = /^node (\S+) /.exec(harness.calls[0])?.[1];
    expect(helperPath).toBeTruthy();
    // It existed while the helper ran, and is gone now.
    expect(harness.helperSource()).toContain("require('eslint/universal')");
    expect(harness.read(helperPath as string)).toBeUndefined();
  });
});

describe('eslint skill: the helper request never reaches a shell', () => {
  const files = {
    '/workspace/proj/eslint.config.js': FLAT_CONFIG,
    '/workspace/proj/a.js': 'var a = 1\n',
  };

  it('passes the request as argv, not interpolated into a command string', async () => {
    const harness = makeHarness(files, clean);
    await run(harness, ['a.js']);
    // One argv invocation, and the JSON sits in its own entry where the shell
    // never parses it.
    expect(harness.argvCalls.length).toBe(1);
    const [bin, helper, payload] = harness.argvCalls[0];
    expect(bin).toBe('node');
    expect(helper).toMatch(/^\/tmp\/\.eslint-helper-/);
    expect(JSON.parse(payload)).toMatchObject({ op: 'lint' });
  });

  it('carries a command-substitution payload through untouched', async () => {
    // A filename or a piped buffer is attacker-influenced when linting a repo
    // the user did not write. `$(...)`/backticks survive `JSON.stringify`, and
    // the shell expands them inside double quotes — so the argv form is the
    // only safe carrier.
    const nasty = 'const x = `$(touch /workspace/pwned)`;\n';
    const harness = makeHarness(files, clean, { stdin: nasty });
    await run(harness, ['--stdin', '--stdin-filename', 'src/$(id).js']);
    const payload = harness.argvCalls[0][2];
    const request = JSON.parse(payload) as { files: { path: string; source: string }[] };
    expect(request.files[0].source).toBe(nasty);
    expect(request.files[0].path).toBe('/workspace/proj/src/$(id).js');
    // Nothing was written, and no second command ran.
    expect(harness.read('/workspace/pwned')).toBeUndefined();
    expect(harness.argvCalls.length).toBe(1);
  });

  it('generates a helper that parses as JavaScript', async () => {
    // The helper is a template literal, so an unescaped backtick or a real
    // newline where `\\n` was meant produces a syntactically broken script that
    // only shows up as an opaque helper failure at runtime.
    const harness = makeHarness(files, clean);
    await run(harness, ['a.js']);
    const helper = harness.helperSource() as string;
    expect(helper).toBeTruthy();
    // The helper ends in a top-level `await`, so it only compiles as an async
    // function body — which is exactly how the realm runs it.
    expect(() => compileHelper(helper)).not.toThrow();
  });
});

/**
 * Compile a generated helper the way the realm does: as an async function body,
 * with its `require`, `process` and `console` supplied by the caller.
 */
function compileHelper(src: string) {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...a: string[]
  ) => (...a: unknown[]) => Promise<unknown>;
  return new AsyncFunction('require', 'process', 'console', src);
}

type FakeMessage = {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  fatal?: boolean;
};

type HelperResult = {
  path: string;
  messages: FakeMessage[];
  output: string | null;
  wrapUnfixable: boolean;
};

/**
 * Run a generated helper against a stub `Linter`, so the helper's OWN logic —
 * global-ignore evaluation and wrapper-message filtering — is exercised for
 * real. `minimatch` is the genuine package, since ignore semantics are the
 * thing under test.
 */
async function runGeneratedHelper(
  helper: string,
  request: Record<string, unknown>,
  verify: (source: string, path: string) => FakeMessage[],
  config: unknown[] = [{ files: ['**/*'], rules: {} }]
): Promise<HelperResult[]> {
  const { minimatch } = await import('minimatch');
  class FakeLinter {
    verify(source: string, _config: unknown, path: string): FakeMessage[] {
      return verify(source, path);
    }
    verifyAndFix(source: string, _config: unknown, path: string) {
      return { output: source, fixed: false, messages: verify(source, path) };
    }
  }
  let out = '';
  const stubRequire = (id: string): unknown => {
    if (id === 'eslint/universal') return { Linter: FakeLinter };
    if (id === 'minimatch') return { minimatch };
    if (id === 'eslint/package.json') return { version: '9.9.9' };
    if (id === 'fs') return { readFile: async () => '' };
    return config;
  };
  const stubProcess = {
    argv: ['node', 'helper.js', JSON.stringify(request)],
    stdout: {
      write: (s: string) => {
        out += s;
      },
    },
    stderr: { write: () => {} },
    exit: (code: number) => {
      throw new Error(`helper exited ${code}`);
    },
  };
  await compileHelper(helper)(stubRequire, stubProcess, console);
  return JSON.parse(out) as HelperResult[];
}

describe('eslint skill: helper global-ignore evaluation', () => {
  const files = {
    '/workspace/proj/eslint.config.js': FLAT_CONFIG,
    '/workspace/proj/a.js': 'var a = 1\n',
  };
  const noFindings = () => [];

  async function helperFor(): Promise<string> {
    const harness = makeHarness(files, clean);
    await run(harness, ['a.js']);
    return harness.helperSource() as string;
  }

  it('re-includes a path restored by a later negated pattern', async () => {
    // ESLint evaluates ignores in order, so `!src/**/*.js` after `**/*.js`
    // means `src` IS linted. A short-circuiting matcher skipped it — and a
    // skipped file makes lint pass, so the gap is invisible.
    const results = await runGeneratedHelper(
      await helperFor(),
      {
        op: 'lint',
        basePath: '/workspace/proj',
        files: [
          { path: '/workspace/proj/src/app.js', source: 'var a = 1\n', explicit: false },
          { path: '/workspace/proj/lib/other.js', source: 'var b = 1\n', explicit: false },
        ],
      },
      noFindings,
      [{ ignores: ['**/*.js', '!src/**/*.js'] }, { files: ['**/*.js'], rules: {} }]
    );
    expect(results.map((r) => r.path)).toEqual(['/workspace/proj/src/app.js']);
  });

  it('still ignores a path re-ignored by a pattern after the negation', async () => {
    const results = await runGeneratedHelper(
      await helperFor(),
      {
        op: 'lint',
        basePath: '/workspace/proj',
        files: [{ path: '/workspace/proj/src/app.js', source: 'var a = 1\n', explicit: false }],
      },
      noFindings,
      [{ ignores: ['**/*.js', '!src/**/*.js', 'src/app.js'] }, { files: ['**/*.js'], rules: {} }]
    );
    expect(results).toEqual([]);
  });
});

describe('eslint skill: helper drops wrapper-only findings', () => {
  const files = {
    '/workspace/proj/eslint.config.js': FLAT_CONFIG,
    '/workspace/proj/a.js': 'var a = 1\n',
  };

  async function helperFor(): Promise<string> {
    const harness = makeHarness(files, clean);
    await run(harness, ['a.js']);
    return harness.helperSource() as string;
  }

  const jshRequest = (source: string) => ({
    op: 'lint',
    basePath: '/workspace/proj',
    files: [{ path: '/workspace/proj/s.jsh', source, explicit: true }],
  });

  it('drops a finding that lives entirely in the injected prefix', async () => {
    // This is what `no-unused-vars` did to the old named wrapper: a report on
    // line 1 of a file whose line 1 is the user's first real statement.
    const results = await runGeneratedHelper(await helperFor(), jshRequest('const x = 1\n'), () => [
      {
        ruleId: 'no-unused-vars',
        severity: 2,
        message: "'__slicc' is defined",
        line: 1,
        endLine: 1,
      },
    ]);
    expect(results[0].messages).toEqual([]);
  });

  it('keeps a finding that starts in the wrapper but spans the body', async () => {
    const results = await runGeneratedHelper(
      await helperFor(),
      jshRequest('const x = 1\nconst y = 2\n'),
      () => [
        { ruleId: 'indent', severity: 2, message: 'Expected indentation', line: 1, endLine: 3 },
      ]
    );
    expect(results[0].messages).toHaveLength(1);
    expect(results[0].messages[0].ruleId).toBe('indent');
  });

  it('drops a finding on the injected suffix line', async () => {
    // Wrapped: 1 is the prefix, 2-3 the two statements, 4 the empty line left
    // by the trailing newline, 5 the closing `})`.
    const results = await runGeneratedHelper(
      await helperFor(),
      jshRequest('const x = 1\nconst y = 2\n'),
      () => [{ ruleId: 'eol-last', severity: 1, message: 'Newline required', line: 5, endLine: 5 }]
    );
    expect(results[0].messages).toEqual([]);
  });

  it('never drops a fatal parse error, even on a wrapper line', async () => {
    const results = await runGeneratedHelper(await helperFor(), jshRequest('const x = (\n'), () => [
      {
        ruleId: null,
        severity: 2,
        message: 'Parsing error: Unexpected token',
        line: 1,
        fatal: true,
      },
    ]);
    expect(results[0].messages).toHaveLength(1);
    expect(results[0].messages[0].fatal).toBe(true);
  });

  it('keeps ordinary body findings and shifts them back by the prefix line', async () => {
    const results = await runGeneratedHelper(await helperFor(), jshRequest('var a = 1\n'), () => [
      {
        ruleId: 'semi',
        severity: 2,
        message: 'Missing semicolon',
        line: 2,
        column: 10,
        endLine: 2,
      },
    ]);
    expect(results[0].messages[0].line).toBe(1);
    expect(results[0].messages[0].column).toBe(10);
  });
});

describe('eslint skill: stdin never gets written back', () => {
  const files = {
    '/workspace/proj/eslint.config.js': FLAT_CONFIG,
    '/workspace/proj/src/app.js': 'const real = 1;\n',
  };

  it('rejects --fix with stdin instead of writing the virtual filename', async () => {
    // `--stdin-filename` picks a config; it is not a target. Writing to it would
    // replace a real file with the piped buffer.
    const harness = makeHarness(files, clean, { stdin: 'var piped = 1\n' });
    const result = await run(harness, ['--stdin', '--stdin-filename', 'src/app.js', '--fix']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('not available for piped-in code');
    expect(harness.read('/workspace/proj/src/app.js')).toBe('const real = 1;\n');
    // It never even reached the helper.
    expect(harness.argvCalls).toEqual([]);
  });

  it('prints the fixed buffer for --fix-dry-run with stdin and writes nothing', async () => {
    const harness = makeHarness(
      files,
      (request) => ({
        stdout: JSON.stringify(
          (request.files as { path: string }[]).map((f) => ({
            path: f.path,
            messages: [],
            output: 'var piped = 1;\n',
            wrapUnfixable: false,
          }))
        ),
        stderr: '',
        exitCode: 0,
      }),
      { stdin: 'var piped = 1\n' }
    );
    const result = await run(harness, [
      '--stdin',
      '--stdin-filename',
      'src/app.js',
      '--fix-dry-run',
    ]);
    expect(result.stdout).toContain('var piped = 1;');
    expect(harness.read('/workspace/proj/src/app.js')).toBe('const real = 1;\n');
  });

  it('does not create the default stdin.js placeholder', async () => {
    const harness = makeHarness(files, clean, { stdin: 'var piped = 1\n' });
    await run(harness, ['--stdin']);
    expect(harness.read('/workspace/proj/stdin.js')).toBeUndefined();
  });
});
