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
 * The `npx` alias and npx-style auto-install land in the next feature.
 */

import type { Command, CommandContext, SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { joinPath, normalizePath, splitPath } from '../../fs/path-utils.js';
import { executeJsCode } from '../jsh-executor.js';

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
  ${name} <pkg-or-bin> [args...]

Resolves <pkg-or-bin> to a bin (nearest node_modules/.bin/<name>, else the
package's package.json "bin" field) and runs it through the JS runtime,
forwarding argv and stdin. Exit codes propagate.

Options:
  -h, --help   Show this help message
`;
}

function stripShebang(source: string): string {
  if (!source.startsWith('#!')) return source;
  const newline = source.indexOf('\n');
  return newline === -1 ? '' : source.slice(newline + 1);
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

/** Yield each `<dir>/node_modules` from `cwd` up to the filesystem root. */
function* nodeModulesDirs(cwd: string): Generator<string> {
  let dir = normalizePath(cwd);
  while (true) {
    yield joinPath(dir, 'node_modules');
    if (dir === '/') break;
    dir = splitPath(dir).dir;
  }
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
  const map = bin as Record<string, unknown>;
  const candidates = [pkgName, unscopedName(pkgName)];
  for (const key of candidates) {
    if (typeof map[key] === 'string') return { binName: key, binPath: map[key] as string };
  }
  const entries = Object.entries(map).filter(([, v]) => typeof v === 'string');
  if (entries.length === 1) {
    const [binName, binPath] = entries[0] as [string, string];
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

      const binName = args[0];
      const binArgs = args.slice(1);

      let resolved: ResolvedBin | null;
      try {
        resolved = await resolveBin(deps.fs, ctx.cwd, binName);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { stdout: '', stderr: `${name}: ${reason}\n`, exitCode: 1 };
      }

      if (!resolved) {
        return {
          stdout: '',
          stderr: `${name}: could not determine an executable named '${binName}' (run: ipk install ${binName})\n`,
          exitCode: 1,
        };
      }

      if (!(await isFile(deps.fs, resolved.binFilePath))) {
        if (await isDirectory(deps.fs, resolved.binFilePath)) {
          return {
            stdout: '',
            stderr: `${name}: bin target '${resolved.binFilePath}' is a directory, not a file\n`,
            exitCode: 1,
          };
        }
        return {
          stdout: '',
          stderr: `${name}: bin file '${resolved.binFilePath}' for '${binName}' does not exist\n`,
          exitCode: 1,
        };
      }

      const source = stripShebang(await readText(deps.fs, resolved.binFilePath));
      const argv = ['node', resolved.argvName, ...binArgs];
      const result = await executeJsCode(source, argv, ctx, undefined, {
        filename: resolved.binFilePath,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  };
}
