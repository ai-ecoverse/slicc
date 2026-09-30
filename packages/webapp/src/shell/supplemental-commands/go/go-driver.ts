/**
 * `go` — SLICC's Go driver (#3530 phase 5e): `go build`, `go run`, `go
 * version` and `go env` over an installed Go toolchain package, whose
 * compiler and linker are WASI programs (`cmd/go` itself cannot start them:
 * wasip1 has no processes). It plans the build (`go-plan.ts`), then runs
 * `compile` and `link` as realm processes (`go-build.ts`) against the
 * precompiled standard library of the target — `wasip1/wasm` by default, so
 * what it builds runs here; any other `GOOS`/`GOARCH` whose std is installed
 * cross-compiles.
 */
import type { CommandContext, IFileSystem } from 'just-bash';
import { textAsStdin } from '../../just-bash-compat.js';
import type { RunWasmOptions } from '../wasm/run.js';
import { build, exeName, type ToolRunner } from './go-build.js';
import { findModule, GoError, type GoFs, type GoPlan, GoPlanner, normalize } from './go-plan.js';
import { type GoToolchain, scanGo, stdArchives } from './go-toolchain.js';

type Result = {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutKind?: 'text' | 'bytes';
};

const USAGE = `Go is a tool for managing Go source code (SLICC's driver).

Usage:

\tgo <command> [arguments]

The commands are:

\tbuild       compile packages and dependencies
\trun         compile and run Go program
\tenv         print Go environment information
\tversion     print Go version

Builds are for GOOS=wasip1 GOARCH=wasm unless the environment says otherwise;
a wasip1 program runs here (./prog, or go run). Only the standard library and
the main module's own packages build: no cgo, //go:embed, assembly or module
downloads yet.
`;

const NO_TOOLCHAIN =
  'go: no Go toolchain installed: install one with `ipk add -g` (a package whose manifest has a `slicc.go` block)\n';

/** Build flags go takes before the packages. */
interface BuildFlags {
  output?: string;
  verbose?: boolean;
  trace?: boolean;
  tags?: string[];
  gcflags?: string[];
  ldflags?: string[];
}

/** Flags that take a value, and those that do not (a few accepted and ignored). */
const VALUED = new Set(['-o', '-tags', '-gcflags', '-ldflags', '-p', '-mod', '-modfile', '-C']);
const BOOLEAN = new Set(['-v', '-x', '-a', '-n', '-trimpath', '-work', '-buildvcs=false']);
const REFUSED = new Set(['-race', '-msan', '-asan', '-cover', '-linkshared', '-buildmode']);

function splitFlags(value: string): string[] {
  return value.match(/'[^']*'|"[^"]*"|\S+/g)?.map((s) => s.replace(/^['"]|['"]$/g, '')) ?? [];
}

/** One valued flag's effect. */
function setFlag(flags: BuildFlags, name: string, value: string): void {
  if (name === '-o') flags.output = value;
  else if (name === '-tags') flags.tags = value.split(/[,\s]+/).filter(Boolean);
  else if (name === '-gcflags') flags.gcflags = splitFlags(value.replace(/^all=/, ''));
  else if (name === '-ldflags') flags.ldflags = splitFlags(value.replace(/^all=/, ''));
}

/** The flag at `args[i]` applied to `flags`: how many arguments it took. */
function takeFlag(flags: BuildFlags, args: readonly string[], i: number): number {
  const arg = args[i] as string;
  const eq = arg.indexOf('=');
  const name = (eq > 0 ? arg.slice(0, eq) : arg).replace(/^--/, '-');
  if (REFUSED.has(name)) throw new GoError(`go: ${name} is not supported by SLICC's go`);
  if (BOOLEAN.has(name) || BOOLEAN.has(arg)) {
    if (name === '-v') flags.verbose = true;
    if (name === '-x') flags.trace = true;
    return 1;
  }
  if (!VALUED.has(name)) throw new GoError(`go: unknown flag ${arg}`);
  const value = eq > 0 ? arg.slice(eq + 1) : args[i + 1];
  if (value === undefined) throw new GoError(`go: flag needs an argument: ${name}`);
  setFlag(flags, name, value);
  return eq > 0 ? 1 : 2;
}

/** Build flags off the front of `args`; what is left. */
export function parseBuildFlags(args: readonly string[]): { flags: BuildFlags; rest: string[] } {
  const flags: BuildFlags = {};
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith('-')) {
    if (args[i] === '--') {
      i++;
      break;
    }
    i += takeFlag(flags, args, i);
  }
  return { flags, rest: args.slice(i) };
}

/** The shell's filesystem as planning and the toolchain scan read it. */
function goFs(fs: IFileSystem): GoFs {
  return {
    readText: async (p) => {
      const c = await fs.readFile(p);
      return typeof c === 'string' ? c : new TextDecoder().decode(c as unknown as Uint8Array);
    },
    readdir: async (p) => {
      if (fs.readdirWithFileTypes) {
        return (await fs.readdirWithFileTypes(p)).map((e) => ({
          name: e.name,
          isDir: e.isDirectory,
        }));
      }
      const out: Array<{ name: string; isDir: boolean }> = [];
      for (const name of await fs.readdir(p)) {
        out.push({ name, isDir: (await fs.stat(`${p}/${name}`)).isDirectory });
      }
      return out;
    },
    exists: (p) => fs.exists(p),
  };
}

/** The target: the environment's GOOS / GOARCH, else the realm's. */
function targetOf(ctx: CommandContext): { goos: string; goarch: string } {
  return { goos: ctx.env.get('GOOS') || 'wasip1', goarch: ctx.env.get('GOARCH') || 'wasm' };
}

/** A tool's context: the target in its environment, no stdin (compile and link never read it). */
function toolContext(ctx: CommandContext, env: Record<string, string>): CommandContext {
  const exported = { ...(ctx.exportedEnv ?? Object.fromEntries(ctx.env)), ...env };
  return {
    ...ctx,
    stdin: textAsStdin(''),
    env: new Map([...ctx.env, ...Object.entries(env)]),
    exportedEnv: exported,
  };
}

/** How the driver runs a tool: a realm process through `runWasmCommand`, its output collected. */
function wasmRunner(ctx: CommandContext, options: RunWasmOptions): ToolRunner {
  return async (tool, args, env) => {
    const { runWasmCommand } = await import('../wasm/run.js');
    const r = await runWasmCommand([tool, ...args], toolContext(ctx, env), {
      ...options,
      onOutput: undefined,
    });
    return { exitCode: r.exitCode, stdout: String(r.stdout), stderr: r.stderr };
  };
}

export interface GoDriverDeps {
  /** Runs a tool (tests pass their own; the command passes the realm's). */
  runner?: ToolRunner;
  /** Runs a built wasip1 program for `go run` (argv[0] is its path). */
  runProgram?: (argv: string[]) => Promise<Result>;
}

/** The installed toolchain to use: the newest version, if several. */
function pick(toolchains: readonly GoToolchain[]): GoToolchain | undefined {
  return [...toolchains].sort((a, b) => compareVersions(b.version, a.version))[0];
}

function compareVersions(a: string, b: string): number {
  const nums = (v: string) =>
    v
      .replace(/^go/, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function runGoCommand(
  args: string[],
  ctx: CommandContext,
  options: RunWasmOptions = {},
  deps: GoDriverDeps = {}
): Promise<Result> {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    return { stdout: cmd ? USAGE : '', stderr: cmd ? '' : USAGE, exitCode: cmd ? 0 : 2 };
  }
  const fs = goFs(ctx.fs);
  const { toolchains, std } = await scanGo(fs);
  const toolchain = pick(toolchains);
  const { goos, goarch } = targetOf(ctx);
  try {
    switch (cmd) {
      case 'version':
        if (!toolchain) return { stdout: '', stderr: NO_TOOLCHAIN, exitCode: 1 };
        return {
          stdout: `go version ${toolchain.version} ${goos}/${goarch}\n`,
          stderr: '',
          exitCode: 0,
        };
      case 'env':
        return goEnv(rest, ctx, toolchain, fs);
      case 'build':
      case 'run': {
        if (!toolchain) return { stdout: '', stderr: NO_TOOLCHAIN, exitCode: 1 };
        const archives = await stdArchives(fs, std, toolchain.version, `${goos}/${goarch}`);
        if (archives.size === 0) {
          return {
            stdout: '',
            stderr: `go: no standard library for ${goos}/${goarch} (${toolchain.version}) installed\n`,
            exitCode: 1,
          };
        }
        const b = { ctx, toolchain, goos, goarch, archives, options, deps, fs };
        return cmd === 'build' ? await goBuild(rest, b) : await goRun(rest, b);
      }
      default:
        return {
          stdout: '',
          stderr: `go ${cmd}: unknown command (SLICC's go supports build, run, env and version)\nRun 'go help' for usage.\n`,
          exitCode: 2,
        };
    }
  } catch (e) {
    if (e instanceof GoError)
      return { stdout: '', stderr: e.message ? `${e.message}\n` : '', exitCode: 1 };
    throw e;
  }
}

interface BuildContext {
  ctx: CommandContext;
  toolchain: GoToolchain;
  goos: string;
  goarch: string;
  archives: Map<string, string>;
  options: RunWasmOptions;
  deps: GoDriverDeps;
  fs: GoFs;
}

async function plan(b: BuildContext, flags: BuildFlags, pkgs: string[]): Promise<GoPlan> {
  const { ctx, toolchain, goos, goarch, archives, fs } = b;
  const module = await findModule(fs, ctx.cwd);
  const target = {
    goos,
    goarch,
    version: toolchain.version,
    ...(flags.tags ? { tags: flags.tags } : {}),
  };
  return new GoPlanner(fs, target, new Set(archives.keys()), module, ctx.cwd).plan(pkgs);
}

/** A scratch directory under $TMPDIR, removed by the caller. */
async function workDir(ctx: CommandContext): Promise<string> {
  const tmp = ctx.env.get('TMPDIR') || '/tmp';
  const dir = `${tmp.replace(/\/+$/, '')}/go-build${Math.random().toString(36).slice(2, 10)}`;
  await ctx.fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Compiles and links `p` with the outputs given; the log (stderr) it wrote. */
async function compileAndLink(
  b: BuildContext,
  flags: BuildFlags,
  p: GoPlan,
  work: string,
  outputs: Map<string, string>
): Promise<string> {
  const { ctx, toolchain, goos, goarch, archives, options, deps } = b;
  let log = '';
  await build(
    p,
    {
      writeFile: (path, content) => ctx.fs.writeFile(path, content),
      mkdir: (path) => ctx.fs.mkdir(path, { recursive: true }),
    },
    deps.runner ?? wasmRunner(ctx, options),
    {
      toolchain,
      goos,
      goarch,
      std: archives,
      work,
      cwd: ctx.cwd,
      outputs,
      ...(flags.gcflags ? { gcflags: flags.gcflags } : {}),
      ...(flags.ldflags ? { ldflags: flags.ldflags } : {}),
      ...(flags.verbose ? { verbose: true } : {}),
      ...(flags.trace ? { trace: true } : {}),
      log: (text) => {
        log += text;
      },
    }
  ).catch((e) => {
    if (e instanceof GoError) throw new GoError(`${log}${e.message}`.replace(/\n$/, ''));
    throw e;
  });
  for (const exe of outputs.values()) await ctx.fs.chmod(exe, 0o755);
  return log;
}

async function goBuild(args: string[], b: BuildContext): Promise<Result> {
  const { flags, rest } = parseBuildFlags(args);
  const { ctx, goos } = b;
  const p = await plan(b, flags, rest);
  const mains = p.roots.filter((r) => r.name === 'main');
  const outputs = new Map<string, string>();
  const out =
    flags.output &&
    normalize(flags.output.startsWith('/') ? flags.output : `${ctx.cwd}/${flags.output}`);
  const outIsDir =
    flags.output !== undefined &&
    (flags.output.endsWith('/') ||
      (out !== undefined && (await ctx.fs.exists(out)) && (await ctx.fs.stat(out)).isDirectory));
  if (out && !outIsDir && p.roots.length > 1) {
    throw new GoError('go: -o names a file, but several packages are built (name a directory)');
  }
  if (out && !outIsDir && mains.length === 0) {
    throw new GoError('go: -o names a file, but the package built is not a main package');
  }
  // go build of one main package writes its executable; of several, only with -o DIR.
  if (mains.length === 1 && p.roots.length === 1) {
    const main = mains[0] as (typeof mains)[number];
    outputs.set(main.path, out && !outIsDir ? out : `${out ?? ctx.cwd}/${exeName(main, goos)}`);
  } else if (out && outIsDir) {
    for (const m of mains) outputs.set(m.path, `${out}/${exeName(m, goos)}`);
  }
  const work = await workDir(ctx);
  try {
    const log = await compileAndLink(b, flags, p, work, outputs);
    return { stdout: '', stderr: log, exitCode: 0 };
  } finally {
    await ctx.fs.rm(work, { recursive: true, force: true });
  }
}

/** `go run`'s packages (one, or `.go` files) and the program's arguments. */
function runArgs(rest: string[]): { pkgs: string[]; progArgs: string[] } {
  if (rest.length === 0) throw new GoError('go: no go files listed');
  if ((rest[0] as string).endsWith('.go')) {
    let n = 0;
    while (n < rest.length && (rest[n] as string).endsWith('.go')) n++;
    return { pkgs: rest.slice(0, n), progArgs: rest.slice(n) };
  }
  return { pkgs: [rest[0] as string], progArgs: rest.slice(1) };
}

async function goRun(args: string[], b: BuildContext): Promise<Result> {
  const { flags, rest } = parseBuildFlags(args);
  const { ctx, goos, goarch } = b;
  if (goos !== 'wasip1' || goarch !== 'wasm') {
    throw new GoError(
      `go: cannot run ${goos}/${goarch} programs here: build them with go build (only wasip1/wasm runs in SLICC)`
    );
  }
  const { pkgs, progArgs } = runArgs(rest);
  const p = await plan(b, flags, pkgs);
  const main = p.roots[0];
  if (main?.name !== 'main') {
    throw new GoError(`package ${main?.path ?? pkgs[0]} is not a main package`);
  }
  const work = await workDir(ctx);
  try {
    const exe = `${work}/exe/${exeName(main, goos)}`;
    await ctx.fs.mkdir(`${work}/exe`, { recursive: true });
    const log = await compileAndLink(b, flags, p, work, new Map([[main.path, exe]]));
    const r = await (b.deps.runProgram ?? programRunner(ctx, b.options))([exe, ...progArgs]);
    if (r.exitCode === 0) return { ...r, stderr: `${log}${r.stderr}` };
    return { ...r, stderr: `${log}${r.stderr}exit status ${r.exitCode}\n`, exitCode: 1 };
  } finally {
    await ctx.fs.rm(work, { recursive: true, force: true });
  }
}

/** `go run`'s program: a realm process on the command's own stdio. */
function programRunner(
  ctx: CommandContext,
  options: RunWasmOptions
): (argv: string[]) => Promise<Result> {
  return async (argv) => {
    const { runWasmCommand } = await import('../wasm/run.js');
    const name = (argv[0] as string).split('/').pop() as string;
    return runWasmCommand(['--argv0', name, ...argv], ctx, options);
  };
}

/** `go env [VAR...]`: the driver's view — the target, the GOROOT, cgo off, the module. */
async function goEnv(
  vars: string[],
  ctx: CommandContext,
  toolchain: GoToolchain | undefined,
  fs: GoFs
): Promise<Result> {
  const { goos, goarch } = targetOf(ctx);
  const module = await findModule(fs, ctx.cwd);
  const env: Record<string, string> = {
    GOARCH: goarch,
    GOOS: goos,
    GOHOSTARCH: 'wasm',
    GOHOSTOS: 'wasip1',
    GOROOT: toolchain?.goroot ?? '',
    GOTOOLDIR: toolchain ? `${toolchain.goroot}/pkg/tool/wasip1_wasm` : '',
    GOVERSION: toolchain?.version ?? '',
    CGO_ENABLED: '0',
    GOMOD: module ? `${module.dir === '/' ? '' : module.dir}/go.mod` : '/dev/null',
    GOFLAGS: ctx.env.get('GOFLAGS') ?? '',
  };
  const names = vars.filter((v) => !v.startsWith('-'));
  if (names.length > 0) {
    return {
      stdout: names.map((n) => `${env[n] ?? ctx.env.get(n) ?? ''}\n`).join(''),
      stderr: '',
      exitCode: 0,
    };
  }
  const lines = Object.keys(env)
    .sort()
    .map((k) => `${k}='${env[k]}'`);
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
}
