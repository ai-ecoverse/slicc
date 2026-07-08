/**
 * `biome` shell command — thin built-in surface that loads the
 * Biome WASM API from an ipk-installed `@biomejs/wasm-web` (and
 * `@biomejs/js-api`) in the VFS `node_modules`. Loading the
 * wasm-web ESM glue also routes through the realm's esm-transpile
 * hook, so `esbuild-wasm` must be installed too. Inert unless all
 * three packages are installed via `ipk add` — there is no bundled
 * binary anywhere on this code path, and no CDN fallback: a
 * missing package surfaces as a clean guidance error that names
 * the exact `ipk add` line.
 *
 * Subcommands (the minimum surface the prior built-in exposed):
 *
 *   biome --version           Print the installed wasm-web version
 *   biome check  [files...]   Lint + format check together
 *   biome format [files...]   Print formatted output to stdout
 *                             (or write back with --write)
 *
 * Stdin mode (no file arguments + piped input):
 *   --stdin-file-path <path>  Virtual path so Biome picks the parser
 *
 * The lint/format operations run inside the kernel realm via
 * `executeJsCode` — the realm's ipk-aware `require()` resolves
 * `@biomejs/wasm-web` and `@biomejs/js-api/web` from VFS
 * `node_modules`; the helper script compiles the wasm via the
 * host-side `__slicc_compileWasm` bridge (kernel-worker context, so
 * the 37 MB module doesn't OOM the realm worker) and hands the
 * resulting module to wasm-bindgen's `init({ module_or_path })`.
 * Missing packages
 * surface as the realm's canonical "Cannot find module" error,
 * which this wrapper rewrites into a `ipk add ...` hint.
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { splitPath } from '../../fs/path-utils.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';
import { executeJsCode } from '../jsh-executor.js';
import { stdinAsText } from '../just-bash-compat.js';
import { ESBUILD_VERSION } from './esbuild-wasm.js';

/**
 * Read-only VFS context the loader needs to find an ipk-installed
 * `@biomejs/wasm-web` in the VFS `node_modules`. Mirrors the
 * `IpkResolutionContext` shape used by `esbuild-wasm.ts` so every
 * float (standalone/hosted/extension/Node) wires it the same way.
 */
export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

export function createIpkContextFromCtx(ctx: CommandContext): IpkResolutionContext {
  return {
    reader: {
      exists: (path) => ctx.fs.exists(path),
      isDirectory: async (path) => {
        try {
          return (await ctx.fs.stat(path)).isDirectory;
        } catch {
          return false;
        }
      },
      readFile: (path) => ctx.fs.readFile(path),
    },
    readBytes: (path) => ctx.fs.readFileBuffer(path),
    fromDir: ctx.cwd,
  };
}

const LINTABLE_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'json',
  'jsonc',
  'css',
  'graphql',
  'gql',
  'html',
  'svelte',
  'vue',
  'astro',
  'jsh',
  'bsh',
]);

const SUBCOMMANDS = new Set(['check', 'format']);
export type BiomeSubcommand = 'check' | 'format';

/**
 * Pinned, verified-working dependency set. `@biomejs/wasm-web` +
 * `@biomejs/js-api` back the biome API; `esbuild-wasm` is also
 * required because loading the wasm-web ESM glue module needs the
 * realm's `esm-transpile` hook, which is inert without it.
 *
 * The biome versions are baked from `packages/webapp/package.json` via the
 * Vite / vitest `__BIOME_*__` defines, and the esbuild pin reuses
 * `ESBUILD_VERSION` (the version of the statically-bundled `esbuild-wasm`).
 * Deriving all three from the manifest means Renovate bumping the deps
 * automatically updates the `ipk add` guidance — no source literal to drift,
 * the same class of silent-version-drift bug `magick-wasm.ts` guards against.
 */
const BIOME_WASM_WEB_VERSION = __BIOME_WASM_WEB_VERSION__;
const BIOME_JS_API_VERSION = __BIOME_JS_API_VERSION__;
const ESBUILD_WASM_VERSION = ESBUILD_VERSION;

const INSTALL_PACKAGES = `@biomejs/wasm-web@${BIOME_WASM_WEB_VERSION} @biomejs/js-api@${BIOME_JS_API_VERSION} esbuild-wasm@${ESBUILD_WASM_VERSION}`;

/** Pinned `ipk add` spec for each backing package, by bare name. */
const PINNED_SPEC: Record<string, string> = {
  '@biomejs/wasm-web': `@biomejs/wasm-web@${BIOME_WASM_WEB_VERSION}`,
  '@biomejs/js-api': `@biomejs/js-api@${BIOME_JS_API_VERSION}`,
  'esbuild-wasm': `esbuild-wasm@${ESBUILD_WASM_VERSION}`,
};

const NOT_INSTALLED_HINT = `run: ipk add ${INSTALL_PACKAGES} (no network fallback)`;

const HELP_TEXT = `biome - thin wrapper over the ipk-loaded @biomejs/wasm-web

Usage:
  biome <subcommand> [options] [files...]
  echo "code" | biome <subcommand> --stdin-file-path <path>

Subcommands:
  check         Lint + format check together
  format        Print formatted output to stdout (or write with --write)

Flags:
  --write                    Write formatted output back to disk (format / check)
  --stdin-file-path <path>   Virtual file path for stdin mode
  -h, --help                 Show this help
  -v, --version              Show installed @biomejs/wasm-web version

Install:
  Inert until the backing packages are installed in node_modules:
    ipk add ${INSTALL_PACKAGES}
  All three packages must be present in the VFS \`node_modules\` for
  lint/format to run (loading the wasm-web ESM glue also needs the
  esbuild-wasm transpiler). There is no bundled binary, no CDN
  fallback; a missing package exits non-zero with a clear \`ipk add\` hint.
`;

export interface ParsedBiomeArgs {
  subcommand: BiomeSubcommand | null;
  paths: string[];
  write: boolean;
  stdinFilePath: string | null;
  showHelp: boolean;
  showVersion: boolean;
}

export function parseBiomeArgs(args: string[]): ParsedBiomeArgs {
  const out: ParsedBiomeArgs = {
    subcommand: null,
    paths: [],
    write: false,
    stdinFilePath: null,
    showHelp: false,
    showVersion: false,
  };

  if (args.length === 0) {
    out.showHelp = true;
    return out;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      out.showHelp = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      out.showVersion = true;
      continue;
    }
    if (out.subcommand === null && SUBCOMMANDS.has(arg)) {
      out.subcommand = arg as BiomeSubcommand;
      continue;
    }
    if (arg === '--write') {
      out.write = true;
      continue;
    }
    if (arg === '--stdin-file-path') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.startsWith('-')) {
        throw new Error('biome: --stdin-file-path requires a value');
      }
      out.stdinFilePath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--stdin-file-path=')) {
      out.stdinFilePath = arg.slice('--stdin-file-path='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`biome: unknown option: ${arg}`);
    }
    out.paths.push(arg);
  }

  return out;
}

export function isLintableFile(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return LINTABLE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Map a real VFS path to a virtual path Biome can parse. `.jsh`
 * scripts and `.bsh` browser helpers both run as an AsyncFunction
 * body (see {@link wrapJshForBiome}), so their content is wrapped
 * before Biome sees it and a plain `.js` parser path is correct for
 * both. Everything else is returned unchanged. The real path is
 * always preserved by the caller for write-back and diagnostics;
 * this only picks Biome's parser.
 */
export function biomeVirtualPath(realPath: string): string {
  if (realPath.endsWith('.jsh')) return `${realPath.slice(0, -'.jsh'.length)}.js`;
  if (realPath.endsWith('.bsh')) return `${realPath.slice(0, -'.bsh'.length)}.js`;
  return realPath;
}

/**
 * Wrapper that gives a `.jsh`/`.bsh` body the same AsyncFunction
 * semantics Biome must parse it under. The `jsh` executor runs each
 * script as `new AsyncFunction(...names, body)` (see
 * `kernel/realm/js-realm-shared.ts`; `.bsh` uses the same executor),
 * so top-level `await` AND top-level `return` are both valid there.
 * Without the wrapper Biome maps these files to a module and emits a
 * bogus "return outside of function" parse error (PR #1405 Codex P2).
 *
 * The body is placed at column 0 on its own lines — the prefix ends
 * in a newline and adds no indentation — so a diagnostic's column is
 * identical to the real file's column and only its byte offset shifts
 * by the prefix length (see {@link shiftBiomeSpans}).
 */
const JSH_WRAP_PREFIX = 'async function __slicc() {\n';
const JSH_WRAP_SUFFIX = '\n}';

/**
 * UTF-8 byte length of {@link JSH_WRAP_PREFIX}. Biome diagnostic spans
 * are byte offsets, so a wrapped-source span maps back to the real
 * source by subtracting this.
 */
export const JSH_WRAP_PREFIX_BYTE_LENGTH = new TextEncoder().encode(JSH_WRAP_PREFIX).length;

/** Wrap a `.jsh`/`.bsh` body for Biome. Inverse: {@link unwrapFormattedJsh}. */
export function wrapJshForBiome(source: string): string {
  return JSH_WRAP_PREFIX + source + JSH_WRAP_SUFFIX;
}

/** True when `realPath` is a SLICC shell script whose body needs the
 * AsyncFunction wrapper before Biome can parse it. */
export function shouldWrapForBiome(realPath: string): boolean {
  return realPath.endsWith('.jsh') || realPath.endsWith('.bsh');
}

/**
 * Recursively shift every Biome diagnostic byte `span` back by `delta`
 * (clamped ≥ 0) so diagnostics computed on the wrapped source render
 * against the ORIGINAL file. Also nulls any embedded `sourceCode`
 * string so `printDiagnostics({ fileSource })` frames the real source
 * rather than the wrapped copy. Mutates `root` in place. Iterative (no
 * self-reference) so it survives verbatim embedding.
 *
 * NOTE: embedded into {@link BIOME_HELPER_SCRIPT} via `.toString()` —
 * keep it self-contained (globals only, no closure over module scope).
 */
export function shiftBiomeSpans(root: unknown, delta: number): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    const obj = node as Record<string, unknown>;
    const span = obj.span;
    if (
      Array.isArray(span) &&
      span.length === 2 &&
      typeof span[0] === 'number' &&
      typeof span[1] === 'number'
    ) {
      obj.span = [Math.max(0, span[0] - delta), Math.max(0, span[1] - delta)];
    }
    if (typeof obj.sourceCode === 'string') obj.sourceCode = null;
    for (const key of Object.keys(obj)) {
      if (key === 'span' || key === 'sourceCode') continue;
      stack.push(obj[key]);
    }
  }
}

/**
 * Strip the async-function wrapper Biome added around a formatted
 * `.jsh`/`.bsh` body: drop the first line (`async function __slicc() {`)
 * and the last line (`}`), then remove exactly one leading TAB (Biome's
 * default indent unit) from each remaining line. A trailing newline is
 * always emitted (Biome-formatted output ends in one).
 *
 * This de-indent is NOT lossless for multi-line template literals whose
 * continuation lines start with a real tab — Biome preserves those
 * verbatim, so stripping a leading tab would corrupt them. Callers MUST
 * guard the result with a re-format round-trip (see the helper) and fall
 * back to the original content when it does not reproduce the formatted
 * wrapped output.
 *
 * NOTE: embedded into {@link BIOME_HELPER_SCRIPT} via `.toString()` —
 * keep it self-contained (globals only, no closure over module scope).
 */
export function unwrapFormattedJsh(formatted: string): string {
  const trimmed = formatted.endsWith('\n') ? formatted.slice(0, -1) : formatted;
  const lines = trimmed.split('\n');
  lines.shift();
  lines.pop();
  const body = lines.map((line) => (line.startsWith('\t') ? line.slice(1) : line));
  return body.join('\n') + '\n';
}

/**
 * Expand `paths` into a flat list of concrete file paths. Each
 * input may be a file (kept as-is) or a directory (walked
 * recursively, filtered by `isLintableFile`). Missing entries are
 * tracked separately so the caller can surface a diagnostic per
 * missing argument instead of failing the run.
 */
export async function expandPaths(
  fs: CommandContext['fs'],
  cwd: string,
  paths: string[]
): Promise<{ files: string[]; missing: string[] }> {
  const files: string[] = [];
  const missing: string[] = [];
  for (const raw of paths) {
    const resolved = fs.resolvePath(cwd, raw);
    if (!(await fs.exists(resolved))) {
      missing.push(raw);
      continue;
    }
    const stat = (await fs.stat?.(resolved)) as
      | { isFile?: boolean; isDirectory?: boolean }
      | undefined;
    if (stat?.isDirectory) {
      await walkDirectory(fs, resolved, files);
    } else if (isLintableFile(resolved)) {
      files.push(resolved);
    }
  }
  return { files, missing };
}

async function walkDirectory(fs: CommandContext['fs'], dir: string, out: string[]): Promise<void> {
  const entries = (await fs.readdir?.(dir)) ?? [];
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    const full = dir === '/' ? `/${name}` : `${dir}/${name}`;
    const stat = (await fs.stat?.(full)) as { isFile?: boolean; isDirectory?: boolean } | undefined;
    if (stat?.isDirectory) {
      await walkDirectory(fs, full, out);
    } else if (isLintableFile(full)) {
      out.push(full);
    }
  }
}

/**
 * Try to read the installed `@biomejs/wasm-web` version by
 * resolving its `package.json` from VFS `node_modules`. Returns
 * `null` when nothing is installed — the caller surfaces the
 * canonical guidance error.
 *
 * Exported so the loader's resolution behavior is unit-testable
 * without booting the heavy WASM workspace.
 */
export async function tryReadBiomeWasmVersion(ipk: IpkResolutionContext): Promise<string | null> {
  let resolved;
  try {
    resolved = await ipkResolve('@biomejs/wasm-web/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  try {
    const text = await ipk.reader.readFile(resolved.path);
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Check that all three backing packages — `@biomejs/wasm-web`,
 * `@biomejs/js-api`, and `esbuild-wasm` — are installed in the VFS
 * `node_modules`. `esbuild-wasm` is required because loading the
 * wasm-web ESM glue runs through the realm's esm-transpile hook,
 * which is inert without it (an absent transpiler surfaces as a
 * confusing `failed to parse helper output` at runtime, so we fail
 * closed here instead). Returns the resolved `@biomejs/wasm-web`
 * package directory on success, or a guidance string naming the
 * missing package on failure. Exported for unit-testing the
 * install-required path without booting the realm.
 */
export async function checkBiomeInstalled(
  ipk: IpkResolutionContext
): Promise<{ ok: true; wasmPkgDir: string } | { ok: false; missing: string }> {
  let wasmWeb;
  try {
    wasmWeb = await ipkResolve('@biomejs/wasm-web/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return { ok: false, missing: '@biomejs/wasm-web' };
  }
  if (wasmWeb.type !== 'file') return { ok: false, missing: '@biomejs/wasm-web' };
  try {
    const jsApi = await ipkResolve('@biomejs/js-api/web', ipk.fromDir, ipk.reader);
    if (jsApi.type !== 'file') return { ok: false, missing: '@biomejs/js-api' };
  } catch {
    return { ok: false, missing: '@biomejs/js-api' };
  }
  try {
    const esbuild = await ipkResolve('esbuild-wasm/package.json', ipk.fromDir, ipk.reader);
    if (esbuild.type !== 'file') return { ok: false, missing: 'esbuild-wasm' };
  } catch {
    return { ok: false, missing: 'esbuild-wasm' };
  }
  return { ok: true, wasmPkgDir: splitPath(wasmWeb.path).dir };
}

/**
 * Per-file biome operation request piped into the realm helper as
 * JSON in `process.argv[2]`. The helper streams JSON-encoded result
 * objects back on stdout; the wrapper parses + formats them.
 */
interface BiomeRequest {
  op: BiomeSubcommand;
  write: boolean;
  files: { path: string; biomePath: string; source: string; wrap: boolean }[];
}

interface BiomeFileResult {
  path: string;
  formatted: string | null;
  diagnosticsText: string;
  errorCount: number;
  warningCount: number;
  unchanged: boolean;
}

/**
 * Helper script run inside the kernel realm. Loads
 * `@biomejs/wasm-web` + `@biomejs/js-api/web` via the realm's
 * ipk-aware `require()` (which throws the canonical
 * "Cannot find module 'X' (run: ipk install X)" when a package
 * is absent — we rewrite that to a clean `ipk add` hint above).
 *
 * The wasm is compiled to a `WebAssembly.Module` via the host-side
 * `globalThis.__slicc_compileWasm(path)` bridge (the kernel realm-host
 * `wasm` channel) so biome's ~37 MB binary compiles in the high-headroom
 * kernel-worker context instead of OOM-ing this per-task realm worker;
 * the helper falls back to an in-realm `fs.readFileBinary` + compile when
 * the bridge is absent. wasm-bindgen accepts the module via
 * `init({ module_or_path })`, which sidesteps its
 * `new URL('biome_wasm_bg.wasm', import.meta.url)` fallback — which never
 * works inside the realm and would in any case violate the no-network
 * constraint.
 *
 * Output is a single JSON document on stdout, parsed by
 * {@link runBiomeOps}. The helper never writes back to disk; the
 * wrapper applies `--write` against the host VFS so all writes
 * pass through the same sudo-fs gate the rest of the shell uses.
 */
const BIOME_HELPER_SCRIPT = `
const fs = require('fs');
const JSH_WRAP_PREFIX = ${JSON.stringify(JSH_WRAP_PREFIX)};
const JSH_WRAP_SUFFIX = ${JSON.stringify(JSH_WRAP_SUFFIX)};
const JSH_WRAP_PREFIX_BYTES = ${JSH_WRAP_PREFIX_BYTE_LENGTH};
const shiftBiomeSpans = ${shiftBiomeSpans.toString()};
const unwrapFormattedJsh = ${unwrapFormattedJsh.toString()};
async function compileBiomeWasm(wasmPath) {
  // Prefer the host-side WASM compiler: biome's ~37 MB wasm hard-OOMs
  // WebAssembly.compile inside this per-task realm worker, so the kernel
  // host reads + compiles it in its high-headroom context and hands back a
  // ready WebAssembly.Module. Fall back to an in-realm read + compile when
  // the bridge is absent (e.g. the cross-origin iframe realm) — same path
  // the helper used before host compilation existed.
  if (typeof globalThis.__slicc_compileWasm === 'function') {
    try {
      return await globalThis.__slicc_compileWasm(wasmPath);
    } catch (e) {
      // Host compile unavailable / Module not cloneable in this float —
      // fall through to the in-realm path.
    }
  }
  const wasmBytes = await fs.readFileBinary(wasmPath);
  const buf = new ArrayBuffer(wasmBytes.byteLength);
  new Uint8Array(buf).set(wasmBytes);
  return WebAssembly.compile(buf);
}
async function main() {
  const req = JSON.parse(process.argv[2]);
  const wasmPath = process.argv[3];
  const wasmModule = await compileBiomeWasm(wasmPath);
  const wasmWeb = require('@biomejs/wasm-web');
  const init = wasmWeb.default || wasmWeb;
  await init({ module_or_path: wasmModule });
  const jsApi = require('@biomejs/js-api/web');
  const Biome = jsApi.Biome || (jsApi.default && jsApi.default.Biome);
  if (!Biome) throw new Error('@biomejs/js-api/web does not export Biome');
  const biome = new Biome();
  const { projectKey } = biome.openProject();
  const results = [];
  for (const file of req.files) {
    let formatted = null;
    let unchanged = true;
    let diagText = '';
    let errors = 0;
    let warnings = 0;
    // .jsh/.bsh run as an AsyncFunction body, so wrap before Biome parses.
    // The body sits at column 0, so diagnostics only need their byte spans
    // shifted back by the prefix length and are printed against the ORIGINAL
    // (unwrapped) source so line/column point at the real file.
    const wrap = file.wrap === true;
    const fmtInput = wrap ? (JSH_WRAP_PREFIX + file.source + JSH_WRAP_SUFFIX) : file.source;
    const fmt = biome.formatContent(projectKey, fmtInput, { filePath: file.biomePath });
    const fmtDiags = fmt.diagnostics || [];
    if (wrap) { for (const d of fmtDiags) shiftBiomeSpans(d, JSH_WRAP_PREFIX_BYTES); }
    for (const d of fmtDiags) {
      if (d.severity === 'error' || d.severity === 'fatal') errors++;
      else if (d.severity === 'warn' || d.severity === 'warning') warnings++;
    }
    if (fmtDiags.length > 0) {
      try {
        diagText += biome.printDiagnostics(fmtDiags, { filePath: file.biomePath, fileSource: file.source });
      } catch (e) { /* ignore */ }
    }
    // Determine the formatted content in REAL-file terms. For wrapped files
    // that means unwrapping Biome's output, then a re-format round-trip guard:
    // if re-wrapping + re-formatting the unwrapped body does not reproduce
    // Biome's wrapped output, the de-indent was lossy (e.g. a multi-line
    // template literal with tab-prefixed content) — keep the file UNCHANGED
    // rather than write corrupted output.
    let formattedContent = fmt.content;
    if (wrap) {
      if (fmt.content === fmtInput) {
        formattedContent = file.source;
      } else {
        const candidate = unwrapFormattedJsh(fmt.content);
        const reFmt = biome.formatContent(projectKey, JSH_WRAP_PREFIX + candidate + JSH_WRAP_SUFFIX, { filePath: file.biomePath });
        formattedContent = reFmt.content === fmt.content ? candidate : file.source;
      }
    }
    if (formattedContent !== file.source) {
      formatted = formattedContent;
      unchanged = false;
    }
    if (req.op === 'check') {
      const lintInput = wrap ? (JSH_WRAP_PREFIX + file.source + JSH_WRAP_SUFFIX) : file.source;
      const lint = biome.lintContent(projectKey, lintInput, { filePath: file.biomePath });
      const lintDiags = lint.diagnostics || [];
      if (wrap) { for (const d of lintDiags) shiftBiomeSpans(d, JSH_WRAP_PREFIX_BYTES); }
      for (const d of lintDiags) {
        if (d.severity === 'error' || d.severity === 'fatal') errors++;
        else if (d.severity === 'warn' || d.severity === 'warning') warnings++;
      }
      if (lintDiags.length > 0) {
        try {
          diagText += biome.printDiagnostics(lintDiags, { filePath: file.biomePath, fileSource: file.source });
        } catch (e) { /* ignore */ }
      }
      if (!unchanged && !req.write) {
        diagText += file.path + ': file is not formatted (run with --write to fix)\\n';
        errors++;
      }
    }
    if (file.biomePath !== file.path && diagText) {
      diagText = diagText.split(file.biomePath).join(file.path);
    }
    results.push({ path: file.path, formatted, diagnosticsText: diagText, errorCount: errors, warningCount: warnings, unchanged });
  }
  process.stdout.write(JSON.stringify(results));
}
main().catch((err) => { process.stderr.write(String(err && err.message || err) + '\\n'); process.exit(1); });
`;

function rewriteMissingModuleError(stderr: string): string | null {
  const m = stderr.match(/Cannot find module '(@biomejs\/[^']+)'/);
  if (!m) return null;
  const pkg = m[1].split('/').slice(0, 2).join('/');
  return `biome: ${pkg} is not installed (run: ipk add ${pkg}); ${NOT_INSTALLED_HINT}\n`;
}

interface RunOpsOutcome {
  results: BiomeFileResult[];
  stderr: string;
  exitCode: number;
}

async function runBiomeOps(
  ctx: CommandContext,
  op: BiomeSubcommand,
  write: boolean,
  files: { path: string; source: string }[],
  wasmPath: string
): Promise<RunOpsOutcome> {
  const req: BiomeRequest = {
    op,
    write,
    files: files.map((f) => ({
      path: f.path,
      biomePath: biomeVirtualPath(f.path),
      source: f.source,
      wrap: shouldWrapForBiome(f.path),
    })),
  };
  const argv = ['node', '[biome-helper]', JSON.stringify(req), wasmPath];
  const result = await executeJsCode(BIOME_HELPER_SCRIPT, argv, ctx, undefined, {
    filename: '[biome-helper]',
  });
  if (result.exitCode !== 0) {
    const rewritten = rewriteMissingModuleError(result.stderr);
    return { results: [], stderr: rewritten ?? result.stderr, exitCode: result.exitCode };
  }
  try {
    const parsed = JSON.parse(result.stdout) as BiomeFileResult[];
    return { results: parsed, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      results: [],
      stderr: `biome: failed to parse helper output: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };

async function preflight(
  ctx: CommandContext,
  ipk: IpkResolutionContext
): Promise<{ wasmPath: string } | ExecResult> {
  const installed = await checkBiomeInstalled(ipk);
  if (!installed.ok) {
    return {
      stdout: '',
      stderr: `biome: ${installed.missing} is not installed (run: ipk add ${PINNED_SPEC[installed.missing] ?? installed.missing}); ${NOT_INSTALLED_HINT}\n`,
      exitCode: 1,
    };
  }
  const wasmPath = `${installed.wasmPkgDir}/biome_wasm_bg.wasm`;
  if (!(await ctx.fs.exists(wasmPath))) {
    return {
      stdout: '',
      stderr: `biome: ${wasmPath} not found (reinstall: ipk add ${PINNED_SPEC['@biomejs/wasm-web']})\n`,
      exitCode: 1,
    };
  }
  return { wasmPath };
}

interface GatheredInputs {
  inputs: { path: string; source: string }[];
  missingErrText: string;
}

async function gatherInputs(
  ctx: CommandContext,
  parsed: ParsedBiomeArgs
): Promise<GatheredInputs | ExecResult> {
  if (parsed.paths.length === 0 && ctx.stdin) {
    const virtualPath = parsed.stdinFilePath ?? '/stdin.ts';
    return { inputs: [{ path: virtualPath, source: stdinAsText(ctx.stdin) }], missingErrText: '' };
  }
  if (parsed.paths.length === 0) {
    return { stdout: '', stderr: 'biome: no files or directories specified\n', exitCode: 2 };
  }
  const expanded = await expandPaths(ctx.fs, ctx.cwd, parsed.paths);
  const missingErrText = expanded.missing
    .map((m) => `biome: ${m}: no such file or directory\n`)
    .join('');
  const inputs: { path: string; source: string }[] = [];
  for (const file of expanded.files) {
    inputs.push({ path: file, source: await ctx.fs.readFile(file) });
  }
  if (inputs.length === 0) {
    return {
      stdout: '',
      stderr: `${missingErrText}biome: no lintable files found\n`,
      exitCode: expanded.missing.length > 0 ? 1 : 0,
    };
  }
  return { inputs, missingErrText };
}

async function finalizeOutcome(
  ctx: CommandContext,
  parsed: ParsedBiomeArgs,
  inputs: { path: string; source: string }[],
  outcome: RunOpsOutcome,
  missingErrText: string
): Promise<ExecResult> {
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [missingErrText];
  let errorCount = 0;
  let changed = 0;
  for (const r of outcome.results) {
    if (r.diagnosticsText) stderrParts.push(r.diagnosticsText);
    errorCount += r.errorCount;
    if (parsed.write && r.formatted !== null && !r.unchanged) {
      await ctx.fs.writeFile(r.path, r.formatted);
      changed++;
    } else if (
      !parsed.write &&
      parsed.subcommand === 'format' &&
      inputs.length === 1 &&
      inputs[0].path === r.path
    ) {
      stdoutParts.push(r.formatted ?? inputs[0].source);
    }
  }
  if (parsed.write && changed > 0) {
    stderrParts.push(`biome: wrote ${changed} file(s)\n`);
  }
  const finalExit = errorCount > 0 || missingErrText.length > 0 ? 1 : 0;
  return { stdout: stdoutParts.join(''), stderr: stderrParts.join(''), exitCode: finalExit };
}

async function handleVersion(ipk: IpkResolutionContext): Promise<ExecResult> {
  const version = await tryReadBiomeWasmVersion(ipk);
  if (!version) {
    return {
      stdout: '',
      stderr: `biome: @biomejs/wasm-web is not installed (run: ipk add @biomejs/wasm-web@${BIOME_WASM_WEB_VERSION}); ${NOT_INSTALLED_HINT}\n`,
      exitCode: 1,
    };
  }
  return { stdout: `${version}\n`, stderr: '', exitCode: 0 };
}

export function createBiomeCommand(): Command {
  return defineCommand('biome', async (args, ctx): Promise<ExecResult> => {
    let parsed: ParsedBiomeArgs;
    try {
      parsed = parseBiomeArgs(args);
    } catch (err) {
      return {
        stdout: '',
        stderr: `${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 2,
      };
    }

    if (parsed.showHelp) return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };

    const ipk = createIpkContextFromCtx(ctx);
    if (parsed.showVersion) return handleVersion(ipk);

    if (parsed.subcommand === null) {
      return {
        stdout: '',
        stderr: 'biome: missing subcommand (expected check or format)\n',
        exitCode: 2,
      };
    }

    const pre = await preflight(ctx, ipk);
    if ('exitCode' in pre) return pre;

    const gathered = await gatherInputs(ctx, parsed);
    if ('exitCode' in gathered) return gathered;

    const outcome = await runBiomeOps(
      ctx,
      parsed.subcommand,
      parsed.write,
      gathered.inputs,
      pre.wasmPath
    );
    if (outcome.exitCode !== 0) {
      return {
        stdout: '',
        stderr: gathered.missingErrText + outcome.stderr,
        exitCode: outcome.exitCode,
      };
    }
    return finalizeOutcome(ctx, parsed, gathered.inputs, outcome, gathered.missingErrText);
  });
}
