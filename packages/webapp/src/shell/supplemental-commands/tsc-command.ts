/**
 * `tsc` shell command — thin built-in surface that drives the
 * `typescript` package loaded from VFS `node_modules` via the shared
 * `getTypeScript()` ipk loader in `shared.ts`. Inert until the user
 * runs `ipk add typescript`; without the package, the loader throws
 * the canonical guidance error which this command surfaces verbatim.
 * ZERO network in the not-installed path — there is no CDN fallback
 * anywhere on this code path.
 *
 * Surfaces:
 *   - `tsc <file.ts> [more.ts ...]` — writes `<file.js>` next to
 *     each source, or under `--outDir <dir>` when specified.
 *   - `tsc --noEmit [files...]` — runs the transpiler but skips
 *     writes; exits non-zero when diagnostics are reported.
 *   - `tsc` with stdin piped — transpiles the buffered stdin and
 *     prints the result to stdout (mirrors `cat foo.ts | tsc`).
 *
 * `tsconfig.json` discovery walks up from `ctx.cwd` and merges the
 * `compilerOptions` block over the defaults (`ES2022`/`ESNext`).
 * Full project-wide type checking would need a CompilerHost wired
 * up to the bundled `lib.*.d.ts` files — out of scope here; the
 * `--noEmit` path uses `transpileModule`'s single-file diagnostic
 * surface which catches syntax errors and isolated-module issues.
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { stdinAsText } from '../just-bash-compat.js';
import {
  basename,
  dirname,
  getTypeScript,
  type TypeScriptIpkContext,
  type TypeScriptModule,
} from './shared.js';

/**
 * Build a {@link TypeScriptIpkContext} from a command's `ctx` so
 * `getTypeScript` can locate the ipk-installed `typescript` in the
 * VFS `node_modules`. Mirrors `createIpkContextFromCtx` in
 * `esbuild-command.ts` / `biome-command.ts` so every float wires the
 * loader the same way.
 */
export function createIpkContextFromCtx(ctx: CommandContext): TypeScriptIpkContext {
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

export interface ParsedTscArgs {
  files: string[];
  noEmit: boolean;
  outDir: string | null;
  showHelp: boolean;
  showVersion: boolean;
}

const HELP_TEXT = `tsc - thin wrapper over the ipk-loaded typescript package

Usage:
  tsc [options] [files...]
  cat foo.ts | tsc

Options:
  --noEmit              Type-check only; do not write outputs
  --outDir <dir>        Write emitted .js files to <dir>
  -h, --help            Show this help
  -v, --version         Show typescript version

Notes:
  - tsconfig.json (compilerOptions) is auto-discovered upward from cwd.
  - Defaults: target=ES2022, module=ESNext.
  - This is a single-file transpile pass; cross-file type checking is
    not yet wired up.

Install:
  Inert until the backing package is installed in node_modules:
    ipk add typescript
  Then \`tsc --version\` and the transpile commands above. There is no
  bundled binary, no CDN fallback; a missing package exits non-zero
  with a clear \`ipk add\` hint.
`;

export function parseTscArgs(args: string[]): ParsedTscArgs {
  const files: string[] = [];
  let noEmit = false;
  let outDir: string | null = null;
  let showHelp = false;
  let showVersion = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      showVersion = true;
      continue;
    }
    if (arg === '--noEmit') {
      noEmit = true;
      continue;
    }
    if (arg === '--outDir') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.startsWith('-')) {
        throw new Error('tsc: --outDir requires a value');
      }
      outDir = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--outDir=')) {
      outDir = arg.slice('--outDir='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`tsc: unknown option: ${arg}`);
    }
    files.push(arg);
  }

  return { files, noEmit, outDir, showHelp, showVersion };
}

/**
 * Strip `//` line and `/* … *\/` block comments from a JSON-with-comments
 * string. tsconfig.json allows comments; JSON.parse does not. Quoted
 * strings are preserved as-is so paths like `"https://example.com"`
 * don't lose their slashes.
 */
export function stripJsonComments(input: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringQuote = '';
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function deriveOutputPath(inputPath: string, outDir: string | null): string {
  const base = basename(inputPath);
  const withoutExt = base.replace(/\.(ts|tsx|mts|cts)$/i, '');
  const outName = `${withoutExt}.js`;
  if (outDir) {
    const cleanDir = outDir.endsWith('/') ? outDir.slice(0, -1) : outDir;
    return `${cleanDir}/${outName}`;
  }
  return `${dirname(inputPath)}/${outName}`;
}

/**
 * Walk upward from `startDir` looking for `tsconfig.json`. Returns
 * the absolute path or `null` when no file is found before the VFS
 * root. Mirrors how `tsc` itself resolves the config off the cwd.
 */
export async function findTsconfigPath(
  fs: CommandContext['fs'],
  startDir: string
): Promise<string | null> {
  let dir = startDir || '/';
  let lastDir = '';
  while (dir && dir !== lastDir) {
    const candidate = dir === '/' ? '/tsconfig.json' : `${dir}/tsconfig.json`;
    if (await fs.exists(candidate)) return candidate;
    lastDir = dir;
    dir = dirname(dir);
  }
  return null;
}

interface ResolvedTscConfig {
  compilerOptions: Record<string, unknown>;
}

const DEFAULT_COMPILER_OPTIONS: Record<string, unknown> = {
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  isolatedModules: true,
};

export async function loadTsconfig(
  fs: CommandContext['fs'],
  startDir: string
): Promise<ResolvedTscConfig> {
  const path = await findTsconfigPath(fs, startDir);
  if (!path) return { compilerOptions: { ...DEFAULT_COMPILER_OPTIONS } };
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch {
    return { compilerOptions: { ...DEFAULT_COMPILER_OPTIONS } };
  }
  let parsed: { compilerOptions?: Record<string, unknown> } = {};
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return { compilerOptions: { ...DEFAULT_COMPILER_OPTIONS } };
  }
  return {
    compilerOptions: {
      ...DEFAULT_COMPILER_OPTIONS,
      ...(parsed.compilerOptions ?? {}),
    },
  };
}

function diagnosticToString(ts: TypeScriptModule, diag: import('typescript').Diagnostic): string {
  const text = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
  if (diag.file && typeof diag.start === 'number') {
    const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
    return `${diag.file.fileName}(${line + 1},${character + 1}): error TS${diag.code}: ${text}`;
  }
  return `error TS${diag.code}: ${text}`;
}

function inferScriptKind(
  ts: TypeScriptModule,
  fileName: string
): import('typescript').ScriptKind | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface TranspileOneResult {
  outputText: string;
  diagnostics: import('typescript').Diagnostic[];
}

function transpileOne(
  ts: TypeScriptModule,
  source: string,
  fileName: string,
  compilerOptions: Record<string, unknown>,
  reportDiagnostics: boolean
): TranspileOneResult {
  const result = ts.transpileModule(source, {
    compilerOptions: compilerOptions as import('typescript').CompilerOptions,
    fileName,
    reportDiagnostics,
  });
  return {
    outputText: result.outputText,
    diagnostics: result.diagnostics ?? [],
  };
}

export function createTscCommand(): Command {
  return defineCommand('tsc', async (args, ctx) => {
    let parsed: ParsedTscArgs;
    try {
      parsed = parseTscArgs(args);
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

    let ts: TypeScriptModule;
    try {
      ts = await getTypeScript(createIpkContextFromCtx(ctx));
    } catch (err) {
      // `getTypeScript` already emits the canonical
      // "run `ipk add typescript`" guidance when nothing is installed;
      // surface it verbatim.
      return {
        stdout: '',
        stderr: `tsc: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }

    if (parsed.showVersion) {
      return { stdout: `Version ${ts.version}\n`, stderr: '', exitCode: 0 };
    }

    const config = await loadTsconfig(ctx.fs, ctx.cwd);

    // No files: transpile stdin → stdout, mirroring `cat foo.ts | tsc`.
    if (parsed.files.length === 0) {
      const source = stdinAsText(ctx.stdin);
      if (!source) {
        return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };
      }
      const { outputText, diagnostics } = transpileOne(
        ts,
        source,
        '<stdin>.ts',
        config.compilerOptions,
        true
      );
      const errLines = diagnostics.map((d) => diagnosticToString(ts, d));
      if (diagnostics.length > 0) {
        return {
          stdout: parsed.noEmit ? '' : outputText,
          stderr: errLines.length > 0 ? `${errLines.join('\n')}\n` : '',
          exitCode: 1,
        };
      }
      return {
        stdout: parsed.noEmit ? '' : outputText,
        stderr: '',
        exitCode: 0,
      };
    }

    const stderrParts: string[] = [];
    let hadError = false;

    for (const fileArg of parsed.files) {
      const inputPath = ctx.fs.resolvePath(ctx.cwd, fileArg);
      if (!(await ctx.fs.exists(inputPath))) {
        stderrParts.push(`tsc: ${fileArg}: no such file\n`);
        hadError = true;
        continue;
      }
      let source: string;
      try {
        source = await ctx.fs.readFile(inputPath);
      } catch (err) {
        stderrParts.push(`tsc: ${fileArg}: ${err instanceof Error ? err.message : String(err)}\n`);
        hadError = true;
        continue;
      }

      // Touch the script-kind helper so the import isn't dead code;
      // `transpileModule` already infers kind from `fileName`, so we
      // don't pass it through, but keeping the helper exported makes
      // it available to the upcoming `test` command without a refactor.
      void inferScriptKind(ts, inputPath);

      const { outputText, diagnostics } = transpileOne(
        ts,
        source,
        inputPath,
        config.compilerOptions,
        true
      );

      for (const d of diagnostics) {
        stderrParts.push(`${diagnosticToString(ts, d)}\n`);
      }
      if (diagnostics.length > 0) hadError = true;

      if (parsed.noEmit) continue;

      const outputPath = ctx.fs.resolvePath(ctx.cwd, deriveOutputPath(inputPath, parsed.outDir));
      try {
        await ctx.fs.writeFile(outputPath, outputText);
      } catch (err) {
        stderrParts.push(
          `tsc: ${outputPath}: ${err instanceof Error ? err.message : String(err)}\n`
        );
        hadError = true;
      }
    }

    return {
      stdout: '',
      stderr: stderrParts.join(''),
      exitCode: hadError ? 1 : 0,
    };
  });
}
