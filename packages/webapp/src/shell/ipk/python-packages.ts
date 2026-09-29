import type { ProgramFs } from './wasm-programs.js';

export interface PythonInterpreter {
  pkg: string;
  version: string;
  abi: string;
  platform: string;
}

export interface PythonPackage {
  pkg: string;

  sitePackages: string;

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

export function matches(p: PythonPackage, interp: PythonInterpreter): boolean {
  const r = p.requires;
  if (!r || r.abi === 'none') return true;

  if (r.abi === undefined && r.platform === undefined) return false;
  return (
    (r.abi === undefined || r.abi === interp.abi) &&
    (r.platform === undefined || r.platform === interp.platform)
  );
}

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

export function pthPath(home: string, version: string): string {
  return `${home.replace(/\/+$/, '')}/.local/lib/python${version}/site-packages/_slicc_packages.pth`;
}

export interface PthFs {
  readFile: ProgramFs['readFile'];
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<void>;
}

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
