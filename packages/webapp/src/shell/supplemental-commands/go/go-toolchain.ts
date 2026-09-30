import { GLOBAL_NODE_MODULES } from '../../ipk/global-prefix.js';

export interface GoToolchain {
  pkg: string;
  goroot: string;
  version: string;
}

export interface GoStdPart {
  pkg: string;
  version: string;
  target: string;
  dir: string;
}

export interface GoBlock {
  version?: unknown;
  goroot?: unknown;
  std?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function inside(pkgDir: string, rel: string | undefined): string | undefined {
  if (rel === undefined || rel.startsWith('/') || rel.split('/').includes('..')) return undefined;
  const clean = rel.replace(/^\.\/?/, '').replace(/\/+$/, '');
  return clean ? `${pkgDir}/${clean}` : pkgDir;
}

export function goOf(
  pkgDir: string,
  name: string,
  block: GoBlock | undefined
): { toolchain?: GoToolchain; std: GoStdPart[] } {
  if (!block || typeof block !== 'object') return { std: [] };
  const version = str(block.version);
  const goroot = inside(pkgDir, str(block.goroot) ?? (version ? '.' : undefined));
  const std: GoStdPart[] = [];
  for (const raw of Array.isArray(block.std) ? block.std : []) {
    const part = raw as { version?: unknown; target?: unknown; dir?: unknown };
    const v = str(part?.version) ?? version;
    const target = str(part?.target);
    const dir = inside(pkgDir, str(part?.dir));
    if (v && target && /^[a-z0-9]+\/[a-z0-9]+$/.test(target) && dir) {
      std.push({ pkg: name, version: v, target, dir });
    }
  }
  return {
    ...(version && goroot ? { toolchain: { pkg: name, goroot, version } } : {}),
    std,
  };
}

export interface ScanFs {
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  readText(path: string): Promise<string>;
}

export async function scanGo(
  fs: ScanFs,
  modulesDir = GLOBAL_NODE_MODULES
): Promise<{ toolchains: GoToolchain[]; std: GoStdPart[] }> {
  const toolchains: GoToolchain[] = [];
  const std: GoStdPart[] = [];
  if (!(await fs.exists(modulesDir))) return { toolchains, std };

  const dirs: string[] = [];
  for (const e of await fs.readdir(modulesDir)) {
    const dir = `${modulesDir}/${e.name}`;
    if (!e.name.startsWith('@')) dirs.push(dir);
    else for (const s of await fs.readdir(dir)) dirs.push(`${dir}/${s.name}`);
  }
  for (const dir of dirs.sort()) {
    let pkg: { name?: unknown; slicc?: { go?: GoBlock } };
    try {
      pkg = JSON.parse(await fs.readText(`${dir}/package.json`));
    } catch {
      continue;
    }
    const name = typeof pkg.name === 'string' ? pkg.name : dir.slice(modulesDir.length + 1);
    const found = goOf(dir, name, pkg.slicc?.go);
    if (found.toolchain) toolchains.push(found.toolchain);
    std.push(...found.std);
  }
  return { toolchains, std };
}

export function toolPath(tc: GoToolchain, name: 'compile' | 'link' | 'asm'): string {
  return `${tc.goroot}/pkg/tool/wasip1_wasm/${name}`;
}

export async function stdArchives(
  fs: ScanFs,
  parts: readonly GoStdPart[],
  version: string,
  target: string
): Promise<Map<string, string>> {
  const archives = new Map<string, string>();
  for (const part of parts) {
    if (part.version !== version || part.target !== target) continue;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const e of await fs.readdir(dir)) {
        if (e.isDir) await walk(`${dir}/${e.name}`, `${prefix}${e.name}/`);
        else if (e.name.endsWith('.a')) {
          const path = `${prefix}${e.name.slice(0, -2)}`;
          if (!archives.has(path)) archives.set(path, `${dir}/${e.name}`);
        }
      }
    };
    if (await fs.exists(part.dir)) await walk(part.dir, '');
  }
  return archives;
}
