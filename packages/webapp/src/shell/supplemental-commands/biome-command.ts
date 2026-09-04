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
 * Subcommands:
 *
 *   biome --version           Print the installed wasm-web version
 *   biome check  [files...]   Lint + format check together
 *   biome lint   [files...]   Lint only
 *   biome format [files...]   Print formatted output to stdout
 *                             (check with --check or write with --write)
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
import { normalizePath, pathSegments, splitPath } from '../../fs/path-utils.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';
import { executeJsCode } from '../jsh-executor.js';
import { stdinAsText } from '../just-bash-compat.js';
import { type BiomeConfiguration, resolveBiomeConfiguration } from './biome-configuration.js';
import { htmlDiagnosticsToText } from './biome-diagnostics-text.js';
import { ESBUILD_VERSION } from './esbuild-wasm.js';
import {
  biomeVirtualPath,
  isLintableFile,
  JSH_WRAP_PREFIX,
  JSH_WRAP_PREFIX_BYTE_LENGTH,
  JSH_WRAP_SUFFIX,
  shiftBiomeSpans,
  shouldWrapForBiome,
  unwrapFormattedJsh,
  wrapJshForBiome,
} from './jsh-biome-source.js';
import { GLOBAL_IPK_ADD } from './shared.js';

// The pure jsh/biome wrap/unwrap/span-shift helpers now live in
// `jsh-biome-source.ts` (the single source of truth shared, byte-aligned,
// with the standalone `biome-jsh` CLI). Re-export them here so existing
// importers and tests keep resolving them from `biome-command.js`.
export {
  biomeVirtualPath,
  isLintableFile,
  JSH_WRAP_PREFIX_BYTE_LENGTH,
  shiftBiomeSpans,
  shouldWrapForBiome,
  unwrapFormattedJsh,
  wrapJshForBiome,
};

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

const SUBCOMMANDS = new Set(['check', 'lint', 'format']);
export type BiomeSubcommand = 'check' | 'lint' | 'format';
export type BiomeReporter = 'plain' | 'json';

export interface BiomeJsonDiagnostic {
  severity: string;
  category: string;
  message: string;
  filePath: string;
  line: number | null;
  column: number | null;
}

/** Convert a span-shifted Biome diagnostic into the stable JSON reporter shape. */
export function biomeDiagnosticToJson(
  diagnostic: unknown,
  filePath: string,
  source: string
): BiomeJsonDiagnostic {
  const value = diagnostic as {
    severity?: unknown;
    category?: unknown;
    description?: unknown;
    message?: unknown;
    location?: { span?: unknown };
  };
  const markupMessage = Array.isArray(value.message)
    ? value.message
        .map((node) =>
          node &&
          typeof node === 'object' &&
          typeof (node as { content?: unknown }).content === 'string'
            ? (node as { content: string }).content
            : ''
        )
        .join('')
    : '';
  const message =
    markupMessage ||
    (typeof value.description === 'string' ? value.description : String(value.description ?? ''));
  const span = value.location?.span;
  const rawStart = Array.isArray(span) && typeof span[0] === 'number' ? span[0] : null;
  if (rawStart === null) {
    return {
      severity: typeof value.severity === 'string' ? value.severity : 'unknown',
      category: typeof value.category === 'string' ? value.category : 'unknown',
      message,
      filePath,
      line: null,
      column: null,
    };
  }
  const bytes = new TextEncoder().encode(source);
  const prefix = new TextDecoder().decode(
    bytes.slice(0, Math.max(0, Math.min(rawStart, bytes.length)))
  );
  let line = 1;
  for (const character of prefix) {
    if (character === '\n') line++;
  }
  const lastNewline = prefix.lastIndexOf('\n');
  const column = Array.from(prefix.slice(lastNewline + 1)).length + 1;
  return {
    severity: typeof value.severity === 'string' ? value.severity : 'unknown',
    category: typeof value.category === 'string' ? value.category : 'unknown',
    message,
    filePath,
    line,
    column,
  };
}

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

export const INSTALL_PACKAGES = `@biomejs/wasm-web@${BIOME_WASM_WEB_VERSION} @biomejs/js-api@${BIOME_JS_API_VERSION} esbuild-wasm@${ESBUILD_WASM_VERSION}`;

/** Pinned `ipk add` spec for each backing package, by bare name. */
export const PINNED_SPEC: Record<string, string> = {
  '@biomejs/wasm-web': `@biomejs/wasm-web@${BIOME_WASM_WEB_VERSION}`,
  '@biomejs/js-api': `@biomejs/js-api@${BIOME_JS_API_VERSION}`,
  'esbuild-wasm': `esbuild-wasm@${ESBUILD_WASM_VERSION}`,
};

const NOT_INSTALLED_HINT = `run: ${GLOBAL_IPK_ADD} ${INSTALL_PACKAGES} (no network fallback)`;

const HELP_TEXT = `biome - thin wrapper over the ipk-loaded @biomejs/wasm-web

Usage:
  biome <subcommand> [options] [files...]
  echo "code" | biome <subcommand> --stdin-file-path <path>

Subcommands:
  check         Lint + format check together
  lint          Lint only (never writes files)
  format        Print formatted output (check with --check or write with --write)

Flags:
  --write                    Write formatting changes (format / check)
  --check                    Check formatting without printing changes (format only)
  --stdin-file-path <path>   Virtual file path for stdin mode
  --config-path <file>       Use this config instead of automatic discovery
  --reporter <plain|json>    Reporter selection (default: plain)
  --json                     Alias for --reporter json
  -h, --help                 Show this help
  -v, --version              Show installed @biomejs/wasm-web version

Configuration:
  Without --config-path, starts at the first target's directory (or cwd for
  stdin), then walks toward /. At each directory biome.json is preferred over
  biome.jsonc. Comments and trailing commas are accepted. Config "extends" is
  unsupported and is not resolved. Path-based plugins are unsupported by the
  pinned WASM JavaScript API and fail with a configuration error.

Output:
  Diagnostics use plain text without HTML tags, entities, or ANSI escapes.
  The json reporter writes one document to stdout and no diagnostics to stderr:
    { summary: { errors, warnings, filesChecked, unformattedFiles },
      diagnostics: [...], files: [{ path, unchanged }] }

Exit codes:
  0  No findings; checked files are formatted
  1  Error/fatal/warning diagnostics, unformatted files under check or
     format --check, missing packages/files, or an invalid discovered config
  2  Usage error, including a missing or invalid explicit --config-path

Install:
  Inert until the backing packages are installed in node_modules:
    ${GLOBAL_IPK_ADD} ${INSTALL_PACKAGES}
  All three packages must be present in the VFS \`node_modules\` for
  lint/format to run (loading the wasm-web ESM glue also needs the
  esbuild-wasm transpiler). There is no bundled binary, no CDN
  fallback; a missing package exits non-zero with a clear \`ipk add\` hint.
`;

export interface ParsedBiomeArgs {
  subcommand: BiomeSubcommand | null;
  paths: string[];
  write: boolean;
  check: boolean;
  stdinFilePath: string | null;
  configPath: string | null;
  reporter: BiomeReporter;
  showHelp: boolean;
  showVersion: boolean;
}

function requiredOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (typeof value !== 'string' || value.startsWith('-')) {
    throw new Error(`biome: ${option} requires a value`);
  }
  return value;
}

function parseReporter(value: string): BiomeReporter {
  if (!value) throw new Error('biome: --reporter requires a value');
  if (value !== 'plain' && value !== 'json') {
    throw new Error(`biome: unknown reporter: ${value}`);
  }
  return value;
}

function argsRequestJsonReporter(args: string[]): boolean {
  return args.some(
    (arg, index) =>
      arg === '--json' ||
      arg === '--reporter=json' ||
      (arg === '--reporter' && args[index + 1] === 'json')
  );
}

function parseBiomeOption(out: ParsedBiomeArgs, args: string[], index: number): number | null {
  const arg = args[index];
  switch (arg) {
    case '-h':
    case '--help':
      out.showHelp = true;
      return index;
    case '-v':
    case '--version':
      out.showVersion = true;
      return index;
    case '--write':
      out.write = true;
      return index;
    case '--check':
      out.check = true;
      return index;
    case '--json':
      out.reporter = 'json';
      return index;
    case '--stdin-file-path':
      out.stdinFilePath = requiredOptionValue(args, index, arg);
      return index + 1;
    case '--config-path':
      out.configPath = requiredOptionValue(args, index, arg);
      return index + 1;
    case '--reporter':
      out.reporter = parseReporter(requiredOptionValue(args, index, arg));
      return index + 1;
  }
  if (arg.startsWith('--stdin-file-path=')) {
    out.stdinFilePath = requiredEqualsValue(arg, '--stdin-file-path');
    return index;
  }
  if (arg.startsWith('--config-path=')) {
    out.configPath = requiredEqualsValue(arg, '--config-path');
    return index;
  }
  if (arg.startsWith('--reporter=')) {
    out.reporter = parseReporter(arg.slice('--reporter='.length));
    return index;
  }
  return null;
}

function requiredEqualsValue(arg: string, option: string): string {
  const value = arg.slice(option.length + 1);
  if (!value) throw new Error(`biome: ${option} requires a value`);
  return value;
}

export function parseBiomeArgs(args: string[]): ParsedBiomeArgs {
  const out: ParsedBiomeArgs = {
    subcommand: null,
    paths: [],
    write: false,
    check: false,
    stdinFilePath: null,
    configPath: null,
    reporter: 'plain',
    showHelp: false,
    showVersion: false,
  };

  if (args.length === 0) {
    out.showHelp = true;
    return out;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const consumedIndex = parseBiomeOption(out, args, i);
    if (consumedIndex !== null) {
      i = consumedIndex;
      continue;
    }
    if (out.subcommand === null && SUBCOMMANDS.has(arg)) {
      out.subcommand = arg as BiomeSubcommand;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`biome: unknown option: ${arg}`);
    }
    out.paths.push(arg);
  }

  if (out.write && out.check) {
    throw new Error('biome: --write and --check cannot be used together');
  }
  if (out.check && out.subcommand !== 'format') {
    throw new Error('biome: --check is only valid with the format subcommand');
  }

  return out;
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
  check: boolean;
  configuration: BiomeConfiguration | null;
  configurationRoot: string | null;
  reporter: BiomeReporter;
  files: { path: string; biomePath: string; source: string; wrap: boolean }[];
}

interface BiomeFileResult {
  path: string;
  formatted: string | null;
  diagnosticsText: string;
  diagnostics: BiomeJsonDiagnostic[];
  errorCount: number;
  warningCount: number;
  unchanged: boolean;
}

export function biomePathFromConfigRoot(
  realPath: string,
  configurationRoot: string | null
): string {
  const virtualPath = biomeVirtualPath(normalizePath(realPath));
  if (configurationRoot === null) return virtualPath;
  const rootSegments = pathSegments(configurationRoot);
  const fileSegments = pathSegments(virtualPath);
  let shared = 0;
  while (
    shared < rootSegments.length &&
    shared < fileSegments.length &&
    rootSegments[shared] === fileSegments[shared]
  ) {
    shared++;
  }
  return [
    ...Array.from({ length: rootSegments.length - shared }, () => '..'),
    ...fileSegments.slice(shared),
  ].join('/');
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
const biomeDiagnosticToJson = ${biomeDiagnosticToJson.toString()};
function supportsFeature(biome, projectKey, path, feature) {
  const workspace = biome.workspace;
  if (!workspace || typeof workspace.fileFeatures !== 'function') {
    throw new Error('pinned @biomejs/js-api workspace does not expose file feature gates');
  }
  const supported = workspace.fileFeatures({ projectKey, path, features: [feature] });
  return supported.featuresSupported && supported.featuresSupported[feature] === 'supported';
}
async function compileBiomeWasm(wasmPath) {
  // Prefer the host-side WASM compiler: biome's ~37 MB wasm hard-OOMs
  // WebAssembly.compile inside this per-task realm worker, so the kernel
  // host reads + compiles it in its high-headroom context and hands back a
  // ready WebAssembly.Module. Fall back to an in-realm read + compile when
  // the bridge is absent (e.g. the in-process test realm) — same path
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
  const { projectKey } = biome.openProject(req.configurationRoot || undefined);
  if (req.configuration !== null) biome.applyConfiguration(projectKey, req.configuration);
  const results = [];
  for (const file of req.files) {
    const formatEnabled = req.op !== 'lint' && supportsFeature(biome, projectKey, file.biomePath, 'format');
    const lintEnabled = req.op !== 'format' && supportsFeature(biome, projectKey, file.biomePath, 'lint');
    if (!formatEnabled && !lintEnabled) continue;
    let formatted = null;
    let unchanged = true;
    let diagText = '';
    const diagnostics = [];
    let errors = 0;
    let warnings = 0;
    // .jsh/.bsh run as an AsyncFunction body, so wrap before Biome parses.
    // The body sits at column 0, so diagnostics only need their byte spans
    // shifted back by the prefix length and are printed against the ORIGINAL
    // (unwrapped) source so line/column point at the real file.
    const wrap = file.wrap === true;
    if (formatEnabled) {
      const fmtInput = wrap ? (JSH_WRAP_PREFIX + file.source + JSH_WRAP_SUFFIX) : file.source;
      const fmt = biome.formatContent(projectKey, fmtInput, { filePath: file.biomePath });
      const fmtDiags = fmt.diagnostics || [];
      if (wrap) { for (const d of fmtDiags) shiftBiomeSpans(d, JSH_WRAP_PREFIX_BYTES); }
      for (const d of fmtDiags) {
        diagnostics.push(biomeDiagnosticToJson(d, file.path, file.source));
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
    }
    if (lintEnabled) {
      const lintInput = wrap ? (JSH_WRAP_PREFIX + file.source + JSH_WRAP_SUFFIX) : file.source;
      const lint = biome.lintContent(projectKey, lintInput, { filePath: file.biomePath });
      const lintDiags = lint.diagnostics || [];
      if (wrap) { for (const d of lintDiags) shiftBiomeSpans(d, JSH_WRAP_PREFIX_BYTES); }
      for (const d of lintDiags) {
        diagnostics.push(biomeDiagnosticToJson(d, file.path, file.source));
        if (d.severity === 'error' || d.severity === 'fatal') errors++;
        else if (d.severity === 'warn' || d.severity === 'warning') warnings++;
      }
      if (lintDiags.length > 0) {
        try {
          diagText += biome.printDiagnostics(lintDiags, { filePath: file.biomePath, fileSource: file.source });
        } catch (e) { /* ignore */ }
      }
    }
    const shouldReportUnformatted =
      !unchanged && ((req.op === 'check' && !req.write) || (req.op === 'format' && req.check));
    if (shouldReportUnformatted) {
      diagText += file.path + ': file is not formatted (run with --write to fix)\\n';
      errors++;
    }
    if (file.biomePath !== file.path && diagText) {
      diagText = diagText.split(file.biomePath).join(file.path);
    }
    results.push({ path: file.path, formatted, diagnosticsText: diagText, diagnostics, errorCount: errors, warningCount: warnings, unchanged });
  }
  process.stdout.write(JSON.stringify(results));
}
main().catch((err) => { process.stderr.write(String(err && err.message || err) + '\\n'); process.exit(1); });
`;

function rewriteMissingModuleError(stderr: string): string | null {
  const m = stderr.match(/Cannot find module '(@biomejs\/[^']+)'/);
  if (!m) return null;
  const pkg = m[1].split('/').slice(0, 2).join('/');
  return `biome: ${pkg} is not installed (run: ${GLOBAL_IPK_ADD} ${PINNED_SPEC[pkg] ?? pkg}); ${NOT_INSTALLED_HINT}\n`;
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
  check: boolean,
  configuration: BiomeConfiguration | null,
  configurationRoot: string | null,
  reporter: BiomeReporter,
  files: { path: string; source: string }[],
  wasmPath: string
): Promise<RunOpsOutcome> {
  const req: BiomeRequest = {
    op,
    write,
    check,
    configuration,
    configurationRoot,
    reporter,
    files: files.map((f) => ({
      path: f.path,
      biomePath: biomePathFromConfigRoot(f.path, configurationRoot),
      source: f.source,
      wrap: shouldWrapForBiome(f.path),
    })),
  };
  const argv = ['node', '[biome-helper]', JSON.stringify(req), wasmPath];
  const result = await executeJsCode(BIOME_HELPER_SCRIPT, argv, ctx, undefined, {
    filename: '[biome-helper]',
  });
  return interpretBiomeHelperResult(result);
}

/**
 * Turn the realm helper's raw `{ stdout, stderr, exitCode }` into a
 * {@link RunOpsOutcome}. Split out and exported so the diagnostic-surfacing
 * paths can be unit-tested without booting the realm.
 *
 * Precedence:
 * 1. A non-zero exit is the helper reporting its own failure — surface its
 *    stderr (rewritten to an `ipk add` hint when it is a missing module).
 * 2. A zero exit with EMPTY stdout means the helper died producing no output
 *    (e.g. an inert esm-transpile hook). `JSON.parse('')` would otherwise
 *    throw a `failed to parse helper output` that discards the one clue we
 *    have — so surface the helper's stderr instead, keeping any it emitted.
 * 3. Otherwise parse the JSON document; a parse failure keeps the legacy
 *    message but now also appends whatever the helper wrote to stderr.
 */
export function interpretBiomeHelperResult(result: ExecResult): RunOpsOutcome {
  if (result.exitCode !== 0) {
    const rewritten = rewriteMissingModuleError(result.stderr);
    return { results: [], stderr: rewritten ?? result.stderr, exitCode: result.exitCode };
  }
  if (result.stdout.trim() === '') {
    const rewritten = rewriteMissingModuleError(result.stderr);
    const detail = rewritten ?? result.stderr.trim();
    const stderr = detail
      ? `biome: helper exited 0 with no output: ${detail.replace(/\n$/, '')}\n`
      : 'biome: helper exited 0 with no output (nothing was linted)\n';
    return { results: [], stderr, exitCode: 1 };
  }
  try {
    const parsed = JSON.parse(result.stdout) as BiomeFileResult[];
    return { results: parsed, stderr: '', exitCode: 0 };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const helperStderr = result.stderr.trim();
    const stderr = helperStderr
      ? `biome: failed to parse helper output: ${detail} (helper stderr: ${helperStderr})\n`
      : `biome: failed to parse helper output: ${detail}\n`;
    return { results: [], stderr, exitCode: 1 };
  }
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function reporterResult(
  reporter: BiomeReporter,
  result: ExecResult,
  category: string,
  filePath = ''
): ExecResult {
  if (reporter === 'plain') return result;
  const message = (result.stderr || result.stdout).trimEnd();
  const diagnostics: BiomeJsonDiagnostic[] = message
    ? [
        {
          severity: result.exitCode === 0 ? 'information' : 'error',
          category,
          message,
          filePath,
          line: null,
          column: null,
        },
      ]
    : [];
  const report = {
    summary: {
      errors: result.exitCode === 0 ? 0 : 1,
      warnings: 0,
      filesChecked: 0,
      unformattedFiles: 0,
    },
    diagnostics,
    files: [],
  };
  return { stdout: `${JSON.stringify(report)}\n`, stderr: '', exitCode: result.exitCode };
}

async function preflight(
  ctx: CommandContext,
  ipk: IpkResolutionContext
): Promise<{ wasmPath: string } | ExecResult> {
  const installed = await checkBiomeInstalled(ipk);
  if (!installed.ok) {
    return {
      stdout: '',
      stderr: `biome: ${installed.missing} is not installed (run: ${GLOBAL_IPK_ADD} ${PINNED_SPEC[installed.missing] ?? installed.missing}); ${NOT_INSTALLED_HINT}\n`,
      exitCode: 1,
    };
  }
  const wasmPath = `${installed.wasmPkgDir}/biome_wasm_bg.wasm`;
  if (!(await ctx.fs.exists(wasmPath))) {
    return {
      stdout: '',
      stderr: `biome: ${wasmPath} not found (reinstall: ${GLOBAL_IPK_ADD} ${PINNED_SPEC['@biomejs/wasm-web']})\n`,
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

export async function finalizeOutcome(
  ctx: CommandContext,
  parsed: ParsedBiomeArgs,
  inputs: { path: string; source: string }[],
  outcome: RunOpsOutcome,
  missingErrText: string
): Promise<ExecResult> {
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [missingErrText];
  let errorCount = 0;
  let warningCount = 0;
  let changed = 0;
  for (const r of outcome.results) {
    if (parsed.reporter === 'plain' && r.diagnosticsText) {
      stderrParts.push(htmlDiagnosticsToText(r.diagnosticsText));
    }
    errorCount += r.errorCount;
    warningCount += r.warningCount;
    if (parsed.write && r.formatted !== null && !r.unchanged) {
      await ctx.fs.writeFile(r.path, r.formatted);
      changed++;
    } else if (
      !parsed.write &&
      parsed.subcommand === 'format' &&
      !parsed.check &&
      inputs.length === 1 &&
      inputs[0].path === r.path
    ) {
      stdoutParts.push(r.formatted ?? inputs[0].source);
    }
  }
  if (parsed.write && changed > 0) {
    stderrParts.push(`biome: wrote ${changed} file(s)\n`);
  }
  const finalExit = errorCount > 0 || warningCount > 0 || missingErrText.length > 0 ? 1 : 0;
  if (parsed.reporter === 'json') {
    const missingDiagnostics: BiomeJsonDiagnostic[] = missingErrText
      ? [
          {
            severity: 'error',
            category: 'io',
            message: missingErrText.trimEnd(),
            filePath: '',
            line: null,
            column: null,
          },
        ]
      : [];
    const report = {
      summary: {
        errors: errorCount + missingDiagnostics.length,
        warnings: warningCount,
        filesChecked: outcome.results.length,
        unformattedFiles: outcome.results.filter((result) => !result.unchanged).length,
      },
      diagnostics: [
        ...outcome.results.flatMap((result) => result.diagnostics),
        ...missingDiagnostics,
      ],
      files: outcome.results.map((result) => ({ path: result.path, unchanged: result.unchanged })),
    };
    return { stdout: `${JSON.stringify(report)}\n`, stderr: '', exitCode: finalExit };
  }
  return { stdout: stdoutParts.join(''), stderr: stderrParts.join(''), exitCode: finalExit };
}

async function handleVersion(ipk: IpkResolutionContext): Promise<ExecResult> {
  const version = await tryReadBiomeWasmVersion(ipk);
  if (!version) {
    return {
      stdout: '',
      stderr: `biome: @biomejs/wasm-web is not installed (run: ${GLOBAL_IPK_ADD} @biomejs/wasm-web@${BIOME_WASM_WEB_VERSION}); ${NOT_INSTALLED_HINT}\n`,
      exitCode: 1,
    };
  }
  return { stdout: `${version}\n`, stderr: '', exitCode: 0 };
}

async function handleMetadataRequest(
  parsed: ParsedBiomeArgs,
  ipk: IpkResolutionContext
): Promise<ExecResult | null> {
  if (parsed.showHelp) {
    return reporterResult(parsed.reporter, { stdout: HELP_TEXT, stderr: '', exitCode: 0 }, 'usage');
  }
  if (parsed.showVersion) {
    return reporterResult(parsed.reporter, await handleVersion(ipk), 'runtime');
  }
  return null;
}

function requestedFilePath(parsed: ParsedBiomeArgs, ctx: CommandContext): string {
  const path = parsed.paths[0];
  if (!path) return '';
  try {
    return ctx.fs.resolvePath(ctx.cwd, path);
  } catch {
    return '';
  }
}

async function executeParsedBiomeCommand(
  parsed: ParsedBiomeArgs,
  ctx: CommandContext
): Promise<ExecResult> {
  const ipk = createIpkContextFromCtx(ctx);
  const metadataResult = await handleMetadataRequest(parsed, ipk);
  if (metadataResult) return metadataResult;

  if (parsed.subcommand === null) {
    return reporterResult(
      parsed.reporter,
      {
        stdout: '',
        stderr: 'biome: missing subcommand (expected check, lint, or format)\n',
        exitCode: 2,
      },
      'usage'
    );
  }

  const gathered = await gatherInputs(ctx, parsed);
  if ('exitCode' in gathered) return reporterResult(parsed.reporter, gathered, 'io');

  const searchFrom =
    parsed.paths.length === 0 && ctx.stdin ? ctx.cwd : splitPath(gathered.inputs[0].path).dir;
  const config = await resolveBiomeConfiguration(ctx.fs, ctx.cwd, searchFrom, parsed.configPath);
  if (!config.ok) {
    return reporterResult(
      parsed.reporter,
      { stdout: '', stderr: `${config.error}\n`, exitCode: config.exitCode },
      'configuration',
      gathered.inputs[0].path
    );
  }

  const pre = await preflight(ctx, ipk);
  if ('exitCode' in pre) {
    return reporterResult(parsed.reporter, pre, 'runtime', gathered.inputs[0].path);
  }

  const outcome = await runBiomeOps(
    ctx,
    parsed.subcommand,
    parsed.write,
    parsed.check,
    config.resolved?.configuration ?? null,
    config.resolved === null ? null : splitPath(config.resolved.path).dir,
    parsed.reporter,
    gathered.inputs,
    pre.wasmPath
  );
  if (outcome.exitCode !== 0) {
    return reporterResult(
      parsed.reporter,
      {
        stdout: '',
        stderr: gathered.missingErrText + outcome.stderr,
        exitCode: outcome.exitCode,
      },
      'runtime',
      gathered.inputs[0].path
    );
  }
  return finalizeOutcome(ctx, parsed, gathered.inputs, outcome, gathered.missingErrText);
}

export function createBiomeCommand(): Command {
  return defineCommand('biome', async (args, ctx): Promise<ExecResult> => {
    let parsed: ParsedBiomeArgs;
    try {
      parsed = parseBiomeArgs(args);
    } catch (err) {
      return reporterResult(
        argsRequestJsonReporter(args) ? 'json' : 'plain',
        {
          stdout: '',
          stderr: `${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 2,
        },
        'usage'
      );
    }

    try {
      return await executeParsedBiomeCommand(parsed, ctx);
    } catch (err) {
      if (parsed.reporter === 'plain') throw err;
      return reporterResult(
        'json',
        {
          stdout: '',
          stderr: `biome: ${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        },
        'runtime',
        requestedFilePath(parsed, ctx)
      );
    }
  });
}
