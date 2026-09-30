/**
 * `go-toolchain.ts` — the Go toolchains and standard libraries installed
 * packages provide (#3530 phase 5e), as their manifests declare them
 * (`slicc.go`; the contract is in `docs/shell-reference.md`, "Go"):
 *
 *   "slicc": { "go": { "version": "go1.26.5", "goroot": "goroot",
 *                      "std": [{ "version": "go1.26.5", "target": "wasip1/wasm",
 *                                "dir": "goroot/pkg/wasip1_wasm" }] } }
 *
 * A toolchain is a GOROOT whose `pkg/tool/wasip1_wasm/` holds `compile`,
 * `link` and `asm` as WASI programs. A standard library is a directory of
 * archives, `<import path>.a`, for one target and one Go version; several
 * packages may each hold part of one (the driver takes them all).
 */
import { GLOBAL_NODE_MODULES } from '../../ipk/global-prefix.js';

/** A toolchain: its GOROOT (absolute) and Go version. */
export interface GoToolchain {
  pkg: string;
  goroot: string;
  version: string;
}

/** Part of a standard library: archives for `target` (`GOOS/GOARCH`) built by `version`. */
export interface GoStdPart {
  pkg: string;
  version: string;
  target: string;
  dir: string;
}

/** A manifest's `slicc.go`, as read. */
export interface GoBlock {
  version?: unknown;
  goroot?: unknown;
  std?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A relative path inside the package, or undefined when it would leave it. */
function inside(pkgDir: string, rel: string | undefined): string | undefined {
  if (rel === undefined || rel.startsWith('/') || rel.split('/').includes('..')) return undefined;
  const clean = rel.replace(/^\.\/?/, '').replace(/\/+$/, '');
  return clean ? `${pkgDir}/${clean}` : pkgDir;
}

/** The toolchain and standard-library parts one package's `slicc.go` declares. */
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

/** What the scan reads: the shell's filesystem. */
export interface ScanFs {
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  readText(path: string): Promise<string>;
}

/** The toolchains and std parts every installed package declares. */
export async function scanGo(
  fs: ScanFs,
  modulesDir = GLOBAL_NODE_MODULES
): Promise<{ toolchains: GoToolchain[]; std: GoStdPart[] }> {
  const toolchains: GoToolchain[] = [];
  const std: GoStdPart[] = [];
  if (!(await fs.exists(modulesDir))) return { toolchains, std };
  // Any entry: a package linked in (`ln -s`) is a symlink, not a directory.
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

/** Where a toolchain's tool is: `$GOROOT/pkg/tool/wasip1_wasm/<name>`. */
export function toolPath(tc: GoToolchain, name: 'compile' | 'link' | 'asm'): string {
  return `${tc.goroot}/pkg/tool/wasip1_wasm/${name}`;
}

/**
 * A target's standard library: every archive of the parts for it built by
 * `version`, by import path (the first part to hold a package wins).
 */
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
