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
