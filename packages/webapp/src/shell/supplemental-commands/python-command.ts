import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { ProcessManager, ProcessOwner } from '../../kernel/process-manager.js';
import {
  PYODIDE_NOT_INSTALLED,
  PYODIDE_VERSION,
  tryResolvePyodideAssetRoot,
} from '../../kernel/realm/py-realm-shared.js';
import {
  createDefaultRealmFactory,
  resolvePyodideIndexURL,
} from '../../kernel/realm/realm-factory.js';
import type { RealmFactory } from '../../kernel/realm/realm-runner.js';
import { runInRealm } from '../../kernel/realm/realm-runner.js';
import type { RealmMountPoint } from '../../kernel/realm/realm-types.js';
import type { JshProcessConfig } from '../jsh-executor.js';
import { stdinAsText } from '../just-bash-compat.js';

const PYODIDE_BUILTIN_ROOT_NAMES = new Set([
  'dev',
  'proc',
  'lib',
  'bin',
  'usr',
  'etc',
  'home',
  'tmp',
]);

export async function computePyodideMountDirs(
  fs: CommandContext['fs'],
  builtins: ReadonlySet<string> = PYODIDE_BUILTIN_ROOT_NAMES
): Promise<string[]> {
  const dirs: string[] = [];
  const seen = new Set<string>();
  try {
    const names = await fs.readdir('/');
    for (const name of names) {
      if (!name || name.includes('/')) continue;
      if (builtins.has(name)) continue;
      const abs = `/${name}`;
      let isDir = false;
      try {
        const st = await fs.stat(abs);
        isDir = !!st.isDirectory;
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      dirs.push(abs);
    }
  } catch {}
  if (!seen.has('/tmp')) {
    seen.add('/tmp');
    dirs.push('/tmp');
  }
  return dirs;
}

export function computeOverlappingMountPoints(
  fs: CommandContext['fs'],
  syncDirs: readonly string[]
): RealmMountPoint[] {
  const wrapped = fs as unknown as {
    listMountPoints?: () => {
      path: string;
      kind: 'local' | 'hostfs' | 's3' | 'da' | 'aem' | 'proc';
    }[];
  };
  if (typeof wrapped.listMountPoints !== 'function') return [];
  const overlap = (mountPath: string): boolean => {
    for (const dir of syncDirs) {
      if (mountPath === dir) return true;
      if (mountPath.startsWith(dir === '/' ? '/' : dir + '/')) return true;
      if (dir.startsWith(mountPath + '/')) return true;
    }
    return false;
  };
  const out: RealmMountPoint[] = [];
  for (const entry of wrapped.listMountPoints()) {
    if (entry.kind === 'proc') continue;
    if (!overlap(entry.path)) continue;
    out.push({ path: entry.path, kind: entry.kind });
  }
  return out;
}

const OPFS_KERNEL_DB_NAME = 'slicc-fs';

function resolveOpfsMountDbName(): string | undefined {
  try {
    const storage = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } })
      .navigator?.storage;
    if (typeof storage?.getDirectory === 'function') return OPFS_KERNEL_DB_NAME;
  } catch {}
  return undefined;
}

export interface PythonCommandOptions {
  realmFactory?: RealmFactory;

  pyodideIndexURL?: string;

  pyodideAssetRoot?: string;

  buildProcessConfig?: (runEnv?: ReadonlyMap<string, string>) => JshProcessConfig | undefined;
}

function createPyodideIpkContext(ctx: CommandContext): {
  reader: {
    exists(path: string): Promise<boolean>;
    isDirectory(path: string): Promise<boolean>;
    readFile(path: string): Promise<string>;
  };
  fromDir: string;
} {
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
    fromDir: ctx.cwd,
  };
}

export async function readInstalledPyodideVersion(
  reader: { readFile(path: string): Promise<string> },
  assetRoot: string
): Promise<string | null> {
  try {
    const text = await reader.readFile(`${assetRoot}/package.json`);
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export function pyodideVersionMismatchMessage(installed: string, pinned: string): string {
  return `installed pyodide ${installed} is not the supported version ${pinned}: run \`ipk uninstall pyodide\` then \`ipk add pyodide@${pinned}\``;
}

function pythonHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: python3 [-c code | script.py] [args...]\n',
    stderr: '',
    exitCode: 0,
  };
}

function pythonVersion(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'Python 3.14 (Pyodide)\n',
    stderr: '',
    exitCode: 0,
  };
}

type PythonCommandResult = { stdout: string; stderr: string; exitCode: number };

type ParsedPythonInvocation =
  | { kind: 'result'; result: PythonCommandResult }
  | { kind: 'ok'; code: string; filename: string; sysArgv: string[]; procArgv: string[] };

async function parsePythonInvocation(
  name: 'python3' | 'python',
  args: string[],
  ctx: CommandContext
): Promise<ParsedPythonInvocation> {
  if (args[0] === '-c') {
    if (!args[1]) {
      return {
        kind: 'result',
        result: {
          stdout: '',
          stderr: `${name}: option requires an argument -- 'c'\n`,
          exitCode: 2,
        },
      };
    }
    const code = args[1];
    return {
      kind: 'ok',
      code,
      filename: '-c',
      sysArgv: ['-c', ...args.slice(2)],
      procArgv: [name, '-c', code, ...args.slice(2)],
    };
  }
  if (args.length > 0 && !args[0].startsWith('-')) {
    const scriptArg = args[0];
    const scriptPath = ctx.fs.resolvePath(ctx.cwd, scriptArg);
    if (!(await ctx.fs.exists(scriptPath))) {
      return {
        kind: 'result',
        result: {
          stdout: '',
          stderr: `${name}: can't open file '${scriptArg}': [Errno 2] No such file or directory\n`,
          exitCode: 2,
        },
      };
    }
    const code = await ctx.fs.readFile(scriptPath);
    return {
      kind: 'ok',
      code,
      filename: scriptArg,
      sysArgv: [scriptArg, ...args.slice(1)],
      procArgv: [name, scriptArg, ...args.slice(1)],
    };
  }
  if (stdinAsText(ctx.stdin).trim().length > 0) {
    return {
      kind: 'ok',
      code: stdinAsText(ctx.stdin),
      filename: '<stdin>',
      sysArgv: ['<stdin>'],
      procArgv: [name],
    };
  }
  if (args.length > 0) {
    return {
      kind: 'result',
      result: { stdout: '', stderr: `${name}: unsupported option '${args[0]}'\n`, exitCode: 2 },
    };
  }
  return {
    kind: 'result',
    result: {
      stdout: '',
      stderr: `${name}: no input provided (use -c CODE, script path, or stdin)\n`,
      exitCode: 2,
    },
  };
}

type StandaloneAssetRootResolution =
  | { kind: 'result'; result: PythonCommandResult }
  | { kind: 'ok'; assetRoot: string };

async function resolveStandalonePyodideAssetRoot(
  ctx: CommandContext
): Promise<StandaloneAssetRootResolution> {
  const ipk = createPyodideIpkContext(ctx);
  const resolved = await tryResolvePyodideAssetRoot(ipk);
  if (!resolved) {
    return {
      kind: 'result',
      result: { stdout: '', stderr: `${PYODIDE_NOT_INSTALLED}\n`, exitCode: 1 },
    };
  }
  const installedVersion = await readInstalledPyodideVersion(ipk.reader, resolved);
  if (!installedVersion) {
    return {
      kind: 'result',
      result: { stdout: '', stderr: `${PYODIDE_NOT_INSTALLED}\n`, exitCode: 1 },
    };
  }
  if (installedVersion !== PYODIDE_VERSION) {
    return {
      kind: 'result',
      result: {
        stdout: '',
        stderr: `${pyodideVersionMismatchMessage(installedVersion, PYODIDE_VERSION)}\n`,
        exitCode: 1,
      },
    };
  }
  return { kind: 'ok', assetRoot: resolved };
}

export function createPython3LikeCommand(
  name: 'python3' | 'python',
  options: PythonCommandOptions = {}
): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) return pythonHelp();
    if (args.includes('--version') || args.includes('-V')) return pythonVersion();

    const parsed = await parsePythonInvocation(name, args, ctx);
    if (parsed.kind === 'result') return parsed.result;
    const { code, filename, sysArgv, procArgv } = parsed;

    const syncDirs = await computePyodideMountDirs(ctx.fs);

    const mountPoints = computeOverlappingMountPoints(ctx.fs, syncDirs);

    const pmConfig = options.buildProcessConfig?.(ctx.env);
    const pm = pmConfig?.processManager ?? lookupGlobalPm();
    const owner: ProcessOwner = pmConfig?.owner ?? { kind: 'system' };
    const ppid = pmConfig?.getParentPid?.();
    const realmFactory = options.realmFactory ?? createDefaultRealmFactory();
    const pyodideIndexURL = options.pyodideIndexURL ?? resolvePyodideIndexURL();

    let pyodideAssetRoot = options.pyodideAssetRoot;
    if (!pyodideAssetRoot && pyodideIndexURL === undefined) {
      const resolution = await resolveStandalonePyodideAssetRoot(ctx);
      if (resolution.kind === 'result') return resolution.result;
      pyodideAssetRoot = resolution.assetRoot;
    }

    const realmStdin = filename === '<stdin>' ? '' : stdinAsText(ctx.stdin);
    const opfsMountDbName = resolveOpfsMountDbName();

    if (!pm) {
      return runWithEphemeralPm({
        realmFactory,
        owner,
        code,
        argv: procArgv,
        realmArgv: sysArgv,
        env: Object.fromEntries(ctx.env.entries()),
        cwd: ctx.cwd,
        filename,
        ctx,
        stdin: realmStdin,
        pyodideIndexURL,
        pyodideAssetRoot,
        pyodideMountDirs: syncDirs,
        opfsMountDbName,
        mountPoints,
      });
    }

    return runInRealm({
      pm,
      realmFactory,
      owner,
      kind: 'py',
      code,
      argv: procArgv,
      realmArgv: sysArgv,
      env: Object.fromEntries(ctx.env.entries()),
      cwd: ctx.cwd,
      filename,
      ctx,
      stdin: realmStdin,
      pyodideIndexURL,
      pyodideAssetRoot,
      pyodideMountDirs: syncDirs,
      opfsMountDbName,
      mountPoints,
      procKind: 'py',
      ppid,
    });
  });
}

type SliccPmGlobal = typeof globalThis & { __slicc_pm?: unknown };

function lookupGlobalPm(): ProcessManager | null {
  const pm = (globalThis as SliccPmGlobal).__slicc_pm;
  if (
    pm &&
    typeof pm === 'object' &&
    typeof (pm as { spawn?: unknown }).spawn === 'function' &&
    typeof (pm as { onSignal?: unknown }).onSignal === 'function'
  ) {
    return pm as ProcessManager;
  }
  return null;
}

let EphemeralPm: ProcessManager | null = null;
async function runWithEphemeralPm(args: {
  realmFactory: RealmFactory;
  owner: ProcessOwner;
  code: string;
  argv: string[];
  realmArgv?: string[];
  env: Record<string, string>;
  cwd: string;
  filename: string;
  ctx: Parameters<typeof runInRealm>[0]['ctx'];
  stdin?: string;
  pyodideIndexURL: string | undefined;
  pyodideAssetRoot: string | undefined;
  pyodideMountDirs: string[];
  opfsMountDbName: string | undefined;
  mountPoints?: RealmMountPoint[];
}) {
  if (!EphemeralPm) {
    const { ProcessManager: PM } = await import('../../kernel/process-manager.js');
    EphemeralPm = new PM();
  }
  return runInRealm({
    pm: EphemeralPm,
    realmFactory: args.realmFactory,
    owner: args.owner,
    kind: 'py',
    code: args.code,
    argv: args.argv,
    realmArgv: args.realmArgv,
    env: args.env,
    cwd: args.cwd,
    filename: args.filename,
    ctx: args.ctx,
    stdin: args.stdin,
    pyodideIndexURL: args.pyodideIndexURL,
    pyodideAssetRoot: args.pyodideAssetRoot,
    pyodideMountDirs: args.pyodideMountDirs,
    mountPoints: args.mountPoints,
    opfsMountDbName: args.opfsMountDbName,
    procKind: 'py',
  });
}
