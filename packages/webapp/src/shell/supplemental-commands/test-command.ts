/**
 * `test` shell command. Discovers `*.test.{js,ts}` files via a glob
 * (default `**\/*.test.{js,ts}`), TS-transpiles each through the
 * `getTypeScript()` singleton shared with `tsc`, then runs every
 * file in its own isolated realm via `executeJsCode` — same path
 * as `node`, so SIGKILL and per-file isolation come for free.
 *
 * The runner is `tst` (https://github.com/dy/tst — 0 deps, ESM
 * native). The browser-side realm can't `import('tst')` directly
 * (the AsyncFunction body is parsed as a script, not a module),
 * so the small `tst.js` + `assert.js` sources are bundled via
 * `?raw`, transpiled to CJS once per process, and stitched into
 * each test file's runner script as IIFEs. User imports of `tst`
 * are rewired to that inline module via a per-file `__tstReq`
 * shim — that also keeps the realm's `require()` from looking up
 * the tst specifier in the host-built ipk module graph.
 *
 * Reporters map to tst's built-in formats: `tap` (default) →
 * tst `tap`, `--reporter=spec` → tst `pretty`.
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import assertSource from 'tst/assert.js?raw';
import tstSource from 'tst/tst.js?raw';
import { normalizePath } from '../../fs/path-utils.js';
import { executeJsCode } from '../jsh-executor.js';
import { getTypeScript, dirname as posixDirname, type TypeScriptModule } from './shared.js';
import { createIpkContextFromCtx } from './tsc-command.js';

const HELP_TEXT = `test - run *.test.{js,ts} files with the bundled tst runner

Usage:
  test [options] [glob...]

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
        throw new Error('test: --reporter must be tap or spec');
      }
      reporter = v;
      i += 1;
      continue;
    }
    if (arg.startsWith('--reporter=')) {
      const v = arg.slice('--reporter='.length);
      if (v !== 'tap' && v !== 'spec') {
        throw new Error('test: --reporter must be tap or spec');
      }
      reporter = v;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`test: unknown option: ${arg}`);
    }
    globs.push(arg);
  }
  return {
    globs: globs.length > 0 ? globs : [...DEFAULT_GLOBS],
    reporter,
    showHelp,
  };
}

/** Expand `{a,b,c}` brace groups left-to-right; one level deep is enough for our defaults. */
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

/** Minimal glob → RegExp: `**` matches across path segments, `*` within one. */
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

/**
 * Recursively collect files under `cwd` matching any of the given
 * (brace-expanded) glob patterns. Skips `node_modules` and dot-dirs
 * — vitest's default scan does the same, and the test command's
 * realm path can't usefully introspect those anyway.
 */
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

// ---------------------------------------------------------------------------
// tst harness preparation
// ---------------------------------------------------------------------------

let preparedHarness: string | null = null;

/**
 * Transpile the bundled `tst.js` + `assert.js` to CJS once and stitch
 * them into a self-contained source fragment that exposes
 * `__tst_module_exports` / `__tst_assert_exports` / `__tst` as locals.
 *
 * Several string-level fixups are needed AFTER `transpileModule`:
 *   - `require('./assert.js')` is rewired to the inlined assert
 *     exports object so the IIFE doesn't need a real `require()`.
 *   - `import.meta` is replaced with a stub literal. It only appears
 *     in `runForked` (worker_threads / Web Worker bootstrap) which
 *     the realm can't run anyway, but the bare `import.meta` token
 *     is a SyntaxError inside an AsyncFunction body.
 *   - `await import('worker_threads' | 'fs' | 'path')` in that same
 *     fork helper is stubbed to an immediate rejection so it never
 *     hits the realm's dynamic-import path.
 */
async function prepareTstHarness(ts: TypeScriptModule): Promise<string> {
  if (preparedHarness) return preparedHarness;
  const opts = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    isolatedModules: false,
  } as import('typescript').CompilerOptions;
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
      'await Promise.reject(new Error("test: fork mode is not supported in the realm"))'
    );
  // tst branches on `isNode = typeof process !== 'undefined' && process.versions?.node`
  // to pick between Node-style console output (TAP / pretty) and the
  // browser's `console.group` path. The realm's `processShim` omits
  // `versions`, so tst would otherwise fall into the browser path and
  // call `console.group` — which the realm doesn't shim. Force the Node
  // branch by injecting `process.versions.node` before loading tst.
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

/**
 * Rewrite literal `require("...")` calls produced by the TS CJS emit
 * so the realm's `extractRequireSpecifiers` regex skips them —
 * otherwise the host module graph would try to resolve every
 * specifier (including local files) from ipk `node_modules`. The
 * rewrite swaps the `require(` token for `__tstReq(` / `__localReq(`,
 * which the regex doesn't match.
 *
 * Three buckets:
 *   - `tst` / `tst/tst.js` / `tst/assert(.js)?` → `__tstReq(...)`
 *   - any local specifier in `localModules`    → `__localReq(<abs>)`
 *   - everything else (bare specifiers) is left to the realm's
 *     `require()` shim, which resolves it from the ipk-built CJS
 *     module graph (a missing package surfaces the canonical
 *     `ipk install <name>` hint, no CDN fallback).
 *
 * The regex anchors on a word boundary before `require` so it skips
 * identifier suffixes like `myrequire(...)` or `req.requireLike(...)`
 * — earlier drafts used a bare `require\(` which could match those.
 */
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

/**
 * Extract every `require("...")` specifier from a CJS source. Uses
 * the same anchored regex as `rewireUserRequires` so the two stay in
 * sync — anything the rewriter would touch is also reported here.
 */
function extractRequireSpecifiers(source: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[^\w$.])require\(\s*(["'`])([^"'`]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.add(m[2]);
  return [...out];
}

/**
 * Resolve a relative `require()` specifier against `fromDir` and
 * return the absolute VFS path of the actual file, trying `.ts` /
 * `.js` fallbacks if the specifier omits the extension. Returns
 * `null` when nothing resolves.
 */
async function resolveLocalSpecifier(
  fs: CommandContext['fs'],
  fromDir: string,
  spec: string
): Promise<string | null> {
  const base = normalizePath(`${fromDir}/${spec}`);
  const candidates = [base];
  // Strip a `.js` suffix and try `.ts` (common pattern in ESM-style
  // imports of TS sources that get emitted with `.js` extensions).
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  // Bare specifier without extension — try `.ts` then `.js`.
  if (!/\.[a-zA-Z0-9]+$/.test(base)) {
    candidates.push(`${base}.ts`, `${base}.js`);
  }
  for (const c of candidates) {
    if (await fs.exists(c)) return c;
  }
  return null;
}

/**
 * Recursively walk local `require()` graph starting from `entryPath`
 * and return a map of `{ specifier → absolute path }` for every
 * local edge encountered. The returned `modules` map keys absolute
 * VFS paths to their transpiled CJS sources so the runner can stitch
 * them in as IIFE-wrapped modules.
 *
 * Only relative specifiers (`./` or `../`) are followed. Bare
 * specifiers fall through to the realm's `require()` shim, which
 * resolves them from the host-built CJS module graph rooted in the
 * ipk `node_modules` tree. Cycles are guarded by `modules`
 * (path-keyed) — we re-enter only for unseen paths.
 */
async function collectLocalDependencies(
  fs: CommandContext['fs'],
  ts: TypeScriptModule,
  entryPath: string,
  entryCjs: string,
  userOpts: import('typescript').CompilerOptions
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
  // Inline every transitive local module as a lazy IIFE factory.
  // The factories share `__localReq` so a module can re-require
  // peers without re-evaluating them. Each factory closes over its
  // own edge map so per-file specifier → absolute-path rewrites
  // stay correct.
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
  throw new Error("test: cannot require " + id);
};
const __localFactories = ${factories};
const __localCache = Object.create(null);
const __localReq = (absPath) => {
  if (absPath in __localCache) return __localCache[absPath].exports;
  const factory = __localFactories[absPath];
  if (!factory) throw new Error("test: local module not bundled: " + absPath);
  const module = { exports: {} };
  __localCache[absPath] = module;
  factory(module, module.exports, __localReq);
  return module.exports;
};
await (async function (require) {
${rewiredEntry}
})(__tstReq);
const __state = await __tst.run({ format: ${JSON.stringify(format)} });
if (__state.failed && __state.failed.length > 0) process.exit(1);
`;
}

/** Test-only: drop the cached harness so each unit-test run re-builds it. */
export function _resetTstHarnessForTests(): void {
  preparedHarness = null;
}

export function createTestCommand(): Command {
  return defineCommand('test', async (args, ctx) => {
    let parsed: ParsedTestArgs;
    try {
      parsed = parseTestArgs(args);
    } catch (err) {
      return {
        stdout: '',
        stderr: `${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 2,
      };
    }
    if (parsed.showHelp) return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };

    const files = await resolveTestFiles(ctx.fs, ctx.cwd, parsed.globs);
    if (files.length === 0) {
      return {
        stdout: '',
        stderr: `test: no test files matched ${parsed.globs.join(' ')}\n`,
        exitCode: 1,
      };
    }

    let ts: TypeScriptModule;
    try {
      ts = await getTypeScript(createIpkContextFromCtx(ctx));
    } catch (err) {
      // `getTypeScript` already emits the canonical
      // "run `ipk add typescript`" guidance when nothing is installed;
      // surface it verbatim.
      return {
        stdout: '',
        stderr: `test: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
    const harness = await prepareTstHarness(ts);
    const userOpts = {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      allowJs: true,
      isolatedModules: false,
    } as import('typescript').CompilerOptions;

    let stdout = '';
    let stderr = '';
    let anyFailed = false;

    for (const file of files) {
      let source: string;
      try {
        source = await ctx.fs.readFile(file);
      } catch (err) {
        stderr += `test: ${file}: ${err instanceof Error ? err.message : String(err)}\n`;
        anyFailed = true;
        continue;
      }
      let userCjs: string;
      try {
        userCjs = ts.transpileModule(source, {
          compilerOptions: userOpts,
          fileName: file,
        }).outputText;
      } catch (err) {
        stderr += `test: ${file}: transpile error: ${err instanceof Error ? err.message : String(err)}\n`;
        anyFailed = true;
        continue;
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
        stderr += `test: ${file}: local-require resolve error: ${err instanceof Error ? err.message : String(err)}\n`;
        anyFailed = true;
        continue;
      }
      const runner = buildRunnerScript(
        harness,
        file,
        userCjs,
        parsed.reporter,
        localModules,
        edgeRewrites
      );
      const result = await executeJsCode(runner, ['node', file], ctx, undefined, {
        filename: file,
      });
      if (files.length > 1) stdout += `# ${file}\n`;
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.exitCode !== 0) anyFailed = true;
    }

    return { stdout, stderr, exitCode: anyFailed ? 1 : 0 };
  });
}
