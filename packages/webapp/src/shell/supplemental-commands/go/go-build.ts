/**
 * `go-build.ts` — carrying out a build plan (#3530 phase 5e) as `go build`
 * would: each package of the module compiled (`compile -p … -importcfg …
 * -pack`), dependencies first, against the precompiled standard library;
 * each main package linked (`link -importcfg … -buildmode=exe`). The tools
 * are the toolchain's WASI programs, run as realm processes by the caller's
 * {@link ToolRunner}: `cmd/go` cannot start them itself under WASI.
 */
import { GoError, type GoPackage, type GoPlan } from './go-plan.js';
import { type GoToolchain, toolPath } from './go-toolchain.js';

/** A tool's run: `tool` (absolute path) with `args` and `env`; its status and output. */
export type ToolRunner = (
  tool: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** What building writes: the work directory's files, and the output. */
export interface BuildFs {
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface BuildOptions {
  toolchain: GoToolchain;
  goos: string;
  goarch: string;
  /** The target's std archives by import path. */
  std: ReadonlyMap<string, string>;
  /** A fresh scratch directory. */
  work: string;
  cwd: string;
  /** `-o`: where each main package's executable goes (by import path). */
  outputs: ReadonlyMap<string, string>;
  /** `-gcflags` / `-ldflags`, split. */
  gcflags?: readonly string[];
  ldflags?: readonly string[];
  /** `-v`: package paths as they compile. `-x`: the commands. */
  verbose?: boolean;
  trace?: boolean;
  /** Progress and diagnostics (go's stderr). */
  log: (text: string) => void;
}

/** The environment the tools run in: the target, the GOROOT, cgo off. */
export function toolEnv(
  o: Pick<BuildOptions, 'toolchain' | 'goos' | 'goarch'>
): Record<string, string> {
  return {
    GOOS: o.goos,
    GOARCH: o.goarch,
    GOROOT: o.toolchain.goroot,
    CGO_ENABLED: '0',
  };
}

/** A diagnostic from a tool, as go shows it: `# pkg` then paths relative to the cwd. */
function diagnostic(pkg: string, stderr: string, cwd: string): string {
  const base = cwd === '/' ? '/' : `${cwd}/`;
  const text = stderr.split(base).join('./');
  return `# ${pkg}\n${text}${text.endsWith('\n') || !text ? '' : '\n'}`;
}

/** The `-lang` a module's `go` directive asks for (go1.22), or none. */
function lang(plan: GoPlan): string[] {
  const v = plan.module?.goVersion;
  return v ? [`-lang=go${v}`] : [];
}

/** Builds `plan`: every package compiled, every main package among the roots linked to its output. */
export async function build(
  plan: GoPlan,
  fs: BuildFs,
  run: ToolRunner,
  o: BuildOptions
): Promise<void> {
  const env = toolEnv(o);
  const archives = new Map<string, string>();
  let n = 0;
  const exec = async (tool: 'compile' | 'link', args: string[], pkg: string): Promise<void> => {
    const path = toolPath(o.toolchain, tool);
    if (o.trace) o.log(`${path} ${args.join(' ')}\n`);
    const r = await run(path, args, env);
    if (r.exitCode !== 0) {
      o.log(diagnostic(pkg, r.stderr || r.stdout || `${tool}: exit status ${r.exitCode}\n`, o.cwd));
      throw new GoError('');
    }
  };
  for (const pkg of plan.packages) {
    const dir = `${o.work}/b${String(++n).padStart(3, '0')}`;
    await fs.mkdir(dir);
    const cfg = `${dir}/importcfg`;
    await fs.writeFile(cfg, importcfg(pkg.imports, archives, o.std));
    const out = `${dir}/_pkg_.a`;
    if (o.verbose) o.log(`${pkg.path}\n`);
    await exec(
      'compile',
      [
        '-o',
        out,
        '-p',
        pkg.name === 'main' ? 'main' : pkg.path,
        ...lang(plan),
        '-complete',
        '-importcfg',
        cfg,
        ...(o.gcflags ?? []),
        '-pack',
        ...pkg.files,
      ],
      pkg.path
    );
    archives.set(pkg.path, out);
  }
  const linkcfg = `${o.work}/importcfg.link`;
  await fs.writeFile(linkcfg, importcfg([...archives.keys(), ...o.std.keys()], archives, o.std));
  for (const root of plan.roots) {
    const exe = o.outputs.get(root.path);
    if (root.name !== 'main' || !exe) continue;
    await exec(
      'link',
      [
        '-o',
        exe,
        '-importcfg',
        linkcfg,
        '-buildmode=exe',
        ...(o.ldflags ?? []),
        archives.get(root.path) as string,
      ],
      root.path
    );
  }
}

/** An importcfg: `packagefile` for each of `paths`, the module's archives before std's. */
function importcfg(
  paths: readonly string[],
  module: ReadonlyMap<string, string>,
  std: ReadonlyMap<string, string>
): string {
  const lines = ['# import config'];
  const seen = new Set<string>();
  for (const p of paths) {
    const file = module.get(p) ?? std.get(p);
    if (!file || seen.has(p)) continue;
    seen.add(p);
    lines.push(`packagefile ${p}=${file}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The executable name go gives a main package: its path's last element (`.exe` on windows). */
export function exeName(pkg: GoPackage, goos: string): string {
  const parts = pkg.path.split('/');
  // A major-version suffix is not the name: example.com/tool/v2 builds `tool`.
  if (parts.length > 1 && /^v\d+$/.test(parts[parts.length - 1] as string)) parts.pop();
  const base =
    pkg.path === 'command-line-arguments'
      ? (pkg.files[0]?.split('/').pop() ?? 'main').replace(/\.go$/, '')
      : (parts[parts.length - 1] as string);
  return goos === 'windows' ? `${base}.exe` : base;
}
