import { GoError, type GoPackage, type GoPlan } from './go-plan.js';
import { type GoToolchain, toolPath } from './go-toolchain.js';

export type ToolRunner = (
  tool: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface BuildFs {
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface BuildOptions {
  toolchain: GoToolchain;
  goos: string;
  goarch: string;

  std: ReadonlyMap<string, string>;

  work: string;
  cwd: string;

  outputs: ReadonlyMap<string, string>;

  gcflags?: readonly string[];
  ldflags?: readonly string[];

  verbose?: boolean;
  trace?: boolean;

  log: (text: string) => void;
}

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

function diagnostic(pkg: string, stderr: string, cwd: string): string {
  const base = cwd === '/' ? '/' : `${cwd}/`;
  const text = stderr.split(base).join('./');
  return `# ${pkg}\n${text}${text.endsWith('\n') || !text ? '' : '\n'}`;
}

function lang(plan: GoPlan): string[] {
  const v = plan.module?.goVersion;
  return v ? [`-lang=go${v}`] : [];
}

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

export function exeName(pkg: GoPackage, goos: string): string {
  const parts = pkg.path.split('/');

  if (parts.length > 1 && /^v\d+$/.test(parts[parts.length - 1] as string)) parts.pop();
  const base =
    pkg.path === 'command-line-arguments'
      ? (pkg.files[0]?.split('/').pop() ?? 'main').replace(/\.go$/, '')
      : (parts[parts.length - 1] as string);
  return goos === 'windows' ? `${base}.exe` : base;
}
