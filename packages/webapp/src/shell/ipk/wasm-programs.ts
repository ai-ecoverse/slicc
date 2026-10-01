/**
 * `wasm-programs.ts` — which installed packages provide wasm-realm commands
 * (#3530). Programs come from `ipk`-installed packages, never a host mount.
 *
 * A package declares its commands in `package.json`:
 *
 *   "slicc": {
 *     "abi": "emscripten",
 *     "commands": {
 *       "pkg-config": { "glue": "bin/pkgconf", "wasm": "bin/pkgconf.wasm" },
 *       "ls": { "glue": "bin/coreutils", "wasm": "bin/coreutils.wasm", "argv0": "ls" }
 *     }
 *   }
 *
 * A WASI preview1 program (Zig, Go, Rust, wasi-libc C) has no glue:
 * `"abi": "wasi"`, on `slicc` or per command (which wins), and a command
 * names only its `wasm`:
 *
 *   "slicc": { "abi": "wasi", "commands": { "rg": { "wasm": "bin/rg.wasm" } } }
 *
 * A command can also be a `#!` script of the package, run by its interpreter
 * as execve(2) would (a compiler driver: `#!/bin/sh`, which is GNU bash):
 *
 *   "slicc": { "commands": { "cc": { "script": "bin/cc" } } }
 *
 * `argv0` selects the program of a multi-call binary (default: the command
 * name). `env` (on `slicc`, and per command, which wins) gives the program
 * environment defaults — the caller's environment still wins. A value that
 * is a relative path (`etc/ImageMagick-7`) names a place in the package, and
 * `${package}` stands for the package directory; `${NAME}` is the caller's
 * `NAME` when the program starts (`${HOME}/.cache/zig`), and a default naming
 * an unset one is left out; anything else is literal. Until the `@ai-ecoverse/wasm-*` packages carry the manifest, such a
 * package without one offers each `bin/<x>` that has a `bin/<x>.wasm` beside it.
 */

import type { FileContent, ReadFileOptions } from '../../fs/types.js';
import { GLOBAL_NODE_MODULES } from './global-prefix.js';
import {
  type PythonBlock,
  type PythonInterpreter,
  type PythonPackage,
  pythonOf,
} from './python-packages.js';

/** The ABIs the wasm realm runs: Emscripten glue + module, or a WASI preview1 module. */
export type WasmAbi = 'emscripten' | 'wasi';

function abiOf(raw: unknown, fallback: WasmAbi): WasmAbi | undefined {
  if (raw === undefined) return fallback;
  return raw === 'emscripten' || raw === 'wasi' ? raw : undefined;
}

/** Packages whose `bin/` pairs count as commands even without a manifest. */
const FALLBACK_SCOPE = '@ai-ecoverse/';
const FALLBACK_PREFIX = 'wasm-';

export interface WasmCommand {
  /** The command name (what a shell or a spawn looks up). */
  name: string;
  /** How the program talks to the kernel (absent: Emscripten). */
  abi?: WasmAbi;
  /** Absolute path of the Emscripten glue; a WASI program's is its module (it has none). */
  glue: string;
  /** Absolute path of the module. */
  wasm: string;
  /** `argv[0]` the program runs with. */
  argv0: string;
  /** The package that provides it. */
  pkg: string;
  /** Environment defaults for the program (the manifest's `env`, resolved). */
  env?: Readonly<Record<string, string>>;
  /**
   * A script command: the `#!` script its interpreter runs (then `glue` and
   * `wasm` are this path too — it is no wasm program itself).
   */
  script?: string;
}

/** The filesystem surface the scan needs (a `VirtualFS` or `RestrictedFS`). */
export interface ProgramFs {
  exists(path: string): Promise<boolean>;
  readDir(path: string): Promise<ReadonlyArray<{ name: string }>>;
  readFile(path: string, options?: ReadFileOptions): Promise<FileContent>;
}

/** True when `fs` can serve a scan (discovery filesystems may be narrower). */
export function isProgramFs(fs: unknown): fs is ProgramFs {
  const candidate = fs as Partial<ProgramFs> | null;
  return (
    typeof candidate?.exists === 'function' &&
    typeof candidate.readDir === 'function' &&
    typeof candidate.readFile === 'function'
  );
}

async function list(fs: ProgramFs, path: string): Promise<string[]> {
  return (await fs.readDir(path)).map((entry) => entry.name);
}

async function readText(fs: ProgramFs, path: string): Promise<string> {
  const raw = await fs.readFile(path, { encoding: 'utf-8' });
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

interface CommandEntry {
  script?: unknown;
  abi?: unknown;
  glue?: unknown;
  wasm?: unknown;
  argv0?: unknown;
  env?: unknown;
}

interface PackageJson {
  name?: unknown;
  slicc?: { abi?: unknown; commands?: unknown; env?: unknown; python?: PythonBlock };
}

/** A manifest `env` object as read: names to (hopefully string) values. */
interface ManifestEnvEntries {
  readonly [name: string]: unknown;
}

/**
 * A manifest's `env`: valid names with string values, `${package}` expanded.
 * Relative paths resolve later, against what the package holds
 * ({@link withPackagePaths}).
 */
function manifestEnv(pkgDir: string, raw: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return env;
  for (const [key, value] of Object.entries(raw as ManifestEnvEntries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') continue;
    env[key] = value.replaceAll('${package}', pkgDir);
  }
  return env;
}

/**
 * A command's env with each relative value that names something in its
 * package (`etc/ImageMagick-7`) made that absolute path. Any other value, a
 * `TZ=America/New_York` or a URL, is literal.
 */
async function withPackagePaths(
  fs: ProgramFs,
  pkgDir: string,
  command: WasmCommand
): Promise<WasmCommand> {
  if (!command.env) return command;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(command.env)) {
    const path = !value.startsWith('/') && value.includes('/') && insidePackage(pkgDir, value);
    env[key] = path && (await fs.exists(path)) ? path : value;
  }
  return { ...command, env };
}

/** True for a write that can change the installed command set (a manifest or a module). */
export function isInstalledProgramPath(path: string): boolean {
  return (
    path.startsWith(`${GLOBAL_NODE_MODULES}/`) &&
    (path.endsWith('/package.json') || path.endsWith('.wasm'))
  );
}

/** A package-relative path that stays inside the package. */
function insidePackage(pkgDir: string, rel: unknown): string | undefined {
  if (typeof rel !== 'string' || rel.length === 0) return undefined;
  const clean = rel.replace(/^\.\//, '');
  if (clean.startsWith('/') || clean.split('/').includes('..')) return undefined;
  return `${pkgDir}/${clean}`;
}

function validCommandName(name: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(name) && name !== '.' && name !== '..';
}

/** The commands a package's manifest declares (empty when it declares none it can run). */
export function commandsFromManifest(pkgDir: string, pkg: PackageJson): WasmCommand[] {
  const slicc = pkg.slicc;
  if (!slicc || typeof slicc !== 'object') return [];
  // An ABI the realm cannot run (a newer package): none of its commands.
  const packageAbi = abiOf(slicc.abi, 'emscripten');
  if (!packageAbi) return [];
  const commands = slicc.commands;
  if (!commands || typeof commands !== 'object') return [];
  const name = typeof pkg.name === 'string' ? pkg.name : pkgDir;
  const packageEnv = manifestEnv(pkgDir, slicc.env);
  const out: WasmCommand[] = [];
  for (const [command, raw] of Object.entries(commands as Record<string, CommandEntry>)) {
    if (!validCommandName(command) || !raw || typeof raw !== 'object') continue;
    const script = insidePackage(pkgDir, raw.script);
    if (script) {
      const env = { ...packageEnv, ...manifestEnv(pkgDir, raw.env) };
      out.push({
        name: command,
        glue: script,
        wasm: script,
        argv0: command,
        pkg: name,
        script,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      });
      continue;
    }
    const abi = abiOf(raw.abi, packageAbi);
    const wasm = insidePackage(pkgDir, raw.wasm);
    const glue = abi === 'wasi' ? wasm : insidePackage(pkgDir, raw.glue);
    if (!abi || !glue || !wasm) continue;
    const argv0 = typeof raw.argv0 === 'string' && raw.argv0 ? raw.argv0 : command;
    const env = { ...packageEnv, ...manifestEnv(pkgDir, raw.env) };
    out.push({
      name: command,
      abi,
      glue,
      wasm,
      argv0,
      pkg: name,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
  }
  return out;
}

async function fallbackCommands(
  fs: ProgramFs,
  pkgDir: string,
  pkg: string
): Promise<WasmCommand[]> {
  const bin = `${pkgDir}/bin`;
  let names: string[];
  try {
    names = await list(fs, bin);
  } catch {
    return [];
  }
  const present = new Set(names);
  return names
    .filter((n) => !n.endsWith('.wasm') && present.has(`${n}.wasm`) && validCommandName(n))
    .map((n) => ({
      name: n,
      abi: 'emscripten' as const,
      glue: `${bin}/${n}`,
      wasm: `${bin}/${n}.wasm`,
      argv0: n,
      pkg,
    }));
}

async function packageCommands(fs: ProgramFs, pkgDir: string): Promise<WasmCommand[]> {
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readText(fs, `${pkgDir}/package.json`)) as PackageJson;
  } catch {
    return [];
  }
  const declared = commandsFromManifest(pkgDir, pkg);
  if (declared.length > 0 || pkg.slicc) {
    return Promise.all(declared.map((command) => withPackagePaths(fs, pkgDir, command)));
  }
  const name = typeof pkg.name === 'string' ? pkg.name : '';
  if (
    name.startsWith(FALLBACK_SCOPE) &&
    name.slice(FALLBACK_SCOPE.length).startsWith(FALLBACK_PREFIX)
  ) {
    return fallbackCommands(fs, pkgDir, name);
  }
  return [];
}

async function packageDirs(fs: ProgramFs, modulesDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await list(fs, modulesDir);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    if (!name.startsWith('@')) {
      dirs.push(`${modulesDir}/${name}`);
      continue;
    }
    let scoped: string[] = [];
    try {
      scoped = await list(fs, `${modulesDir}/${name}`);
    } catch {
      /* unreadable scope */
    }
    for (const sub of scoped.sort()) dirs.push(`${modulesDir}/${name}/${sub}`);
  }
  return dirs;
}

/**
 * Every wasm command the packages under `modulesDir` provide, by name. When
 * two packages claim a name, the first in package order keeps it.
 */
export async function scanWasmCommands(
  fs: ProgramFs,
  modulesDir: string
): Promise<Map<string, WasmCommand>> {
  const out = new Map<string, WasmCommand>();
  if (!(await fs.exists(modulesDir))) return out;
  for (const pkgDir of await packageDirs(fs, modulesDir)) {
    for (const command of await packageCommands(fs, pkgDir)) {
      if (!out.has(command.name)) out.set(command.name, command);
    }
  }
  return out;
}

/**
 * The Python interpreters (by package name) and the Python packages the
 * packages under `modulesDir` provide (their manifests' `slicc.python`).
 */
export async function scanPythonPackages(
  fs: ProgramFs,
  modulesDir: string
): Promise<{ interpreters: Map<string, PythonInterpreter>; packages: PythonPackage[] }> {
  const interpreters = new Map<string, PythonInterpreter>();
  const packages: PythonPackage[] = [];
  if (!(await fs.exists(modulesDir))) return { interpreters, packages };
  for (const pkgDir of await packageDirs(fs, modulesDir)) {
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(await readText(fs, `${pkgDir}/package.json`)) as PackageJson;
    } catch {
      continue;
    }
    const name = typeof pkg.name === 'string' ? pkg.name : pkgDir.slice(modulesDir.length + 1);
    const found = pythonOf(pkgDir, name, pkg.slicc?.python);
    if (found.interpreter) interpreters.set(name, found.interpreter);
    if (found.package) packages.push(found.package);
  }
  return { interpreters, packages };
}
