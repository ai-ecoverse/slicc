import type { FileContent, ReadFileOptions } from '../../fs/types.js';
import { GLOBAL_NODE_MODULES } from './global-prefix.js';
import {
  type PythonBlock,
  type PythonInterpreter,
  type PythonPackage,
  pythonOf,
} from './python-packages.js';

export type WasmAbi = 'emscripten' | 'wasi';

function abiOf(raw: unknown, fallback: WasmAbi): WasmAbi | undefined {
  if (raw === undefined) return fallback;
  return raw === 'emscripten' || raw === 'wasi' ? raw : undefined;
}

const FALLBACK_SCOPE = '@ai-ecoverse/';
const FALLBACK_PREFIX = 'wasm-';

export interface WasmCommand {
  name: string;

  abi?: WasmAbi;

  glue: string;

  wasm: string;

  argv0: string;

  pkg: string;

  env?: Readonly<Record<string, string>>;
}

export interface ProgramFs {
  exists(path: string): Promise<boolean>;
  readDir(path: string): Promise<ReadonlyArray<{ name: string }>>;
  readFile(path: string, options?: ReadFileOptions): Promise<FileContent>;
}

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

interface ManifestEnvEntries {
  readonly [name: string]: unknown;
}

function manifestEnv(pkgDir: string, raw: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return env;
  for (const [key, value] of Object.entries(raw as ManifestEnvEntries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') continue;
    env[key] = value.replaceAll('${package}', pkgDir);
  }
  return env;
}

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

export function isInstalledProgramPath(path: string): boolean {
  return (
    path.startsWith(`${GLOBAL_NODE_MODULES}/`) &&
    (path.endsWith('/package.json') || path.endsWith('.wasm'))
  );
}

function insidePackage(pkgDir: string, rel: unknown): string | undefined {
  if (typeof rel !== 'string' || rel.length === 0) return undefined;
  const clean = rel.replace(/^\.\//, '');
  if (clean.startsWith('/') || clean.split('/').includes('..')) return undefined;
  return `${pkgDir}/${clean}`;
}

function validCommandName(name: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(name) && name !== '.' && name !== '..';
}

export function commandsFromManifest(pkgDir: string, pkg: PackageJson): WasmCommand[] {
  const slicc = pkg.slicc;
  if (!slicc || typeof slicc !== 'object') return [];

  const packageAbi = abiOf(slicc.abi, 'emscripten');
  if (!packageAbi) return [];
  const commands = slicc.commands;
  if (!commands || typeof commands !== 'object') return [];
  const name = typeof pkg.name === 'string' ? pkg.name : pkgDir;
  const packageEnv = manifestEnv(pkgDir, slicc.env);
  const out: WasmCommand[] = [];
  for (const [command, raw] of Object.entries(commands as Record<string, CommandEntry>)) {
    if (!validCommandName(command) || !raw || typeof raw !== 'object') continue;
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
    } catch {}
    for (const sub of scoped.sort()) dirs.push(`${modulesDir}/${name}/${sub}`);
  }
  return dirs;
}

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
