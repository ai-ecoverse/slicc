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
 * `argv0` selects the program of a multi-call binary (default: the command
 * name). Until the `@ai-ecoverse/wasm-*` packages carry the manifest, such a
 * package without one offers each `bin/<x>` that has a `bin/<x>.wasm` beside it.
 */

import type { FileContent, ReadFileOptions } from '../../fs/types.js';
import { GLOBAL_NODE_MODULES } from './global-prefix.js';

/** The ABIs the wasm realm runs today. */
const SUPPORTED_ABI = 'emscripten';

/** Packages whose `bin/` pairs count as commands even without a manifest. */
const FALLBACK_SCOPE = '@ai-ecoverse/';
const FALLBACK_PREFIX = 'wasm-';

export interface WasmCommand {
  /** The command name (what a shell or a spawn looks up). */
  name: string;
  /** Absolute path of the Emscripten glue. */
  glue: string;
  /** Absolute path of the module. */
  wasm: string;
  /** `argv[0]` the program runs with. */
  argv0: string;
  /** The package that provides it. */
  pkg: string;
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
  glue?: unknown;
  wasm?: unknown;
  argv0?: unknown;
}

interface PackageJson {
  name?: unknown;
  slicc?: { abi?: unknown; commands?: unknown };
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
  if (slicc.abi !== undefined && slicc.abi !== SUPPORTED_ABI) return [];
  const commands = slicc.commands;
  if (!commands || typeof commands !== 'object') return [];
  const name = typeof pkg.name === 'string' ? pkg.name : pkgDir;
  const out: WasmCommand[] = [];
  for (const [command, raw] of Object.entries(commands as Record<string, CommandEntry>)) {
    if (!validCommandName(command) || !raw || typeof raw !== 'object') continue;
    const glue = insidePackage(pkgDir, raw.glue);
    const wasm = insidePackage(pkgDir, raw.wasm);
    if (!glue || !wasm) continue;
    const argv0 = typeof raw.argv0 === 'string' && raw.argv0 ? raw.argv0 : command;
    out.push({ name: command, glue, wasm, argv0, pkg: name });
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
    .map((n) => ({ name: n, glue: `${bin}/${n}`, wasm: `${bin}/${n}.wasm`, argv0: n, pkg }));
}

async function packageCommands(fs: ProgramFs, pkgDir: string): Promise<WasmCommand[]> {
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readText(fs, `${pkgDir}/package.json`)) as PackageJson;
  } catch {
    return [];
  }
  const declared = commandsFromManifest(pkgDir, pkg);
  if (declared.length > 0 || pkg.slicc) return declared;
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
