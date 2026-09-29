/**
 * `python-packages.ts` — how ipk-installed Python packages reach an
 * ipk-installed interpreter (native CPython for WASIX; `docs/shell-reference.md`,
 * "Native Python next to Pyodide").
 *
 * The interpreter's package says what it is:
 *
 *   "slicc": { "python": { "version": "3.14", "abi": "cp314", "platform": "wasix_wasm32",
 *                          "sitePackages": "lib/python3.14/site-packages" } }
 *
 * and a package with Python code says where it is, and — for C extensions —
 * which interpreter it was built for:
 *
 *   "slicc": { "python": { "sitePackages": "lib/python3.14/site-packages",
 *                          "requires": { "abi": "cp314", "platform": "wasix_wasm32" } } }
 *
 * When SLICC starts the interpreter it writes
 * `$HOME/.local/lib/python<version>/site-packages/_slicc_packages.pth`: one
 * `site.addsitedir(...)` per matching package (so their own `.pth` files and
 * namespace packages work), rewritten only when it changed. The user site is
 * also where `pip install --user` puts pure-Python packages.
 */
import type { ProgramFs } from './wasm-programs.js';

export interface PythonInterpreter {
  /** The package that provides it. */
  pkg: string;
  version: string;
  abi: string;
  platform: string;
}

export interface PythonPackage {
  pkg: string;
  /** Absolute path of its site-packages directory. */
  sitePackages: string;
  /** The interpreter its C extensions need; absent: pure Python. */
  requires?: { abi?: string; platform?: string };
}

export interface PythonBlock {
  version?: unknown;
  abi?: unknown;
  platform?: unknown;
  sitePackages?: unknown;
  requires?: { abi?: unknown; platform?: unknown };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The `python` block of one package's manifest: an interpreter, a package, or nothing. */
export function pythonOf(
  pkgDir: string,
  name: string,
  block: PythonBlock | undefined
): { interpreter?: PythonInterpreter; package?: PythonPackage } {
  if (!block || typeof block !== 'object') return {};
  const out: { interpreter?: PythonInterpreter; package?: PythonPackage } = {};
  const version = str(block.version);
  const abi = str(block.abi);
  const platform = str(block.platform);
  if (version && abi && platform) out.interpreter = { pkg: name, version, abi, platform };
  const site = str(block.sitePackages);
  if (site && !site.startsWith('/') && !site.split('/').includes('..')) {
    const requires =
      block.requires && typeof block.requires === 'object' ? block.requires : undefined;
    out.package = {
      pkg: name,
      sitePackages: `${pkgDir}/${site.replace(/\/+$/, '')}`,
      ...(requires
        ? {
            requires: {
              ...(str(requires.abi) ? { abi: str(requires.abi) } : {}),
              ...(str(requires.platform) ? { platform: str(requires.platform) } : {}),
            },
          }
        : {}),
    };
  }
  return out;
}

/** Whether `p` runs with `interp`: pure Python always; C extensions for its ABI and platform. */
export function matches(p: PythonPackage, interp: PythonInterpreter): boolean {
  const r = p.requires;
  if (!r || r.abi === 'none') return true;
  // It has C extensions, but says for nothing: no interpreter can load them.
  if (r.abi === undefined && r.platform === undefined) return false;
  return (
    (r.abi === undefined || r.abi === interp.abi) &&
    (r.platform === undefined || r.platform === interp.platform)
  );
}

/** The `.pth` for `interp`: its own site-packages, then every matching package's; and those that do not match. */
export function pthFor(
  interp: PythonInterpreter,
  packages: readonly PythonPackage[]
): { text: string; skipped: PythonPackage[] } {
  const lines = [
    '# Written by SLICC at each start of the interpreter: the ipk-installed Python packages.',
  ];
  const skipped: PythonPackage[] = [];
  for (const p of packages) {
    if (!matches(p, interp)) {
      skipped.push(p);
      continue;
    }
    lines.push(`import site; site.addsitedir(${JSON.stringify(p.sitePackages)})`);
  }
  return { text: `${lines.join('\n')}\n`, skipped };
}

/** Where the `.pth` goes: the user site of `HOME` for `version`. */
export function pthPath(home: string, version: string): string {
  return `${home.replace(/\/+$/, '')}/.local/lib/python${version}/site-packages/_slicc_packages.pth`;
}

/** What writing the `.pth` needs of a filesystem (the shell's). */
export interface PthFs {
  readFile: ProgramFs['readFile'];
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<void>;
}

/**
 * Write the `.pth` for `interp` when it changed; the packages left out (built
 * for another interpreter), for a word on stderr.
 */
export async function ensurePth(
  fs: PthFs,
  home: string,
  interp: PythonInterpreter,
  packages: readonly PythonPackage[]
): Promise<PythonPackage[]> {
  const { text, skipped } = pthFor(interp, packages);
  const path = pthPath(home, interp.version);
  let current: string | undefined;
  try {
    const raw = await fs.readFile(path, { encoding: 'utf-8' });
    current = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    current = undefined;
  }
  if (current !== text) {
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(path, text);
  }
  return skipped;
}
