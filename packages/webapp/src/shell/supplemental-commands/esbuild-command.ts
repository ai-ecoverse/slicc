/**
 * `esbuild` shell command — thin built-in surface over the
 * ipk-loaded `esbuild-wasm` JS API (`getEsbuild` in
 * `esbuild-wasm.ts`). Inert until the user has installed
 * `esbuild-wasm` via `ipk add esbuild-wasm`; without the package,
 * the loader throws the canonical guidance error which this
 * command surfaces verbatim. ZERO network in the not-installed
 * path — there is no CDN fallback anywhere on this code path.
 *
 * Two surfaces:
 *
 *  1. **`esbuild --bundle <entry> [--outfile <path>]`**: bundles
 *     the entry point and all transitively resolved local imports
 *     into a single output. Local paths read from the VFS via
 *     `ctx.fs`; bare specifiers (`react`, `lodash/fp`, …) resolve
 *     through the shared ipk `resolve` (the same `node_modules`
 *     walk the realm uses), so a `bundle` against an
 *     ipk-installed dep tree runs fully offline.
 *
 *  2. **`esbuild --transform <file>`** (or stdin → stdout): runs
 *     the single-file `transform` API. Supports `--format`,
 *     `--minify`, `--sourcemap`, `--target`, and `--loader`.
 *
 * Output goes to the VFS via `ctx.fs.writeFile` (or stdout when
 * no `--outfile` is supplied and we are in transform mode). Build
 * errors and warnings render through esbuild's own formatter for
 * fidelity with the upstream CLI.
 */

import type { BuildOptions, Loader, Plugin, TransformOptions } from 'esbuild-wasm';
import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { resolve as ipkResolve } from '../ipk/resolver.js';
import { stdinAsText } from '../just-bash-compat.js';
import { getEsbuild, type IpkResolutionContext } from './esbuild-wasm.js';
import { basename, dirname, joinPath } from './shared.js';

/**
 * Build an {@link IpkResolutionContext} from a command's `ctx` so
 * `getEsbuild` can locate the ipk-installed `esbuild-wasm` in the
 * VFS `node_modules`. Same shape used by the resolver for module
 * lookups inside the bundle plugin's onResolve for bare specifiers.
 * Mirrored across every float (standalone/hosted/extension/Node) —
 * the kernel host hands the orchestrator a single VFS handle, and
 * every shell built off it gets this adapter for free.
 */
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

const HELP_TEXT = `esbuild - thin wrapper over the ipk-loaded esbuild-wasm

Usage:
  esbuild [options] <entry>                         Bundle / transform
  echo "code" | esbuild [options]                   Transform stdin

Modes:
  --bundle                  Bundle the entry + its imports into one output
  --transform               Single-file transform (default when --bundle is absent)

Output:
  --outfile <path>          Write the bundled / transformed output to <path>
  --format=<iife|cjs|esm>   Output format (default: esm)
  --platform=<browser|node|neutral>
                            Target platform
  --minify                  Enable all minification passes
  --tree-shaking[=true|false]
                            Enable or disable tree shaking
  --sourcemap[=inline|external|linked|both]
                            Emit source maps
  --target=<csv>            Comma-separated target list (e.g. es2020,chrome100)
  --loader=<loader>         Force loader for stdin / single-file transform
                            (js, ts, jsx, tsx, json, text, base64, dataurl)
  --define:<key>=<value>    Substitute a global identifier (repeatable)

Bundle-only:
  --external:<pattern>      Keep matching imports external; supports * (repeatable)
  --banner:<type>=<value>   Prepend content to an output type
  --footer:<type>=<value>   Append content to an output type

Module resolution:
  - Local paths (./foo, /workspace/bar) read from the VFS.
  - Bare specifiers (react, lodash/fp, ...) resolve from the
    nearest ipk-installed node_modules; install missing deps via
    \`ipk add <pkg>\`. No network fallback.

Install:
  Inert until the backing package is installed:
    ipk add esbuild-wasm
  Then \`esbuild --version\` and the bundle/transform commands above.
`;

export interface ParsedEsbuildArgs {
  entries: string[];
  bundle: boolean;
  transform: boolean;
  outfile: string | null;
  format: 'iife' | 'cjs' | 'esm' | null;
  minify: boolean;
  sourcemap: BuildOptions['sourcemap'] | null;
  target: string[] | null;
  loader: Loader | null;
  external: string[];
  platform: 'browser' | 'node' | 'neutral' | null;
  define: Record<string, string>;
  banner: Record<string, string>;
  footer: Record<string, string>;
  treeShaking: boolean | null;
  showHelp: boolean;
  showVersion: boolean;
}

const VALID_FORMATS = new Set(['iife', 'cjs', 'esm']);
const VALID_PLATFORMS = new Set(['browser', 'node', 'neutral']);
const VALID_SOURCEMAPS = new Set(['linked', 'inline', 'external', 'both']);

const BOOLEAN_FLAGS: Record<string, keyof ParsedEsbuildArgs> = {
  '-h': 'showHelp',
  '--help': 'showHelp',
  '-v': 'showVersion',
  '--version': 'showVersion',
  '--bundle': 'bundle',
  '--transform': 'transform',
  '--minify': 'minify',
};

interface FlagToken {
  /** Long-opt token without `=value`, otherwise the raw arg. */
  key: string;
  /** Inline value after `=`; null when the flag was bare or value-less. */
  inlineValue: string | null;
}

function tokenize(arg: string): FlagToken {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq > 0) return { key: arg.slice(0, eq), inlineValue: arg.slice(eq + 1) };
  }
  return { key: arg, inlineValue: null };
}

function takeValue(
  token: FlagToken,
  args: string[],
  i: number
): { value: string; advance: number } {
  if (token.inlineValue !== null) return { value: token.inlineValue, advance: 0 };
  const next = args[i + 1];
  if (typeof next !== 'string' || next.startsWith('-')) {
    throw new Error(`esbuild: ${token.key} requires a value`);
  }
  return { value: next, advance: 1 };
}

function applySourcemap(
  out: ParsedEsbuildArgs,
  token: FlagToken,
  args: string[],
  i: number
): number {
  if (token.inlineValue !== null) {
    if (!VALID_SOURCEMAPS.has(token.inlineValue)) {
      throw new Error(
        `esbuild: --sourcemap value must be one of linked|inline|external|both (got "${token.inlineValue}")`
      );
    }
    out.sourcemap = token.inlineValue as BuildOptions['sourcemap'];
    return 0;
  }
  const next = args[i + 1];
  if (typeof next === 'string' && VALID_SOURCEMAPS.has(next)) {
    out.sourcemap = next as BuildOptions['sourcemap'];
    return 1;
  }
  out.sourcemap = true;
  return 0;
}

function applyValuedFlag(
  out: ParsedEsbuildArgs,
  token: FlagToken,
  args: string[],
  i: number
): number {
  if (token.key === '--outfile') {
    const { value, advance } = takeValue(token, args, i);
    out.outfile = value;
    return advance;
  }
  if (token.key === '--format') {
    const { value, advance } = takeValue(token, args, i);
    if (!VALID_FORMATS.has(value)) {
      throw new Error(`esbuild: --format must be one of iife|cjs|esm (got "${value}")`);
    }
    out.format = value as 'iife' | 'cjs' | 'esm';
    return advance;
  }
  if (token.key === '--platform') {
    const { value, advance } = takeValue(token, args, i);
    if (!VALID_PLATFORMS.has(value)) {
      throw new Error(`esbuild: --platform must be one of browser|node|neutral (got "${value}")`);
    }
    out.platform = value as 'browser' | 'node' | 'neutral';
    return advance;
  }
  if (token.key === '--target') {
    const { value, advance } = takeValue(token, args, i);
    out.target = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return advance;
  }
  if (token.key === '--loader') {
    const { value, advance } = takeValue(token, args, i);
    out.loader = value as Loader;
    return advance;
  }
  return -1;
}

function applyColonAssignment(
  arg: string,
  prefix: '--define:' | '--banner:' | '--footer:',
  target: Record<string, string>
): boolean {
  if (!arg.startsWith(prefix)) return false;
  const assignment = arg.slice(prefix.length);
  const eq = assignment.indexOf('=');
  if (eq < 1) throw new Error(`esbuild: ${prefix.slice(0, -1)} requires <key>=<value>`);
  target[assignment.slice(0, eq)] = assignment.slice(eq + 1);
  return true;
}

export function parseEsbuildArgs(args: string[]): ParsedEsbuildArgs {
  const out: ParsedEsbuildArgs = {
    entries: [],
    bundle: false,
    transform: false,
    outfile: null,
    format: null,
    minify: false,
    sourcemap: null,
    target: null,
    loader: null,
    external: [],
    platform: null,
    define: {},
    banner: {},
    footer: {},
    treeShaking: null,
    showHelp: false,
    showVersion: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const boolKey = BOOLEAN_FLAGS[arg];
    if (boolKey) {
      (out[boolKey] as boolean) = true;
      continue;
    }
    if (arg.startsWith('--external:')) {
      out.external.push(arg.slice('--external:'.length));
      continue;
    }
    if (
      applyColonAssignment(arg, '--define:', out.define) ||
      applyColonAssignment(arg, '--banner:', out.banner) ||
      applyColonAssignment(arg, '--footer:', out.footer)
    ) {
      continue;
    }
    const token = tokenize(arg);
    if (token.key === '--tree-shaking') {
      if (token.inlineValue === null) {
        out.treeShaking = true;
      } else if (token.inlineValue === 'true' || token.inlineValue === 'false') {
        out.treeShaking = token.inlineValue === 'true';
      } else {
        throw new Error(
          `esbuild: --tree-shaking must be true or false (got "${token.inlineValue}")`
        );
      }
      continue;
    }
    if (token.key === '--sourcemap') {
      i += applySourcemap(out, token, args, i);
      continue;
    }
    const advance = applyValuedFlag(out, token, args, i);
    if (advance >= 0) {
      i += advance;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`esbuild: unknown option: ${arg}`);
    }
    out.entries.push(arg);
  }

  return out;
}

/**
 * Build a plugin that bridges esbuild's resolver to the VFS for
 * local paths and to ipk-installed `node_modules` for bare
 * specifiers. The plugin captures `fs` + `cwd` from the calling
 * shell ctx and an `IpkResolutionContext` for the shared
 * `node_modules` walk; it routes every load through one of three
 * branches:
 *
 *  - VFS file (default namespace): read via `ctx.fs.readFile`
 *    and forward the contents to esbuild with the loader inferred
 *    from the extension.
 *  - Bare specifier: resolve through the shared ipk `resolve`
 *    (same `node_modules` walk the realm uses). The resolved
 *    absolute VFS path goes back through the default namespace's
 *    load step. A missing package surfaces as an esbuild error
 *    that names the package and the suggested `ipk add` line.
 *  - External: `node:` / `data:` and other non-`file:` protocols
 *    are marked external so esbuild does not try to load bytes
 *    for them.
 */
export function createVfsPlugin(
  fs: CommandContext['fs'],
  cwd: string,
  ipk: IpkResolutionContext,
  externals: string[],
  platform: ParsedEsbuildArgs['platform']
): Plugin {
  return {
    name: 'slicc-vfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (matchesExternal(args.path, externals)) {
          return { path: args.path, external: true };
        }

        // `node:` / `data:` / etc. — mark external; esbuild emits an
        // import without trying to load bytes. Real bundling of node
        // builtins is out of scope for the browser float.
        if (/^[a-z]+:/.test(args.path) && !args.path.startsWith('file:')) {
          return { path: args.path, external: true };
        }

        // Relative / absolute VFS path.
        if (isVfsPath(args.path)) {
          const importerDir = args.importer?.startsWith('/') ? dirname(args.importer) : cwd;
          const resolved = fs.resolvePath(importerDir, args.path);
          const withExt = await resolveWithExtensions(fs, resolved);
          return { path: withExt };
        }

        // Bare specifier — resolve from ipk-installed node_modules.
        // No network fallback: a missing dep is surfaced as an
        // esbuild error pointing the user at the exact `ipk add`.
        return resolveBareSpecifier(
          args.path,
          args.importer,
          ipk,
          ipkConditionsForPlatform(platform, args.kind)
        );
      });

      // VFS load (default namespace).
      build.onLoad({ filter: /.*/ }, async (args) => {
        if (args.namespace && args.namespace !== 'file') return null;
        const contents = await fs.readFile(args.path);
        return { contents, loader: inferLoader(args.path), resolveDir: dirname(args.path) };
      });
    },
  };
}

export function matchesExternal(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (path === pattern) return true;
    if (!pattern.includes('*')) {
      return !isVfsPath(pattern) && path.startsWith(`${pattern}/`);
    }
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '.*');
    return new RegExp(`^${escaped}$`).test(path);
  });
}

function ipkConditionsForPlatform(platform: ParsedEsbuildArgs['platform'], kind: string): string[] {
  const accessKind = kind === 'require-call' || kind === 'require-resolve' ? 'require' : 'import';
  switch (platform ?? 'browser') {
    case 'browser':
      return ['browser', accessKind, 'default'];
    case 'node':
      return ['node', accessKind, 'default'];
    case 'neutral':
      return [accessKind, 'default'];
  }
}

function isVfsPath(path: string): boolean {
  return path.startsWith('./') || path.startsWith('../') || path.startsWith('/');
}

async function resolveBareSpecifier(
  path: string,
  importer: string | undefined,
  ipk: IpkResolutionContext,
  conditions: string[]
): Promise<{ path?: string; external?: boolean; errors?: { text: string }[] }> {
  const importerDir = importer?.startsWith('/') ? dirname(importer) : ipk.fromDir;
  try {
    const result = await ipkResolve(path, importerDir, ipk.reader, { conditions });
    if (result.type === 'file') return { path: result.path };
    return { path, external: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { errors: [{ text: reason }] };
  }
}

/**
 * Map a path's extension to an esbuild loader. Unknown extensions
 * default to `'js'` — esbuild will still parse it as JS, which
 * matches the upstream CLI's behavior for files without a hint.
 */
export function inferLoader(path: string): Loader {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'js';
  const ext = name.slice(dot + 1);
  switch (ext) {
    case 'ts':
      return 'ts';
    case 'tsx':
      return 'tsx';
    case 'jsx':
      return 'jsx';
    case 'mjs':
    case 'cjs':
    case 'js':
      return 'js';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'txt':
      return 'text';
    default:
      return 'js';
  }
}

/**
 * Resolve a bare path candidate against the VFS, trying common
 * extensions in the same order esbuild itself does. Returns the
 * original path when nothing matches so the caller can produce a
 * coherent error from the load step.
 */
async function resolveWithExtensions(fs: CommandContext['fs'], candidate: string): Promise<string> {
  if (await fs.exists(candidate)) {
    try {
      const st = await fs.stat(candidate);
      if (!st.isDirectory) return candidate;
    } catch {
      return candidate;
    }
  }
  const exts = ['.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.js', '.json'];
  for (const ext of exts) {
    const withExt = `${candidate}${ext}`;
    if (await fs.exists(withExt)) return withExt;
  }
  for (const ext of exts) {
    const indexPath = joinPath(candidate, `index${ext}`);
    if (await fs.exists(indexPath)) return indexPath;
  }
  return candidate;
}

type FormatMessagesFn = (
  messages: {
    text: string;
    location?: { file?: string; line?: number; column?: number } | null;
  }[],
  opts: { kind: 'error' | 'warning'; color?: boolean }
) => Promise<string[]>;

async function renderDiagnostics(
  formatMessages: FormatMessagesFn,
  errors: { text: string; location?: { file?: string; line?: number; column?: number } | null }[],
  warnings: { text: string; location?: { file?: string; line?: number; column?: number } | null }[]
): Promise<string> {
  const parts: string[] = [];
  if (warnings.length > 0) {
    const formatted = await formatMessages(warnings, { kind: 'warning', color: false });
    parts.push(formatted.join(''));
  }
  if (errors.length > 0) {
    const formatted = await formatMessages(errors, { kind: 'error', color: false });
    parts.push(formatted.join(''));
  }
  return parts.join('');
}

export function createEsbuildCommand(): Command {
  return defineCommand('esbuild', async (args, ctx) => {
    let parsed: ParsedEsbuildArgs;
    try {
      parsed = parseEsbuildArgs(args);
    } catch (err) {
      return {
        stdout: '',
        stderr: `${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 2,
      };
    }

    if (parsed.showHelp || (args.length === 0 && !ctx.stdin)) {
      return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };
    }

    if (!parsed.transform && !parsed.bundle && parsed.entries.length > 1) {
      return {
        stdout: '',
        stderr:
          'esbuild: multiple entry points require --bundle (transform mode accepts at most one entry)\n',
        exitCode: 2,
      };
    }

    let esbuildMod: typeof import('esbuild-wasm');
    try {
      esbuildMod = await getEsbuild({ ipk: createIpkContextFromCtx(ctx) });
    } catch (err) {
      // `getEsbuild` already emits the canonical
      // "run `ipk add esbuild-wasm`" guidance when nothing is
      // installed; surface it verbatim.
      return {
        stdout: '',
        stderr: `esbuild: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }

    if (parsed.showVersion) {
      return { stdout: `${esbuildMod.version}\n`, stderr: '', exitCode: 0 };
    }

    if (parsed.transform || (!parsed.bundle && parsed.entries.length <= 1)) {
      return runTransform(parsed, ctx, esbuildMod);
    }

    return runBundle(parsed, ctx, esbuildMod);
  });
}

async function runTransform(
  parsed: ParsedEsbuildArgs,
  ctx: CommandContext,
  esbuildMod: typeof import('esbuild-wasm')
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let source: string;
  let sourcefile = '<stdin>';
  if (parsed.entries.length === 1) {
    const inputPath = ctx.fs.resolvePath(ctx.cwd, parsed.entries[0]);
    if (!(await ctx.fs.exists(inputPath))) {
      return { stdout: '', stderr: `esbuild: ${parsed.entries[0]}: no such file\n`, exitCode: 1 };
    }
    source = await ctx.fs.readFile(inputPath);
    sourcefile = inputPath;
  } else {
    source = stdinAsText(ctx.stdin);
    if (!source) {
      return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };
    }
  }

  const opts: TransformOptions = {
    loader: parsed.loader ?? inferLoader(sourcefile),
    sourcefile,
    ...(parsed.format ? { format: parsed.format } : {}),
    ...(parsed.minify ? { minify: true } : {}),
    ...(parsed.sourcemap ? { sourcemap: parsed.sourcemap } : {}),
    ...(parsed.target ? { target: parsed.target } : {}),
    ...(parsed.platform ? { platform: parsed.platform } : {}),
    ...(Object.keys(parsed.define).length > 0 ? { define: parsed.define } : {}),
    ...(parsed.treeShaking !== null ? { treeShaking: parsed.treeShaking } : {}),
  };

  try {
    const result = await esbuildMod.transform(source, opts);
    const warningsText = await renderDiagnostics(esbuildMod.formatMessages, [], result.warnings);
    if (parsed.outfile) {
      const outPath = ctx.fs.resolvePath(ctx.cwd, parsed.outfile);
      await ctx.fs.writeFile(outPath, result.code);
      if (result.map && parsed.sourcemap && parsed.sourcemap !== 'inline') {
        await ctx.fs.writeFile(`${outPath}.map`, result.map);
      }
      return { stdout: '', stderr: warningsText, exitCode: 0 };
    }
    return { stdout: result.code, stderr: warningsText, exitCode: 0 };
  } catch (err) {
    const failure = err as { errors?: unknown[]; warnings?: unknown[]; message?: string };
    if (Array.isArray(failure.errors)) {
      const text = await renderDiagnostics(
        esbuildMod.formatMessages,
        failure.errors as Parameters<FormatMessagesFn>[0],
        (failure.warnings ?? []) as Parameters<FormatMessagesFn>[0]
      );
      return { stdout: '', stderr: text, exitCode: 1 };
    }
    return {
      stdout: '',
      stderr: `esbuild: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
}

async function runBundle(
  parsed: ParsedEsbuildArgs,
  ctx: CommandContext,
  esbuildMod: typeof import('esbuild-wasm')
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (parsed.entries.length === 0) {
    return {
      stdout: '',
      stderr: 'esbuild: --bundle requires at least one entry point\n',
      exitCode: 2,
    };
  }

  const entryPoints = parsed.entries.map((entry) => ctx.fs.resolvePath(ctx.cwd, entry));
  for (const entryPath of entryPoints) {
    if (!(await ctx.fs.exists(entryPath))) {
      return { stdout: '', stderr: `esbuild: ${entryPath}: no such file\n`, exitCode: 1 };
    }
  }

  const opts: BuildOptions = {
    entryPoints,
    bundle: true,
    write: false,
    plugins: [
      createVfsPlugin(
        ctx.fs,
        ctx.cwd,
        createIpkContextFromCtx(ctx),
        parsed.external,
        parsed.platform
      ),
    ],
    format: parsed.format ?? 'esm',
    ...buildOptionOverrides(parsed),
  };

  try {
    const result = await esbuildMod.build(opts);
    const diagText = await renderDiagnostics(
      esbuildMod.formatMessages,
      result.errors,
      result.warnings
    );
    const outputFiles = result.outputFiles ?? [];
    if (parsed.outfile) {
      if (outputFiles.length === 0) {
        return { stdout: '', stderr: 'esbuild: build produced no output\n', exitCode: 1 };
      }
      const outPath = ctx.fs.resolvePath(ctx.cwd, parsed.outfile);
      await ctx.fs.writeFile(outPath, outputFiles[0].text);
      const outDir = dirname(outPath);
      for (let i = 1; i < outputFiles.length; i++) {
        const extra = outputFiles[i];
        const extraPath = joinPath(outDir, basename(extra.path));
        await ctx.fs.writeFile(extraPath, extra.text);
      }
      return { stdout: '', stderr: diagText, exitCode: 0 };
    }
    const stdout = outputFiles.map((f) => f.text).join('');
    return { stdout, stderr: diagText, exitCode: 0 };
  } catch (err) {
    const failure = err as { errors?: unknown[]; warnings?: unknown[] };
    if (Array.isArray(failure.errors)) {
      const text = await renderDiagnostics(
        esbuildMod.formatMessages,
        failure.errors as Parameters<FormatMessagesFn>[0],
        (failure.warnings ?? []) as Parameters<FormatMessagesFn>[0]
      );
      return { stdout: '', stderr: text, exitCode: 1 };
    }
    return {
      stdout: '',
      stderr: `esbuild: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
}

function buildOptionOverrides(parsed: ParsedEsbuildArgs): BuildOptions {
  return {
    ...(parsed.minify ? { minify: true } : {}),
    ...(parsed.sourcemap ? { sourcemap: parsed.sourcemap } : {}),
    ...(parsed.target ? { target: parsed.target } : {}),
    ...(parsed.external.length > 0 ? { external: parsed.external } : {}),
    ...(parsed.platform ? { platform: parsed.platform } : {}),
    ...(Object.keys(parsed.define).length > 0 ? { define: parsed.define } : {}),
    ...(Object.keys(parsed.banner).length > 0 ? { banner: parsed.banner } : {}),
    ...(Object.keys(parsed.footer).length > 0 ? { footer: parsed.footer } : {}),
    ...(parsed.treeShaking !== null ? { treeShaking: parsed.treeShaking } : {}),
  };
}
