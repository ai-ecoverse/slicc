/**
 * `esbuild` shell command. Runs the WASM build of esbuild via
 * `esbuild-wasm`, with the heavy `esbuild.wasm` binary downloaded
 * on demand at first call (see `esbuild-wasm.ts`).
 *
 * Two surfaces:
 *
 *  1. **`esbuild --bundle <entry> [--outfile <path>]`**: bundles
 *     the entry point and all transitively resolved local imports
 *     into a single output. Local paths are read from the VFS via
 *     `ctx.fs`; bare specifiers (`react`, `lodash/fp`, …) are
 *     redirected through the esm.sh CDN (see `cdn-url-builder`)
 *     and stitched together through an `http-url` plugin namespace
 *     so esbuild can fetch their bodies and recurse.
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
import { stdinAsText } from '../just-bash-compat.js';
import { esmShUrl } from './cdn-url-builder.js';
import { getEsbuild, type IpkResolutionContext } from './esbuild-wasm.js';
import { basename, dirname, joinPath } from './shared.js';

/**
 * Build an {@link IpkResolutionContext} from a command's `ctx` so
 * `getEsbuild` can prefer an ipk-installed `esbuild-wasm` in the VFS
 * `node_modules` over the CDN. The reader adapts just-bash's
 * `IFileSystem` surface (`exists` / `stat` / `readFile`) to the
 * resolver's `ModuleReader`; `readBytes` routes through
 * `readFileBuffer` for raw `.wasm` bytes. `fromDir` is the shell
 * `cwd` so the standard `node_modules` walk starts where the user is.
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

const HELP_TEXT = `esbuild - WASM build of the esbuild bundler / transpiler

Usage:
  esbuild [options] <entry>                         Bundle / transform
  echo "code" | esbuild [options]                   Transform stdin

Modes:
  --bundle                  Bundle the entry + its imports into one output
  --transform               Single-file transform (default when --bundle is absent)

Output:
  --outfile <path>          Write the bundled / transformed output to <path>
  --format=<iife|cjs|esm>   Output format (default: esm)
  --minify                  Enable all minification passes
  --sourcemap[=inline|external|linked|both]
                            Emit source maps
  --target=<csv>            Comma-separated target list (e.g. es2020,chrome100)
  --loader=<loader>         Force loader for stdin / single-file transform
                            (js, ts, jsx, tsx, json, text, base64, dataurl)

Module resolution:
  - Local paths (./foo, /workspace/bar) read from the VFS.
  - Bare specifiers (react, lodash/fp, ...) resolve through the esm.sh CDN.

First run downloads ~10 MB of esbuild.wasm; subsequent runs reuse
the cached copy via the Cache Storage API.
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
  showHelp: boolean;
  showVersion: boolean;
}

const VALID_FORMATS = new Set(['iife', 'cjs', 'esm']);
const VALID_SOURCEMAPS = new Set(['linked', 'inline', 'external', 'both']);

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
    showHelp: false,
    showVersion: false,
  };

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
    if (arg === '--bundle') {
      out.bundle = true;
      continue;
    }
    if (arg === '--transform') {
      out.transform = true;
      continue;
    }
    if (arg === '--minify') {
      out.minify = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const isLongOpt = arg.startsWith('--');
    const key = isLongOpt && eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = isLongOpt && eq > 0 ? arg.slice(eq + 1) : null;
    const consumeValue = (): string => {
      if (inlineValue !== null) return inlineValue;
      const next = args[i + 1];
      if (typeof next !== 'string' || next.startsWith('-')) {
        throw new Error(`esbuild: ${key} requires a value`);
      }
      i += 1;
      return next;
    };

    if (key === '--outfile') {
      out.outfile = consumeValue();
      continue;
    }
    if (key === '--format') {
      const v = consumeValue();
      if (!VALID_FORMATS.has(v)) {
        throw new Error(`esbuild: --format must be one of iife|cjs|esm (got "${v}")`);
      }
      out.format = v as 'iife' | 'cjs' | 'esm';
      continue;
    }
    if (key === '--sourcemap') {
      // Three accepted forms:
      //   --sourcemap                    → boolean true
      //   --sourcemap=<value>            → enum (inline value)
      //   --sourcemap <value>            → enum (separate token,
      //                                    only when the next token
      //                                    matches the enum)
      if (inlineValue !== null) {
        if (!VALID_SOURCEMAPS.has(inlineValue)) {
          throw new Error(
            `esbuild: --sourcemap value must be one of linked|inline|external|both (got "${inlineValue}")`
          );
        }
        out.sourcemap = inlineValue as BuildOptions['sourcemap'];
        continue;
      }
      const next = args[i + 1];
      if (typeof next === 'string' && VALID_SOURCEMAPS.has(next)) {
        out.sourcemap = next as BuildOptions['sourcemap'];
        i += 1;
        continue;
      }
      out.sourcemap = true;
      continue;
    }
    if (key === '--target') {
      out.target = consumeValue()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (key === '--loader') {
      out.loader = consumeValue() as Loader;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`esbuild: unknown option: ${arg}`);
    }
    out.entries.push(arg);
  }

  return out;
}

/** Marker namespace for esm.sh-redirected bare specifiers. */
const ESM_SH_NAMESPACE = 'http-url';
/** Trailing-slash base URL the bare-specifier branch concatenates against. */
const ESM_SH_BASE = esmShUrl('').toString();

/**
 * Build a plugin that bridges esbuild's resolver to the VFS for
 * local paths and to esm.sh for bare specifiers. The plugin is
 * pure — it captures `fs` and `cwd` from the calling shell ctx
 * and routes every load through one of three branches:
 *
 *  - VFS file (default namespace): read via `ctx.fs.readFile`
 *    and forward the contents back to esbuild with the loader
 *    inferred from the extension.
 *  - `http-url` namespace: resolved bare specifier or relative
 *    import from inside another esm.sh module. We fetch the URL
 *    and feed esbuild the body. Nested relative imports stay in
 *    the `http-url` namespace so the resolver chains correctly.
 *  - External: unsupported protocols (e.g. `node:fs`) are marked
 *    external so esbuild emits an import without trying to load
 *    bytes for them. Real bundling of node builtins is out of
 *    scope for the browser float.
 */
export function createVfsPlugin(
  fs: CommandContext['fs'],
  cwd: string,
  fetchImpl: typeof fetch = fetch
): Plugin {
  return {
    name: 'slicc-vfs',
    setup(build) {
      // Entry resolution: turn `--bundle ./foo.ts` into an absolute
      // VFS path so the load step has a stable key.
      build.onResolve({ filter: /.*/ }, async (args) => {
        // Don't try to resolve node: / data: / external protocols.
        if (/^[a-z]+:/.test(args.path) && !args.path.startsWith('file:')) {
          // Relative imports from inside an http-url module keep
          // riding the URL resolver below; otherwise we treat
          // unknown protocols as external.
          if (args.path.startsWith('http://') || args.path.startsWith('https://')) {
            return { path: args.path, namespace: ESM_SH_NAMESPACE };
          }
          return { path: args.path, external: true };
        }

        // Relative or absolute import from inside an http-url module:
        // resolve against the importer URL so we end up with a fully
        // qualified URL in the http-url namespace.
        if (args.namespace === ESM_SH_NAMESPACE) {
          const importerUrl = args.importer || ESM_SH_BASE;
          const resolved = new URL(args.path, importerUrl).toString();
          return { path: resolved, namespace: ESM_SH_NAMESPACE };
        }

        // Relative / absolute VFS path.
        if (
          args.path.startsWith('./') ||
          args.path.startsWith('../') ||
          args.path.startsWith('/')
        ) {
          const importerDir = args.importer?.startsWith('/') ? dirname(args.importer) : cwd;
          const resolved = fs.resolvePath(importerDir, args.path);
          const withExt = await resolveWithExtensions(fs, resolved);
          return { path: withExt };
        }

        // Bare specifier → esm.sh.
        return { path: `${ESM_SH_BASE}${args.path}`, namespace: ESM_SH_NAMESPACE };
      });

      // VFS load (default namespace).
      build.onLoad({ filter: /.*/ }, async (args) => {
        if (args.namespace && args.namespace !== 'file') return null;
        const contents = await fs.readFile(args.path);
        return { contents, loader: inferLoader(args.path), resolveDir: dirname(args.path) };
      });

      // esm.sh / http(s) load.
      build.onLoad({ filter: /.*/, namespace: ESM_SH_NAMESPACE }, async (args) => {
        const res = await fetchImpl(args.path);
        if (!res.ok) {
          return {
            errors: [{ text: `esm.sh fetch ${args.path} failed: HTTP ${res.status}` }],
          };
        }
        const body = await res.text();
        return { contents: body, loader: inferLoader(args.path) };
      });
    },
  };
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
  // Try as directory with index.*.
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

    // Cheap routing validation before the heavy WASM load.
    // Multiple positional entries without `--bundle` is an error —
    // upstream esbuild's CLI runs a per-file transform for each
    // entry in that case, but the single-output transform branch
    // here can only handle one source at a time and silently
    // falling through to bundle mode was misleading.
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
      return {
        stdout: '',
        stderr: `esbuild: failed to load esbuild-wasm: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }

    if (parsed.showVersion) {
      return { stdout: `${esbuildMod.version}\n`, stderr: '', exitCode: 0 };
    }

    // Transform branch: explicit --transform OR no --bundle with a
    // single entry / piped stdin. Mirrors the upstream CLI default.
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
  };

  try {
    const result = await esbuildMod.transform(source, opts);
    const warningsText = await renderDiagnostics(esbuildMod.formatMessages, [], result.warnings);
    if (parsed.outfile) {
      const outPath = ctx.fs.resolvePath(ctx.cwd, parsed.outfile);
      await ctx.fs.writeFile(outPath, result.code);
      // For `external` / `linked` / `both` sourcemap modes,
      // `transform()` returns the map separately as `result.map`.
      // Write it next to outfile so the linked/external pragma in
      // the emitted code resolves. `inline` maps are embedded in
      // `result.code` and need no sidecar.
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
    plugins: [createVfsPlugin(ctx.fs, ctx.cwd)],
    format: parsed.format ?? 'esm',
    ...(parsed.minify ? { minify: true } : {}),
    ...(parsed.sourcemap ? { sourcemap: parsed.sourcemap } : {}),
    ...(parsed.target ? { target: parsed.target } : {}),
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
      // Any additional outputs (source maps, code-split chunks) land
      // next to the requested outfile using their esbuild-assigned
      // basenames; mirrors upstream `--outfile` behavior.
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
