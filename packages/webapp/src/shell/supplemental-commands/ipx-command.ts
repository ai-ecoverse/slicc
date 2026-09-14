import type { Command, CommandContext, ExecResult, SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { joinPath, normalizePath, splitPath } from '../../fs/path-utils.js';
import { GLOBAL_NODE_MODULES } from '../ipk/global-prefix.js';
import { installPackages } from '../ipk/installer.js';
import { executeJsCode } from '../jsh-executor.js';
import { stripShebang } from '../strip-shebang.js';
import { formatBuiltinShadowHint, lookupBuiltinShadow } from './builtin-shadow-map.js';

export interface IpxCommandDeps {
  fs: VirtualFS;
  fetch: SecureFetch;
}

interface ResolvedBin {
  binFilePath: string;

  argvName: string;
}

const SHIM_REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/;

function usage(name: string): string {
  return `${name} - run an installed package's executable bin

Usage:
  ${name} [--force] [--global] <pkg-or-bin> [args...]

Resolves <pkg-or-bin> to a bin (nearest node_modules/.bin/<name>, else the
package's package.json "bin" field) and runs it through the JS runtime,
forwarding argv and stdin. Exit codes propagate.

Options:
  --force      Install a package even when a SLICC built-in shadows it
  --global     Resolve only from the shared global prefix (/shared/lib/node_modules)
  -h, --help   Show this help message
`;
}

async function readText(fs: VirtualFS, path: string): Promise<string> {
  const content = await fs.readFile(path);
  return typeof content === 'string' ? content : new TextDecoder().decode(content as Uint8Array);
}

async function isFile(fs: VirtualFS, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).type === 'file';
  } catch {
    return false;
  }
}

async function isDirectory(fs: VirtualFS, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).type === 'directory';
  } catch {
    return false;
  }
}

function* nodeModulesDirs(cwd: string, globalOnly = false): Generator<string> {
  if (globalOnly) {
    yield GLOBAL_NODE_MODULES;
    return;
  }
  let dir = normalizePath(cwd);
  while (true) {
    yield joinPath(dir, 'node_modules');
    if (dir === '/') break;
    dir = splitPath(dir).dir;
  }
  yield GLOBAL_NODE_MODULES;
}

async function resolveFromBinShim(
  fs: VirtualFS,
  cwd: string,
  name: string,
  globalOnly = false
): Promise<ResolvedBin | null> {
  for (const modulesDir of nodeModulesDirs(cwd, globalOnly)) {
    const shimPath = joinPath(modulesDir, '.bin', name);
    if (!(await isFile(fs, shimPath))) continue;
    const shim = await readText(fs, shimPath);
    const match = SHIM_REQUIRE_RE.exec(shim);
    const binDir = splitPath(shimPath).dir;

    const binFilePath = match ? joinPath(binDir, match[1]) : shimPath;
    return { binFilePath, argvName: shimPath };
  }
  return null;
}

function unscopedName(pkgName: string): string {
  if (pkgName.startsWith('@')) {
    const slash = pkgName.indexOf('/');
    if (slash !== -1) return pkgName.slice(slash + 1);
  }
  return pkgName;
}

function pickPackageBin(
  bin: unknown,
  pkgName: string
): { binName: string; binPath: string } | null {
  if (typeof bin === 'string') {
    return { binName: unscopedName(pkgName), binPath: bin };
  }
  if (bin === null || typeof bin !== 'object') return null;
  const candidates = [pkgName, unscopedName(pkgName)];
  for (const key of candidates) {
    const value = Object.getOwnPropertyDescriptor(bin, key)?.value;
    if (typeof value === 'string') return { binName: key, binPath: value };
  }
  const stringEntries = Object.entries(bin as object).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  if (stringEntries.length === 1) {
    const [binName, binPath] = stringEntries[0];
    return { binName, binPath };
  }
  return null;
}

async function resolveFromPackageBin(
  fs: VirtualFS,
  cwd: string,
  name: string,
  globalOnly = false
): Promise<ResolvedBin | null> {
  for (const modulesDir of nodeModulesDirs(cwd, globalOnly)) {
    const pkgDir = joinPath(modulesDir, name);
    const manifestPath = joinPath(pkgDir, 'package.json');
    if (!(await isFile(fs, manifestPath))) continue;
    let manifest: { bin?: unknown };
    try {
      manifest = JSON.parse(await readText(fs, manifestPath)) as { bin?: unknown };
    } catch {
      return null;
    }
    const picked = pickPackageBin(manifest.bin, name);
    if (!picked) return null;
    const normalizedBinPath = picked.binPath.replace(/^\.\//, '');
    return {
      binFilePath: joinPath(pkgDir, normalizedBinPath),
      argvName: joinPath(modulesDir, '.bin', picked.binName),
    };
  }
  return null;
}

async function resolveBin(
  fs: VirtualFS,
  cwd: string,
  name: string,
  globalOnly = false
): Promise<ResolvedBin | null> {
  return (
    (await resolveFromBinShim(fs, cwd, name, globalOnly)) ??
    (await resolveFromPackageBin(fs, cwd, name, globalOnly))
  );
}

async function isPackageInstalled(fs: VirtualFS, cwd: string, name: string): Promise<boolean> {
  for (const modulesDir of nodeModulesDirs(cwd)) {
    if (await isFile(fs, joinPath(modulesDir, name, 'package.json'))) return true;
  }
  return false;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(name: string, message: string): ExecResult {
  return { stdout: '', stderr: `${name}: ${message}\n`, exitCode: 1 };
}

async function autoInstall(
  name: string,
  binName: string,
  ctx: CommandContext,
  deps: IpxCommandDeps
): Promise<{ progress: string } | { error: ExecResult }> {
  try {
    const outcome = await installPackages([binName], {
      fs: deps.fs,
      fetch: deps.fetch,
      cwd: ctx.cwd,
    });
    if (outcome.errors.length > 0) {
      return {
        error: failure(
          name,
          `failed to install '${binName}': ${describeError(outcome.errors[0].error)}`
        ),
      };
    }
    const lines = outcome.results.map((r) => `${name}: installed ${r.name}@${r.version}`);
    return { progress: lines.length > 0 ? `${lines.join('\n')}\n` : '' };
  } catch (err) {
    return { error: failure(name, `failed to install '${binName}': ${describeError(err)}`) };
  }
}

async function validateBinFile(
  name: string,
  binName: string,
  binFilePath: string,
  fs: VirtualFS
): Promise<ExecResult | null> {
  if (await isFile(fs, binFilePath)) return null;
  if (await isDirectory(fs, binFilePath)) {
    return failure(name, `bin target '${binFilePath}' is a directory, not a file`);
  }
  return failure(name, `bin file '${binFilePath}' for '${binName}' does not exist`);
}

async function resolveMissingBin(
  name: string,
  binName: string,
  binArgs: string[],
  forceInstall: boolean,
  ctx: CommandContext,
  deps: IpxCommandDeps
): Promise<{ resolved: ResolvedBin; installProgress: string } | { error: ExecResult }> {
  if (await isPackageInstalled(deps.fs, ctx.cwd, binName)) {
    return { error: failure(name, `package '${binName}' does not expose an executable bin`) };
  }

  const shadow = forceInstall ? undefined : lookupBuiltinShadow(binName);
  if (shadow) {
    return {
      error: {
        stdout: '',
        stderr: formatBuiltinShadowHint(name, binName, binArgs, shadow),
        exitCode: 1,
      },
    };
  }

  const installed = await autoInstall(name, binName, ctx, deps);
  if ('error' in installed) return installed;
  const resolved = await resolveBin(deps.fs, ctx.cwd, binName);
  if (!resolved) {
    return {
      error: failure(
        name,
        `package '${binName}' was installed but does not expose an executable bin`
      ),
    };
  }
  return { resolved, installProgress: installed.progress };
}

export function createIpxCommand(name: string, deps: IpxCommandDeps): Command {
  return {
    name,

    trusted: true,
    async execute(args: string[], ctx: CommandContext) {
      if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        return { stdout: usage(name), stderr: '', exitCode: args.length === 0 ? 1 : 0 };
      }

      const forceInstall = args[0] === '--force';
      let rest = forceInstall ? args.slice(1) : args;
      const globalOnly = rest[0] === '--global';
      if (globalOnly) rest = rest.slice(1);
      const invocationArgs = rest;
      if (invocationArgs.length === 0) {
        return { stdout: usage(name), stderr: '', exitCode: 1 };
      }
      const binName = invocationArgs[0];
      const binArgs = invocationArgs.slice(1);

      let resolved: ResolvedBin | null;
      try {
        resolved = await resolveBin(deps.fs, ctx.cwd, binName, globalOnly);
      } catch (err) {
        return failure(name, describeError(err));
      }

      let installProgress = '';
      if (!resolved) {
        if (globalOnly) {
          return failure(name, `no global bin '${binName}' found in ${GLOBAL_NODE_MODULES}`);
        }
        const prepared = await resolveMissingBin(name, binName, binArgs, forceInstall, ctx, deps);
        if ('error' in prepared) return prepared.error;
        resolved = prepared.resolved;
        installProgress = prepared.installProgress;
      }

      const invalid = await validateBinFile(name, binName, resolved.binFilePath, deps.fs);
      if (invalid) return invalid;

      const source = stripShebang(await readText(deps.fs, resolved.binFilePath));
      const argv = ['node', resolved.argvName, ...binArgs];
      const result = await executeJsCode(source, argv, ctx, undefined, {
        filename: resolved.binFilePath,
      });
      return {
        stdout: result.stdout,
        stderr: installProgress + result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}
