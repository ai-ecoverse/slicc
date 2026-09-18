import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import assertSource from 'tst/assert.js?raw';
import tstSource from 'tst/tst.js?raw';
import { normalizePath } from '../../fs/path-utils.js';
import { executeJsCode } from '../jsh-executor.js';
import { getTypeScript, dirname as posixDirname, type TypeScriptModule } from './shared.js';
import { createIpkContextFromCtx } from './tsc-command.js';

export const TST_COMMAND_NAME = 'tst';

const HELP_TEXT = `tst - run *.test.{js,ts} files with the bundled tst runner

Usage:
  tst [options] [glob...]

Options:
  --reporter=<name>     tap (default) | spec
  -h, --help            Show this help

Notes:
  - Default glob: **/*.test.{js,ts}, walked from the current cwd.
  - .ts files are transpiled via the bundled typescript package.
  - Each file runs in its own realm (same engine as 'node').
`;

const DEFAULT_GLOBS = ['**/*.test.{js,ts}'];

export interface ParsedTestArgs {
  globs: string[];
  reporter: 'tap' | 'spec';
  showHelp: boolean;
}

export function parseTestArgs(args: string[]): ParsedTestArgs {
  const globs: string[] = [];
  let reporter: 'tap' | 'spec' = 'tap';
  let showHelp = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      continue;
    }
    if (arg === '--reporter') {
      const v = args[i + 1];
      if (v !== 'tap' && v !== 'spec') {
        throw new Error('tst: --reporter must be tap or spec');
      }
      reporter = v;
      i += 1;
      continue;
    }
    if (arg.startsWith('--reporter=')) {
      const v = arg.slice('--reporter='.length);
      if (v !== 'tap' && v !== 'spec') {
        throw new Error('tst: --reporter must be tap or spec');
      }
      reporter = v;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`tst: unknown option: ${arg}`);
    }
    globs.push(arg);
  }
  return {
    globs: globs.length > 0 ? globs : [...DEFAULT_GLOBS],
    reporter,
    showHelp,
  };
}

export function expandBraces(pattern: string): string[] {
  const idx = pattern.indexOf('{');
  if (idx === -1) return [pattern];
  const end = pattern.indexOf('}', idx);
  if (end === -1) return [pattern];
  const head = pattern.slice(0, idx);
  const tail = pattern.slice(end + 1);
  const parts = pattern.slice(idx + 1, end).split(',');
  const out: string[] = [];
  for (const p of parts) {
    for (const sub of expandBraces(`${head}${p}${tail}`)) out.push(sub);
  }
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      re += '(?:.*/)?';
      i += 2;
      if (pattern[i] === '/') i += 1;
    } else if (ch === '*') {
      re += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else if ('.+^$()[]|\\'.includes(ch)) {
      re += `\\${ch}`;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export async function resolveTestFiles(
  fs: CommandContext['fs'],
  cwd: string,
  globs: string[]
): Promise<string[]> {
  const patterns = globs.flatMap(expandBraces).map(globToRegExp);
  const matches = new Set<string>();
  const prefix = cwd === '/' ? '' : cwd;
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      let isDir = false;
      try {
        const st = await fs.stat(path);
        isDir = st.isDirectory;
      } catch {
        continue;
      }
      if (isDir) {
        await walk(path);
        continue;
      }
      const rel = path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
      if (patterns.some((re) => re.test(rel))) matches.add(path);
    }
  }
  await walk(cwd);
  return [...matches].sort();
}

let preparedHarness: string | null = null;

async function prepareTstHarness(ts: TypeScriptModule): Promise<string> {
  if (preparedHarness) return preparedHarness;
  const opts = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    isolatedModules: false,
  } as import('typescript-js').CompilerOptions;
  const assertCjs = ts.transpileModule(assertSource, {
    compilerOptions: opts,
    fileName: 'assert.js',
  }).outputText;
  const tstCjsRaw = ts.transpileModule(tstSource, {
    compilerOptions: opts,
    fileName: 'tst.js',
  }).outputText;
  const tstCjs = tstCjsRaw
    .replace(/require\(["']\.\/assert\.js["']\)/g, '__tst_assert_exports')
    .replace(/\bimport\.meta\b/g, '({url:""})')
    .replace(
      /await\s+import\(['"](?:worker_threads|fs|path)['"]\)/g,
      'await Promise.reject(new Error("tst: fork mode is not supported in the realm"))'
    );

  preparedHarness = `
if (typeof process !== 'undefined' && !process.versions) {
  try { process.versions = { node: '20.0.0' }; } catch (_) { /* readonly process.versions is fine */ }
}
const __tst_assert_exports = (function () {
  const module = { exports: {} };
  const exports = module.exports;
  ${assertCjs}
  return module.exports;
})();
const __tst_module_exports = (function () {
  const module = { exports: {} };
  const exports = module.exports;
  ${tstCjs}
  return module.exports;
})();
const __tst = __tst_module_exports.default || __tst_module_exports;
__tst.manual = true;
`.trim();
  return preparedHarness;
}

export function rewireUserRequires(
  source: string,
  localModules: Map<string, string> = new Map()
): string {
  return source.replace(
    /(^|[^\w$.])require\(\s*(["'`])([^"'`]+)\2\s*\)/g,
    (match, prefix: string, _quote: string, spec: string) => {
      if (spec === 'tst' || spec === 'tst/tst.js') {
        return `${prefix}__tstReq("tst")`;
      }
      if (spec === 'tst/assert' || spec === 'tst/assert.js') {
        return `${prefix}__tstReq("tst/assert")`;
      }
      if (localModules.has(spec)) {
        return `${prefix}__localReq(${JSON.stringify(localModules.get(spec))})`;
      }
      return match;
    }
  );
}

function extractRequireSpecifiers(source: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[^\w$.])require\(\s*(["'`])([^"'`]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.add(m[2]);
  return [...out];
}

async function resolveLocalSpecifier(
  fs: CommandContext['fs'],
  fromDir: string,
  spec: string
): Promise<string | null> {
  const base = normalizePath(`${fromDir}/${spec}`);
  const candidates = [base];

  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);

  if (!/\.[a-zA-Z0-9]+$/.test(base)) {
    candidates.push(`${base}.ts`, `${base}.js`);
  }
  for (const c of candidates) {
    if (await fs.exists(c)) return c;
  }
  return null;
}

async function collectLocalDependencies(
  fs: CommandContext['fs'],
  ts: TypeScriptModule,
  entryPath: string,
  entryCjs: string,
  userOpts: import('typescript-js').CompilerOptions
): Promise<{
  modules: Map<string, string>;
  edgeRewrites: Map<string, Map<string, string>>;
}> {
  const modules = new Map<string, string>();
  const edgeRewrites = new Map<string, Map<string, string>>();
  const queue: Array<{ path: string; cjs: string }> = [{ path: entryPath, cjs: entryCjs }];
  while (queue.length > 0) {
    const { path, cjs } = queue.shift()!;
    const fromDir = posixDirname(path);
    const edges = new Map<string, string>();
    for (const spec of extractRequireSpecifiers(cjs)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const resolved = await resolveLocalSpecifier(fs, fromDir, spec);
      if (!resolved) continue;
      edges.set(spec, resolved);
      if (modules.has(resolved)) continue;
      const source = await fs.readFile(resolved);
      const depCjs = ts.transpileModule(source, {
        compilerOptions: userOpts,
        fileName: resolved,
      }).outputText;
      modules.set(resolved, depCjs);
      queue.push({ path: resolved, cjs: depCjs });
    }
    edgeRewrites.set(path, edges);
  }
  return { modules, edgeRewrites };
}

function buildRunnerScript(
  harness: string,
  entryPath: string,
  userCjs: string,
  reporter: 'tap' | 'spec',
  localModules: Map<string, string>,
  edgeRewrites: Map<string, Map<string, string>>
): string {
  const format = reporter === 'spec' ? 'pretty' : 'tap';

  const factoryEntries: string[] = [];
  for (const [absPath, depCjs] of localModules.entries()) {
    const depEdges = edgeRewrites.get(absPath) ?? new Map<string, string>();
    const rewired = rewireUserRequires(depCjs, depEdges);
    factoryEntries.push(
      `${JSON.stringify(absPath)}: function (module, exports, require) {\n${rewired}\n}`
    );
  }
  const factories = `{${factoryEntries.join(',\n')}}`;
  const entryEdges = edgeRewrites.get(entryPath) ?? new Map<string, string>();
  const rewiredEntry = rewireUserRequires(userCjs, entryEdges);
  return `"use strict";
${harness}
const __tstReq = (id) => {
  if (id === "tst") return __tst_module_exports;
  if (id === "tst/assert") return __tst_assert_exports;
  throw new Error("tst: cannot require " + id);
};
const __localFactories = ${factories};
const __localCache = Object.create(null);
const __localReq = (absPath) => {
  if (absPath in __localCache) return __localCache[absPath].exports;
  const factory = __localFactories[absPath];
  if (!factory) throw new Error("tst: local module not bundled: " + absPath);
  const module = { exports: {} };
  __localCache[absPath] = module;
  factory(module, module.exports, __localReq);
  return module.exports;
};
await (async function (require) {
${rewiredEntry}
})(__tstReq);
const __state = await __tst.run({ format: ${JSON.stringify(format)} });
// EXT6 (F-C03): for an explicit single-file run under the default tap
// reporter, run()'s promise can resolve before a thrown test's rejection
// has settled into __state.failed, so the exit raced ahead and read 0.
// Drain microtasks and yield one macrotask tick so any pending failure is
// recorded before we read it — the bare-glob and spec paths already do
// enough async work to settle first, which is why only this path swallowed.
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve));
if (__state && __state.failed && __state.failed.length > 0) process.exit(1);
`;
}

export function _resetTstHarnessForTests(): void {
  preparedHarness = null;
}

type TestCmdResult = { stdout: string; stderr: string; exitCode: number };

type UserCompilerOptions = import('typescript-js').CompilerOptions;

const USER_OPTS_TEMPLATE = {
  esModuleInterop: true,
  allowJs: true,
  isolatedModules: false,
};

function buildUserOpts(ts: TypeScriptModule): UserCompilerOptions {
  return {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    ...USER_OPTS_TEMPLATE,
  } as UserCompilerOptions;
}

interface TestRunSetup {
  parsed: ParsedTestArgs;
  files: string[];
  ts: TypeScriptModule;
  harness: string;
  userOpts: UserCompilerOptions;
}

async function prepareTestRun(
  args: string[],
  ctx: CommandContext
): Promise<{ done: TestCmdResult } | TestRunSetup> {
  let parsed: ParsedTestArgs;
  try {
    parsed = parseTestArgs(args);
  } catch (err) {
    return {
      done: {
        stdout: '',
        stderr: `${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 2,
      },
    };
  }
  if (parsed.showHelp) return { done: { stdout: HELP_TEXT, stderr: '', exitCode: 0 } };

  const files = await resolveTestFiles(ctx.fs, ctx.cwd, parsed.globs);
  if (files.length === 0) {
    return {
      done: {
        stdout: '',
        stderr: `tst: no test files matched ${parsed.globs.join(' ')}\n`,
        exitCode: 1,
      },
    };
  }

  let ts: TypeScriptModule;
  try {
    ts = await getTypeScript(createIpkContextFromCtx(ctx));
  } catch (err) {
    return {
      done: {
        stdout: '',
        stderr: `tst: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      },
    };
  }
  const harness = await prepareTstHarness(ts);
  return { parsed, files, ts, harness, userOpts: buildUserOpts(ts) };
}

interface OneFileResult {
  stdout: string;
  stderr: string;
  failed: boolean;
}

export function hasTstFailureMarker(stdout: string): boolean {
  return stdout.includes('# fail ') || /(^|\n)not ok /.test(stdout);
}

async function runOneTestFile(
  ctx: CommandContext,
  setup: TestRunSetup,
  file: string,
  prefixWithFilename: boolean
): Promise<OneFileResult> {
  const { ts, harness, userOpts, parsed } = setup;
  let source: string;
  try {
    source = await ctx.fs.readFile(file);
  } catch (err) {
    return {
      stdout: '',
      stderr: `tst: ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
      failed: true,
    };
  }
  let userCjs: string;
  try {
    userCjs = ts.transpileModule(source, { compilerOptions: userOpts, fileName: file }).outputText;
  } catch (err) {
    return {
      stdout: '',
      stderr: `tst: ${file}: transpile error: ${err instanceof Error ? err.message : String(err)}\n`,
      failed: true,
    };
  }
  let localModules: Map<string, string>;
  let edgeRewrites: Map<string, Map<string, string>>;
  try {
    ({ modules: localModules, edgeRewrites } = await collectLocalDependencies(
      ctx.fs,
      ts,
      file,
      userCjs,
      userOpts
    ));
  } catch (err) {
    return {
      stdout: '',
      stderr: `tst: ${file}: local-require resolve error: ${err instanceof Error ? err.message : String(err)}\n`,
      failed: true,
    };
  }
  const runner = buildRunnerScript(
    harness,
    file,
    userCjs,
    parsed.reporter,
    localModules,
    edgeRewrites
  );
  const result = await executeJsCode(runner, ['node', file], ctx, undefined, { filename: file });
  return {
    stdout: prefixWithFilename ? `# ${file}\n${result.stdout}` : result.stdout,
    stderr: result.stderr,

    failed: result.exitCode !== 0 || hasTstFailureMarker(result.stdout),
  };
}

export function createTestCommand(): Command {
  return defineCommand(TST_COMMAND_NAME, async (args, ctx) => {
    const prep = await prepareTestRun(args, ctx);
    if ('done' in prep) return prep.done;
    const prefixWithFilename = prep.files.length > 1;

    let stdout = '';
    let stderr = '';
    let anyFailed = false;
    for (const file of prep.files) {
      const r = await runOneTestFile(ctx, prep, file, prefixWithFilename);
      stdout += r.stdout;
      stderr += r.stderr;
      if (r.failed) anyFailed = true;
    }
    return { stdout, stderr, exitCode: anyFailed ? 1 : 0 };
  });
}
