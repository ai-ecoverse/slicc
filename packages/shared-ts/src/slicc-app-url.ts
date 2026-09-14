import { SLICC_HOSTED_ORIGIN, SLICC_STAGING_HUB_ORIGIN } from './bridge-protocol.js';

const CAPABILITY_PARAMS = ['bridgeToken', 'bridge', 'tray'] as const;

const MODE_FLAG_PARAMS = ['cherry', 'connect'] as const;

const APP_SHELL_PREFIXES = ['/join/', '/tray/'] as const;

const APP_SHELL_PATHS = ['', '/', '/cloud', '/connect'] as const;

export interface SliccAppUrlOptions {
  selfOrigins?: readonly string[];
}

function normalizePath(pathname: string): string {
  const withoutIndex = pathname.replace(/\/index\.html$/, '/');
  return withoutIndex.length > 1 ? withoutIndex.replace(/\/$/, '') : withoutIndex;
}

export function isSliccAppUrl(rawUrl: string, options: SliccAppUrlOptions = {}): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  for (const param of CAPABILITY_PARAMS) {
    if (url.searchParams.has(param)) return true;
  }
  for (const flag of MODE_FLAG_PARAMS) {
    if (url.searchParams.get(flag) === '1') return true;
  }

  const origins = new Set<string>([
    SLICC_HOSTED_ORIGIN,
    SLICC_STAGING_HUB_ORIGIN,
    ...(options.selfOrigins ?? []),
  ]);
  if (!origins.has(url.origin)) return false;

  const path = normalizePath(url.pathname);
  if ((APP_SHELL_PATHS as readonly string[]).includes(path)) return true;
  return APP_SHELL_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix));
}
