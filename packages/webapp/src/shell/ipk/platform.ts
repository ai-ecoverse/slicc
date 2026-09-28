/**
 * The platform ipk installs for, and npm's `os` / `cpu` check against it.
 *
 * SLICC runs no native code: every program executes as wasm. So when deciding
 * which platform-specific OPTIONAL dependencies to install, ipk describes
 * itself as a wasm host, not as the `linux` / `x64` the Node realm reports in
 * `process.platform` / `process.arch` (that report is a separate concern).
 * With `cpu: 'wasm32'` and `os: 'wasi'`, the napi-rs convention for wasm
 * bindings (`@scope/pkg-wasm32-wasi`, `cpu: ["wasm32"]`) still matches, while
 * darwin/linux/win32 binaries are skipped. Installing a `linux-x64` binary
 * would make loaders such as napi-rs, esbuild or rollup pick it and crash
 * instead of falling back to their wasm or JS path.
 *
 * `libc` is unset: it only means something on a linux host, as in npm.
 */
export const INSTALL_HOST: Readonly<InstallHost> = Object.freeze({
  os: 'wasi',
  cpu: 'wasm32',
  libc: undefined,
});

export interface InstallHost {
  os: string;
  cpu: string;
  libc: string | undefined;
}

/** The `os` / `cpu` / `libc` fields of a packument version. */
export interface PlatformConstraints {
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
}

function asList(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return null;
}

/**
 * npm-install-checks' `checkList`: an absent or empty list, or `["any"]`,
 * admits everything; a `!x` entry rejects `x`; otherwise the host value must
 * be listed, unless every entry is a negation.
 */
function admits(list: unknown, value: string | undefined): boolean {
  const entries = asList(list);
  if (!entries || entries.length === 0) return true;
  if (entries.length === 1 && entries[0] === 'any') return true;
  let negated = 0;
  let match = false;
  for (const entry of entries) {
    if (entry.startsWith('!')) {
      negated++;
      if (value === entry.slice(1)) return false;
    } else if (value === entry) {
      match = true;
    }
  }
  return match || negated === entries.length;
}

/** True when a version's `os` / `cpu` (and, on linux, `libc`) admit `host`. */
export function isPlatformSupported(
  constraints: PlatformConstraints,
  host: Readonly<InstallHost> = INSTALL_HOST
): boolean {
  if (!admits(constraints.os, host.os)) return false;
  if (!admits(constraints.cpu, host.cpu)) return false;
  if (host.os === 'linux' && constraints.libc !== undefined) {
    return admits(constraints.libc, host.libc);
  }
  return true;
}

/** npm's `notsup` wording for a skipped optional dependency. */
export function describeUnsupportedPlatform(
  id: string,
  constraints: PlatformConstraints,
  host: Readonly<InstallHost> = INSTALL_HOST
): string {
  const wanted: PlatformConstraints = {};
  const current: Partial<InstallHost> = {};
  for (const key of ['os', 'cpu'] as const) {
    if (constraints[key] !== undefined) {
      wanted[key] = constraints[key];
      current[key] = host[key];
    }
  }
  return `Unsupported platform for ${id}: wanted ${JSON.stringify(wanted)} (current: ${JSON.stringify(current)})`;
}
