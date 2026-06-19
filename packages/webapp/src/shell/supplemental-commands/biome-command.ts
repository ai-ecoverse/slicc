/**
 * `biome` shell command. Runs the Biome WASM linter/formatter via
 * `@biomejs/js-api`, with the heavy `biome_wasm_bg.wasm` binary
 * downloaded on demand at first call (see `biome-runtime.ts`).
 *
 * Subcommands (matching the upstream Biome CLI as closely as the
 * Workspace API allows):
 *
 *   biome lint   [files...]   — diagnostics only
 *   biome format [files...]   — print formatted output to stdout
 *   biome check  [files...]   — lint + format check together
 *   biome ci     [files...]   — same as `check`, exit non-zero on any diagnostic
 *
 * Mutating flags:
 *   --write           write formatted output back to disk (format/check)
 *   --apply           apply safe lint fixes (lint/check)
 *   --apply-unsafe    apply safe + unsafe lint fixes
 *
 * Stdin mode (no file arguments + piped input):
 *   --stdin-file-path <path>   virtual path so Biome picks the right parser
 *
 * Module resolution: files are read from / written to the VFS via
 * `ctx.fs`. Directory arguments are walked recursively and filtered
 * by extension (`isLintableFile`); a path that is neither file nor
 * directory yields a diagnostic.
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { stdinAsText } from '../just-bash-compat.js';
import { type BiomeRuntime, getBiome, type IpkResolutionContext } from './biome-runtime.js';

/**
 * Build an {@link IpkResolutionContext} from a command's `ctx` so
 * `getBiome` can prefer an ipk-installed `@biomejs/wasm-web` in the
 * VFS `node_modules` over the CDN. The reader adapts just-bash's
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
]);

const SUBCOMMANDS = new Set(['lint', 'format', 'check', 'ci']);
export type BiomeSubcommand = 'lint' | 'format' | 'check' | 'ci';

const HELP_TEXT = `biome - WASM build of the Biome linter / formatter

Usage:
  biome <subcommand> [options] [files...]
  echo "code" | biome <subcommand> --stdin-file-path <path> [options]

Subcommands:
  lint        Report lint diagnostics
  format      Print formatted output to stdout (or write with --write)
  check       Lint + format check together
  ci          Same as 'check', exits non-zero on any diagnostic

Mutating flags:
  --write           Write formatted output back to disk (format / check)
  --apply           Apply safe lint fixes (lint / check)
  --apply-unsafe    Apply safe + unsafe lint fixes

Stdin mode (no file arguments):
  --stdin-file-path <path>   Virtual file path so Biome picks the right parser

Other:
  -h, --help        Show this help
  -v, --version     Show biome wasm-web version

Notes:
  - File arguments may be files or directories; directories are
    walked recursively and filtered by extension (js, ts, jsx, tsx,
    json, jsonc, css, graphql, html, svelte, vue, astro).
  - First run downloads ~6 MB of biome_wasm_bg.wasm; subsequent
    runs reuse the cached copy via the Cache Storage API.
`;

export interface ParsedBiomeArgs {
  subcommand: BiomeSubcommand | null;
  paths: string[];
  write: boolean;
  apply: boolean;
  applyUnsafe: boolean;
  stdinFilePath: string | null;
  showHelp: boolean;
  showVersion: boolean;
}

export function parseBiomeArgs(args: string[]): ParsedBiomeArgs {
  const out: ParsedBiomeArgs = {
    subcommand: null,
    paths: [],
    write: false,
    apply: false,
    applyUnsafe: false,
    stdinFilePath: null,
    showHelp: false,
    showVersion: false,
  };

  // Top-level help / version checks run before the subcommand
  // requirement so `biome --help` works without a subcommand.
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
    if (arg === '--apply') {
      out.apply = true;
      continue;
    }
    if (arg === '--apply-unsafe') {
      out.applyUnsafe = true;
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
 * Expand `paths` into a flat list of concrete file paths. Each
 * input may be a file (kept as-is) or a directory (walked
 * recursively, filtered by `isLintableFile`). Missing entries
 * return as `{ path, error }` so the caller can surface a
 * diagnostic per missing argument instead of failing the run.
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
    } else {
      if (isLintableFile(resolved)) files.push(resolved);
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

interface RunSummary {
  errorCount: number;
  warningCount: number;
  changedCount: number;
  /** Concatenated rendered diagnostics text (suitable for stderr). */
  diagnostics: string;
  /**
   * Per-file rendered output kept when `--write` is OFF for
   * `format` / `check`. For `--write` mode this stays empty and
   * the formatted content is flushed to disk.
   */
  stdoutChunks: string[];
}

export function createBiomeCommand(): Command {
  return defineCommand('biome', async (args, ctx) => {
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

    if (parsed.showHelp) {
      return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };
    }

    let runtime: BiomeRuntime;
    try {
      runtime = await getBiome({ ipk: createIpkContextFromCtx(ctx) });
    } catch (err) {
      return {
        stdout: '',
        stderr: `biome: failed to load biome wasm: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }

    if (parsed.showVersion) {
      return { stdout: `${runtime.version}\n`, stderr: '', exitCode: 0 };
    }

    if (parsed.subcommand === null) {
      return {
        stdout: '',
        stderr: 'biome: missing subcommand (expected lint, format, check, or ci)\n',
        exitCode: 2,
      };
    }

    // Stdin mode: read from ctx.stdin, run a single virtual file
    // through the workspace, and print the result. Mirrors the
    // upstream `biome check --stdin-file-path foo.ts` flag shape.
    if (parsed.paths.length === 0 && ctx.stdin) {
      return runStdin(parsed, ctx, runtime);
    }

    if (parsed.paths.length === 0) {
      return {
        stdout: '',
        stderr: 'biome: no files or directories specified\n',
        exitCode: 2,
      };
    }

    return runFiles(parsed, ctx, runtime);
  });
}

async function runStdin(
  parsed: ParsedBiomeArgs,
  ctx: CommandContext,
  runtime: BiomeRuntime
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const virtualPath = parsed.stdinFilePath ?? '/stdin.ts';
  const source = stdinAsText(ctx.stdin);
  const summary = await processFile(parsed, runtime, virtualPath, source, async () => {
    // No-op writer: stdin mode never persists.
  });
  return finalize(parsed, summary);
}

async function runFiles(
  parsed: ParsedBiomeArgs,
  ctx: CommandContext,
  runtime: BiomeRuntime
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { files, missing } = await expandPaths(ctx.fs, ctx.cwd, parsed.paths);
  const summary: RunSummary = {
    errorCount: 0,
    warningCount: 0,
    changedCount: 0,
    diagnostics: '',
    stdoutChunks: [],
  };
  for (const m of missing) {
    summary.diagnostics += `biome: ${m}: no such file or directory\n`;
    summary.errorCount += 1;
  }
  for (const file of files) {
    const source = await ctx.fs.readFile(file);
    const fileSummary = await processFile(parsed, runtime, file, source, async (next) => {
      await ctx.fs.writeFile(file, next);
    });
    summary.errorCount += fileSummary.errorCount;
    summary.warningCount += fileSummary.warningCount;
    summary.changedCount += fileSummary.changedCount;
    summary.diagnostics += fileSummary.diagnostics;
    summary.stdoutChunks.push(...fileSummary.stdoutChunks);
  }
  return finalize(parsed, summary);
}

/**
 * Run one virtual file through the Biome workspace.
 *
 * @param writer Persists the (possibly fixed/formatted) content. For
 *   `--write` mode this writes back to disk; for stdin / non-write
 *   format mode the caller supplies a no-op writer and the chunk is
 *   pushed into `stdoutChunks`.
 */
async function processFile(
  parsed: ParsedBiomeArgs,
  runtime: BiomeRuntime,
  path: string,
  source: string,
  writer: (next: string) => Promise<void>
): Promise<RunSummary> {
  const summary: RunSummary = {
    errorCount: 0,
    warningCount: 0,
    changedCount: 0,
    diagnostics: '',
    stdoutChunks: [],
  };
  const { biome, projectKey } = runtime;
  let current = source;
  const wantsLint =
    parsed.subcommand === 'lint' || parsed.subcommand === 'check' || parsed.subcommand === 'ci';
  const wantsFormat =
    parsed.subcommand === 'format' || parsed.subcommand === 'check' || parsed.subcommand === 'ci';
  const fixMode = parsed.applyUnsafe
    ? 'safeAndUnsafeFixes'
    : parsed.apply
      ? 'safeFixes'
      : undefined;
  // `--apply` / `--apply-unsafe` are documented as mutating flags
  // and match upstream Biome's deprecated-but-still-supported semantics
  // where the flag itself implies writing back to disk. Treat them
  // as equivalent to `--write` for any persistence decision below.
  const effectiveWrite = parsed.write || fixMode !== undefined;

  if (wantsLint) {
    const lint = biome.lintContent(projectKey, current, {
      filePath: path,
      ...(fixMode ? { fixFileMode: fixMode } : {}),
    });
    if (fixMode && lint.content !== current) {
      current = lint.content;
      summary.changedCount += 1;
    }
    const diagText = renderDiagnostics(biome, path, current, lint.diagnostics);
    summary.diagnostics += diagText.text;
    summary.errorCount += diagText.errors;
    summary.warningCount += diagText.warnings;
  }

  if (wantsFormat) {
    const fmt = biome.formatContent(projectKey, current, { filePath: path });
    const diagText = renderDiagnostics(biome, path, current, fmt.diagnostics);
    summary.diagnostics += diagText.text;
    summary.errorCount += diagText.errors;
    summary.warningCount += diagText.warnings;
    if (effectiveWrite && fmt.content !== current) {
      await writer(fmt.content);
      summary.changedCount += 1;
    } else if (effectiveWrite && fmt.content === current && current !== source) {
      // Format didn't change anything but lint --apply did; persist
      // the lint fix that's already sitting in `current`.
      await writer(current);
    } else if (!effectiveWrite && parsed.subcommand === 'format') {
      summary.stdoutChunks.push(fmt.content);
    } else if (!effectiveWrite && fmt.content !== current) {
      // `check` / `ci` without `--write`: a file that would be
      // reformatted must surface as a failure, matching the upstream
      // Biome CLI. Record it as an error for `check` (non-zero exit)
      // and as a warning for `ci` (ci already fails on warnings, so
      // the exit code is the same, but the count is more honest).
      summary.diagnostics += `${path}: file is not formatted (run with --write to fix)\n`;
      if (parsed.subcommand === 'ci') summary.warningCount += 1;
      else summary.errorCount += 1;
    }
  } else if (parsed.subcommand === 'lint' && fixMode && current !== source) {
    // `lint --apply` / `--apply-unsafe`: persist the fixed content
    // (mutating flags imply write, per the help text).
    await writer(current);
  }

  return summary;
}

function renderDiagnostics(
  biome: BiomeRuntime['biome'],
  path: string,
  source: string,
  diagnostics: unknown[]
): { text: string; errors: number; warnings: number } {
  if (diagnostics.length === 0) {
    return { text: '', errors: 0, warnings: 0 };
  }
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics as { severity?: string }[]) {
    // Biome emits `warn` (not `warning`); accept both so future
    // version bumps that align the string don't silently regress.
    // `information` / `hint` are informational only and don't count.
    if (d.severity === 'error' || d.severity === 'fatal') errors += 1;
    else if (d.severity === 'warn' || d.severity === 'warning') warnings += 1;
  }
  let text = '';
  try {
    text = biome.printDiagnostics(diagnostics as never, { filePath: path, fileSource: source });
  } catch (err) {
    text = `biome: failed to print diagnostics for ${path}: ${err instanceof Error ? err.message : String(err)}\n`;
  }
  return { text, errors, warnings };
}

function finalize(
  parsed: ParsedBiomeArgs,
  summary: RunSummary
): { stdout: string; stderr: string; exitCode: number } {
  const stdout = summary.stdoutChunks.join('');
  const stderrParts: string[] = [];
  if (summary.diagnostics) stderrParts.push(summary.diagnostics);
  if (parsed.subcommand === 'check' || parsed.subcommand === 'ci') {
    if (summary.changedCount > 0 && parsed.write) {
      stderrParts.push(`biome: wrote ${summary.changedCount} file(s)\n`);
    }
  }
  // `ci` is strict — any warning fails the run.
  const exitCode =
    summary.errorCount > 0 || (parsed.subcommand === 'ci' && summary.warningCount > 0) ? 1 : 0;
  return { stdout, stderr: stderrParts.join(''), exitCode };
}
