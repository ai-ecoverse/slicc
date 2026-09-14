import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { stdinAsText } from '../just-bash-compat.js';
import {
  basename,
  dirname,
  getTypeScript,
  TYPESCRIPT_VFS_INSTALL_COMMAND,
  type TypeScriptIpkContext,
  type TypeScriptModule,
} from './shared.js';

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

const HELP_TEXT = `tsc - thin wrapper over the ipk-loaded TypeScript 6 package

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
    ${TYPESCRIPT_VFS_INSTALL_COMMAND}
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

type TscCompilerOptions = import('typescript-js').CompilerOptions;

interface ResolvedTscConfig {
  compilerOptions: TscCompilerOptions;
}

interface ParsedTsconfigJson {
  compilerOptions?: TscCompilerOptions;
}

function defaultCompilerOptions(ts: TypeScriptModule): TscCompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    isolatedModules: true,
  };
}

function compilerOptionsFromParsedConfig(config: unknown): TscCompilerOptions {
  if (config === null || typeof config !== 'object') return {};
  const { compilerOptions } = config as ParsedTsconfigJson;
  return compilerOptions ?? {};
}

export async function loadTsconfig(
  fs: CommandContext['fs'],
  ts: TypeScriptModule,
  startDir: string
): Promise<ResolvedTscConfig> {
  const defaults = defaultCompilerOptions(ts);
  const path = await findTsconfigPath(fs, startDir);
  if (!path) return { compilerOptions: { ...defaults } };
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch {
    return { compilerOptions: { ...defaults } };
  }
  const { config, error } = ts.parseConfigFileTextToJson(path, raw);
  if (error || !config) return { compilerOptions: { ...defaults } };
  return {
    compilerOptions: {
      ...defaults,
      ...compilerOptionsFromParsedConfig(config),
    },
  };
}

function diagnosticToString(
  ts: TypeScriptModule,
  diag: import('typescript-js').Diagnostic
): string {
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
): import('typescript-js').ScriptKind | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface TranspileOneResult {
  outputText: string;
  diagnostics: import('typescript-js').Diagnostic[];
}

function transpileOne(
  ts: TypeScriptModule,
  source: string,
  fileName: string,
  compilerOptions: TscCompilerOptions,
  reportDiagnostics: boolean
): TranspileOneResult {
  const result = ts.transpileModule(source, {
    compilerOptions,
    fileName,
    reportDiagnostics,
  });
  return {
    outputText: result.outputText,
    diagnostics: result.diagnostics ?? [],
  };
}

function runStdinTranspile(
  ts: TypeScriptModule,
  parsed: ParsedTscArgs,
  config: ResolvedTscConfig,
  source: string
): { stdout: string; stderr: string; exitCode: number } {
  const { outputText, diagnostics } = transpileOne(
    ts,
    source,
    '<stdin>.ts',
    config.compilerOptions,
    true
  );
  const errLines = diagnostics.map((d) => diagnosticToString(ts, d));
  const stderr = errLines.length > 0 ? `${errLines.join('\n')}\n` : '';
  return {
    stdout: parsed.noEmit ? '' : outputText,
    stderr,
    exitCode: diagnostics.length > 0 ? 1 : 0,
  };
}

async function transpileOneFile(
  ts: TypeScriptModule,
  ctx: CommandContext,
  fileArg: string,
  parsed: ParsedTscArgs,
  config: ResolvedTscConfig
): Promise<{ stderr: string; hadError: boolean }> {
  const inputPath = ctx.fs.resolvePath(ctx.cwd, fileArg);
  if (!(await ctx.fs.exists(inputPath))) {
    return { stderr: `tsc: ${fileArg}: no such file\n`, hadError: true };
  }
  let source: string;
  try {
    source = await ctx.fs.readFile(inputPath);
  } catch (err) {
    return {
      stderr: `tsc: ${fileArg}: ${err instanceof Error ? err.message : String(err)}\n`,
      hadError: true,
    };
  }

  void inferScriptKind(ts, inputPath);

  const { outputText, diagnostics } = transpileOne(
    ts,
    source,
    inputPath,
    config.compilerOptions,
    true
  );

  const stderrParts: string[] = [];
  for (const d of diagnostics) stderrParts.push(`${diagnosticToString(ts, d)}\n`);
  let hadError = diagnostics.length > 0;

  if (parsed.noEmit) return { stderr: stderrParts.join(''), hadError };

  const outputPath = ctx.fs.resolvePath(ctx.cwd, deriveOutputPath(inputPath, parsed.outDir));
  try {
    await ctx.fs.writeFile(outputPath, outputText);
  } catch (err) {
    stderrParts.push(`tsc: ${outputPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    hadError = true;
  }
  return { stderr: stderrParts.join(''), hadError };
}

type TscCmdResult = { stdout: string; stderr: string; exitCode: number };

async function prepareTscRun(
  args: string[],
  ctx: CommandContext
): Promise<{ done: TscCmdResult } | { parsed: ParsedTscArgs; ts: TypeScriptModule }> {
  let parsed: ParsedTscArgs;
  try {
    parsed = parseTscArgs(args);
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

  let ts: TypeScriptModule;
  try {
    ts = await getTypeScript(createIpkContextFromCtx(ctx));
  } catch (err) {
    return {
      done: {
        stdout: '',
        stderr: `tsc: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      },
    };
  }
  if (parsed.showVersion) {
    return { done: { stdout: `Version ${ts.version}\n`, stderr: '', exitCode: 0 } };
  }
  return { parsed, ts };
}

export function createTscCommand(): Command {
  return defineCommand('tsc', async (args, ctx) => {
    const prep = await prepareTscRun(args, ctx);
    if ('done' in prep) return prep.done;
    const { parsed, ts } = prep;
    const config = await loadTsconfig(ctx.fs, ts, ctx.cwd);

    if (parsed.files.length === 0) {
      const source = stdinAsText(ctx.stdin);
      if (!source) return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };
      return runStdinTranspile(ts, parsed, config, source);
    }

    const stderrParts: string[] = [];
    let hadError = false;
    for (const fileArg of parsed.files) {
      const r = await transpileOneFile(ts, ctx, fileArg, parsed, config);
      if (r.stderr) stderrParts.push(r.stderr);
      if (r.hadError) hadError = true;
    }
    return { stdout: '', stderr: stderrParts.join(''), exitCode: hadError ? 1 : 0 };
  });
}
