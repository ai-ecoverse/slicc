/**
 * `ipx` (Ice Pick) command — run an installed package's bin through the jsh
 * runtime (architecture 4.2). Bin resolution walks up from the cwd:
 *   1. the nearest `node_modules/.bin/<name>` shim (parsed for its require
 *      target), then
 *   2. the package's `package.json` `bin` field — string bin (keyed off the
 *      unscoped package name), map bin, and the package-name fallback.
 *
 * The resolved bin file is executed via `executeJsCode` so it shares the
 * rewired require / ESM loader and the `node:` / `sliccy:` schemes (both CJS
 * and ESM bins). argv and stdin are forwarded verbatim — the bin-name token
 * becomes `process.argv[1]` (so a one-file map-bin can distinguish which name
 * it was invoked as, like cowsay/cowthink), nothing is injected or dropped —
 * exit codes propagate, and stdout/stderr stay separate.
 *
 * npx-like auto-install: when the requested name resolves to no bin AND the
 * package is not already present in node_modules, ipx installs it first (full
 * transitive tree materialized) and then runs it. An already-installed package
 * runs WITHOUT reinstalling. `npx` is registered as an alias of `ipx`.
 */

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
  /** Absolute VFS path of the bin file to execute. */
  binFilePath: string;
  /** Path whose basename is the invoked bin name (becomes `process.argv[1]`). */
  argvName: string;
}

const SHIM_REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/;

function usage(name: string): string {
  return `${name} - run an installed package's executable bin

Usage:
  ${name} [--force] <pkg-or-bin> [args...]

Resolves <pkg-or-bin> to a bin (nearest node_modules/.bin/<name>, else the
package's package.json "bin" field) and runs it through the JS runtime,
forwarding argv and stdin. Exit codes propagate.

Options:
  --force      Install a package even when a SLICC built-in shadows it
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

/** Yield each `<dir>/node_modules` from `cwd` up to the filesystem root, then global. */
function* nodeModulesDirs(cwd: string): Generator<string> {
  let dir = normalizePath(cwd);
  while (true) {
    yield joinPath(dir, 'node_modules');
    if (dir === '/') break;
    dir = splitPath(dir).dir;
  }
  yield GLOBAL_NODE_MODULES;
}

/** Resolve a `node_modules/.bin/<name>` shim to its real bin file, if present. */
async function resolveFromBinShim(
  fs: VirtualFS,
  cwd: string,
  name: string
): Promise<ResolvedBin | null> {
  for (const modulesDir of nodeModulesDirs(cwd)) {
    const shimPath = joinPath(modulesDir, '.bin', name);
    if (!(await isFile(fs, shimPath))) continue;
    const shim = await readText(fs, shimPath);
    const match = SHIM_REQUIRE_RE.exec(shim);
    const binDir = splitPath(shimPath).dir;
    // Our shims are `require("<rel>")` relative to the .bin dir; resolve that
    // target. A shim that doesn't match the expected shape is run as-is.
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

/** Pick the bin entry to run for a package invoked by name. */
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

/** Resolve a package's `bin` field (the "else package bin" fallback). */
async function resolveFromPackageBin(
  fs: VirtualFS,
  cwd: string,
  name: string
): Promise<ResolvedBin | null> {
  for (const modulesDir of nodeModulesDirs(cwd)) {
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

async function resolveBin(fs: VirtualFS, cwd: string, name: string): Promise<ResolvedBin | null> {
  return (await resolveFromBinShim(fs, cwd, name)) ?? (await resolveFromPackageBin(fs, cwd, name));
}

/** Whether a package named `name` is already present in a reachable node_modules. */
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

/**
 * npx-like auto-install of the requested package (full transitive tree).
 * Returns the human-readable install progress to surface on stderr, or an
 * error result if the install failed.
 */
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

/** Validate that a resolved bin path points at a runnable file. */
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
    // Like `node`, ipx drives a worker realm whose cross-thread RPC needs
    // unpatched async I/O; without `trusted` the host await settles early and
    // a failing bin's non-zero exit is reported to the shell as 0.
    trusted: true,
    async execute(args: string[], ctx: CommandContext) {
      if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        return { stdout: usage(name), stderr: '', exitCode: args.length === 0 ? 1 : 0 };
      }

      const forceInstall = args[0] === '--force';
      const invocationArgs = forceInstall ? args.slice(1) : args;
      if (invocationArgs.length === 0) {
        return { stdout: usage(name), stderr: '', exitCode: 1 };
      }
      const binName = invocationArgs[0];
      const binArgs = invocationArgs.slice(1);

      let resolved: ResolvedBin | null;
      try {
        resolved = await resolveBin(deps.fs, ctx.cwd, binName);
      } catch (err) {
        return failure(name, describeError(err));
      }

      // npx-like auto-install: an already-installed package runs as-is (no
      // reinstall); an absent one is installed (full transitive tree) first.
      let installProgress = '';
      if (!resolved) {
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
