import type { Command, CommandContext } from 'just-bash';
import { createEntryTranspile, hasDynamicImport, hasEsmSyntax } from '../ipk/esm-transpile.js';
import type { JshProcessConfig } from '../jsh-executor.js';
import { executeJsCode } from '../jsh-executor.js';
import { EMPTY_BYTES, stdinAsText } from '../just-bash-compat.js';
import { stripShebang } from '../strip-shebang.js';
import { getEsbuild } from './esbuild-wasm.js';
import { NODE_VERSION } from './shared.js';

export interface NodeCommandOptions {
  buildProcessConfig?: (runEnv?: ReadonlyMap<string, string>) => JshProcessConfig | undefined;
}

const STDIN_SCRIPT_TOKENS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

type NodeInputType = 'module' | 'commonjs';

type NodeCommandResult = { stdout: string; stderr: string; exitCode: number };

type ParsedNodeLeadingArgs = {
  help: boolean;
  version: boolean;
  check: boolean;
  inputType: NodeInputType | undefined;
  sourceIndex: number;
  error?: NodeCommandResult;
};

function isProgramSourceToken(arg: string): boolean {
  return arg === '-e' || arg === '--eval' || STDIN_SCRIPT_TOKENS.has(arg) || !arg.startsWith('-');
}

function invalidInputType(value: string): NodeCommandResult {
  return {
    stdout: '',
    stderr: `node: ${value} is not a valid value for --input-type. Valid values are: 'commonjs' or 'module'.\n`,
    exitCode: 9,
  };
}

function readInputTypeArg(
  arg: string,
  next: string | undefined,
  index: number
): { inputType?: NodeInputType; nextIndex: number; error?: NodeCommandResult } {
  const inline = arg.startsWith('--input-type=');
  const value = inline ? arg.slice('--input-type='.length) : next;
  const nextIndex = inline ? index + 1 : index + 2;
  if (value === undefined) {
    return {
      nextIndex: index + 1,
      error: {
        stdout: '',
        stderr: 'node: option --input-type requires an argument\n',
        exitCode: 9,
      },
    };
  }
  if (value !== 'module' && value !== 'commonjs') {
    return { nextIndex, error: invalidInputType(value) };
  }
  return { inputType: value, nextIndex };
}

function parseNodeLeadingArgs(args: string[]): ParsedNodeLeadingArgs {
  let help = false;
  let version = false;
  let check = false;
  let inputType: NodeInputType | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (isProgramSourceToken(arg)) break;
    if (arg === '-h' || arg === '--help') {
      help = true;
      i += 1;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      version = true;
      i += 1;
      continue;
    }
    if (arg === '-c' || arg === '--check') {
      check = true;
      i += 1;
      continue;
    }
    if (arg === '--input-type' || arg.startsWith('--input-type=')) {
      const parsed = readInputTypeArg(arg, args[i + 1], i);
      if (parsed.error) {
        return {
          help,
          version,
          check,
          inputType,
          sourceIndex: parsed.nextIndex,
          error: parsed.error,
        };
      }
      inputType = parsed.inputType;
      i = parsed.nextIndex;
      continue;
    }
    return {
      help,
      version,
      check,
      inputType,
      sourceIndex: i,
      error: { stdout: '', stderr: `node: unsupported option '${arg}'\n`, exitCode: 9 },
    };
  }
  return { help, version, check, inputType, sourceIndex: i };
}

function nodeHelp(): NodeCommandResult {
  return {
    stdout:
      'usage: node [options] [script.js] [args...]\n' +
      '       node [options] -e <code> [args...]\n' +
      '\n' +
      'Options:\n' +
      '  -e, --eval CODE          evaluate CODE\n' +
      '  -c, --check              syntax-check without executing\n' +
      '  --input-type=TYPE        module or commonjs (stdin / -e / .js)\n' +
      '  -h, --help               print this help\n' +
      '  -v, --version            print Node shim version\n',
    stderr: '',
    exitCode: 0,
  };
}

function nodeVersion(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `${NODE_VERSION}\n`,
    stderr: '',
    exitCode: 0,
  };
}

function inputTypeConflict(
  filename: string,
  inputType: NodeInputType | undefined
): NodeCommandResult | undefined {
  if (!inputType) return undefined;
  if (filename.endsWith('.mjs') && inputType === 'commonjs') {
    return {
      stdout: '',
      stderr: 'node: cannot set --input-type=commonjs for a .mjs file\n',
      exitCode: 9,
    };
  }
  if (filename.endsWith('.cjs') && inputType === 'module') {
    return {
      stdout: '',
      stderr: 'node: cannot set --input-type=module for a .cjs file\n',
      exitCode: 9,
    };
  }
  return undefined;
}

function dirnameOf(path: string, cwd: string): string {
  if (!path.startsWith('/')) return cwd;
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

async function transpileEntryForCheck(
  code: string,
  filename: string,
  cwd: string
): Promise<string> {
  const needsTranspile = hasEsmSyntax(code) || hasDynamicImport(code) || filename.endsWith('.mjs');
  if (!needsTranspile) return code;
  try {
    const esbuild = await getEsbuild();
    const result = await esbuild.transform(code, {
      loader: 'js',
      format: 'cjs',
      sourcefile: `${filename.replace(/\.[^./]+$/, '')}.js`,
      supported: { 'dynamic-import': false },
    });
    return result.code;
  } catch (err: unknown) {
    if (!/top-level await/i.test(errorMessage(err))) throw err;
    const transpile = createEntryTranspile();
    return transpile({ source: code, filename, fromDir: dirnameOf(filename, cwd) });
  }
}

async function checkJsSyntax(
  code: string,
  filename: string,
  cwd: string
): Promise<NodeCommandResult> {
  let toParse = code;
  try {
    toParse = await transpileEntryForCheck(code, filename, cwd);
  } catch (err: unknown) {
    return { stdout: '', stderr: `${errorMessage(err)}\n`, exitCode: 1 };
  }
  try {
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => unknown;
    void new AsyncFn(toParse);
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    return { stdout: '', stderr: `${errorMessage(err)}\n`, exitCode: 1 };
  }
}

type NodeInvocation =
  | { kind: 'ok'; code: string; filename: string; argv: string[]; innerCtx: CommandContext }
  | { kind: 'result'; result: { stdout: string; stderr: string; exitCode: number } };

async function resolveInvocation(args: string[], ctx: CommandContext): Promise<NodeInvocation> {
  if (args.length > 0 && (args[0] === '-e' || args[0] === '--eval')) {
    if (!args[1]) {
      return {
        kind: 'result',
        result: { stdout: '', stderr: 'node: option requires an argument -- eval\n', exitCode: 9 },
      };
    }
    return {
      kind: 'ok',
      code: args[1],
      filename: '[eval]',
      argv: ['node', ...args.slice(2)],
      innerCtx: ctx,
    };
  }

  if (args.length > 0 && STDIN_SCRIPT_TOKENS.has(args[0])) {
    return {
      kind: 'ok',
      code: stdinAsText(ctx.stdin),
      filename: '<stdin>',
      argv: ['node', args[0], ...args.slice(1)],
      innerCtx: { ...ctx, stdin: EMPTY_BYTES },
    };
  }

  if (args.length > 0 && !args[0].startsWith('-')) {
    const scriptArg = args[0];
    const scriptPath = ctx.fs.resolvePath(ctx.cwd, scriptArg);
    if (!(await ctx.fs.exists(scriptPath))) {
      return {
        kind: 'result',
        result: { stdout: '', stderr: `node: cannot find module '${scriptArg}'\n`, exitCode: 1 },
      };
    }

    return {
      kind: 'ok',
      code: await ctx.fs.readFile(scriptPath),
      filename: scriptPath,
      argv: ['node', scriptPath, ...args.slice(1)],
      innerCtx: ctx,
    };
  }

  if (stdinAsText(ctx.stdin).trim().length > 0) {
    return {
      kind: 'ok',
      code: stdinAsText(ctx.stdin),
      filename: '<stdin>',
      argv: ['node'],
      innerCtx: { ...ctx, stdin: EMPTY_BYTES },
    };
  }

  if (args.length > 0) {
    return {
      kind: 'result',
      result: { stdout: '', stderr: `node: unsupported option '${args[0]}'\n`, exitCode: 9 },
    };
  }

  return {
    kind: 'result',
    result: {
      stdout: '',
      stderr: 'node: REPL mode is not supported in this environment; use node -e "code"\n',
      exitCode: 9,
    },
  };
}

export function createNodeCommand(options: NodeCommandOptions = {}): Command {
  return {
    name: 'node',

    trusted: true,
    async execute(args: string[], ctx: CommandContext) {
      const parsed = parseNodeLeadingArgs(args);
      if (parsed.error) return parsed.error;
      if (parsed.help) return nodeHelp();
      if (parsed.version) return nodeVersion();

      const resolved = await resolveInvocation(args.slice(parsed.sourceIndex), ctx);
      if (resolved.kind === 'result') {
        if (
          parsed.check &&
          resolved.result.exitCode === 9 &&
          args.slice(parsed.sourceIndex).length === 0
        ) {
          return {
            stdout: '',
            stderr: 'node: -c/--check requires a filename or -e CODE\n',
            exitCode: 9,
          };
        }
        return resolved.result;
      }
      const { code, filename, argv, innerCtx } = resolved;
      const conflict = inputTypeConflict(filename, parsed.inputType);
      if (conflict) return conflict;
      const stripped = stripShebang(code);
      if (parsed.check) return checkJsSyntax(stripped, filename, ctx.cwd);

      return executeJsCode(stripped, argv, innerCtx, options.buildProcessConfig?.(ctx.env), {
        filename,
      });
    },
  };
}
