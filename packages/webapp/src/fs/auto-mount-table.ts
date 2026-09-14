import { apiHeaders, resolveApiUrl } from '../base/api-endpoint.js';

export interface AutoMountMapping {
  path: string;

  hostPath: string;
}

interface RuntimeConfigAutoMounts {
  autoMounts?: unknown;
}

export function isCanonicalAbsoluteTarget(path: string): boolean {
  if (!path.startsWith('/') || path === '/') return false;
  const segments = path.split('/').slice(1);
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

export interface AutoMountFS {
  listMounts(): string[];
  mount(path: string, backend: unknown): Promise<void> | void;
}

export interface AutoMountLogger {
  info?: (msg: string, data?: unknown) => void;
  warn?: (msg: string, data?: unknown) => void;
}

export async function fetchAutoMounts(
  fetchImpl: typeof fetch = fetch
): Promise<AutoMountMapping[]> {
  try {
    const response = await fetchImpl(resolveApiUrl('/api/runtime-config'), {
      cache: 'no-store',
      headers: apiHeaders(),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as RuntimeConfigAutoMounts;
    if (!Array.isArray(body.autoMounts)) return [];
    const mappings: AutoMountMapping[] = [];
    for (const raw of body.autoMounts) {
      const m = raw as { path?: unknown; hostPath?: unknown };
      if (typeof m.path !== 'string' || !isCanonicalAbsoluteTarget(m.path)) continue;
      if (typeof m.hostPath !== 'string' || m.hostPath.length === 0) continue;
      mappings.push({ path: m.path, hostPath: m.hostPath });
    }
    return mappings;
  } catch {
    return [];
  }
}

export function withoutHostMountedTargets<T extends { targetPath: string }>(
  entries: T[],
  mounted: readonly AutoMountMapping[]
): T[] {
  if (mounted.length === 0) return entries;
  const owned = new Set(mounted.map((m) => m.path));
  return entries.filter((entry) => !owned.has(entry.targetPath.replace(/\/+$/, '') || '/'));
}

export function hostShadowedEntries<T extends { targetPath: string }>(
  entries: T[],
  mounted: readonly AutoMountMapping[]
): T[] {
  if (mounted.length === 0) return [];
  const owned = new Set(mounted.map((m) => m.path));
  return entries.filter((entry) => owned.has(entry.targetPath.replace(/\/+$/, '') || '/'));
}

export async function mountConfiguredHostMounts(
  fs: AutoMountFS,
  log?: AutoMountLogger,
  fetchImpl: typeof fetch = fetch
): Promise<AutoMountMapping[]> {
  const mappings = await fetchAutoMounts(fetchImpl);
  if (mappings.length === 0) return [];
  const existing = new Set(fs.listMounts());
  const mounted: AutoMountMapping[] = [];
  const { HostFsMountBackend } = await import('./mount/backend-hostfs.js');
  for (const mapping of mappings) {
    if (existing.has(mapping.path)) continue;
    try {
      const backend = new HostFsMountBackend({
        targetPath: mapping.path,
        hostPath: mapping.hostPath,
      });
      await fs.mount(mapping.path, backend);
      mounted.push(mapping);
      log?.info?.('Auto-mounted host folder from the mount table', mapping);
    } catch (err) {
      log?.warn?.('Failed to auto-mount host folder', {
        ...mapping,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return mounted;
}
