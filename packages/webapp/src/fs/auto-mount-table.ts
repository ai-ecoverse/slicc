/**
 * Mount table — host folders the launcher serves over `/api/hostfs` and the
 * kernel mounts automatically at boot, with no picker and no Chrome
 * permission prompt.
 *
 * The table is owned by the launcher: node-server `--mount=<os>:<vfs>` or
 * the Sliccstart Settings → Mounts tab, surfaced as `autoMounts` on the
 * local `/api/runtime-config`. Only mappings whose OS folder existed at
 * server startup are advertised. Everything the user initiates from inside
 * the webapp (`mount <path>` → picker) is untouched by this module and
 * keeps its permission prompts.
 */

import { apiHeaders, resolveApiUrl } from '../base/api-endpoint.js';

export interface AutoMountMapping {
  /** SLICC target, e.g. `/mnt/project`. */
  path: string;
  /** OS folder as resolved by the server (display only in this realm). */
  hostPath: string;
}

interface RuntimeConfigAutoMounts {
  autoMounts?: unknown;
}

/** Minimal FS surface needed to mount — lets tests stub VirtualFS. */
export interface AutoMountFS {
  listMounts(): string[];
  mount(path: string, backend: unknown): Promise<void> | void;
}

export interface AutoMountLogger {
  info?: (msg: string, data?: unknown) => void;
  warn?: (msg: string, data?: unknown) => void;
}

/**
 * Fetch the mount table. Returns `[]` when no local server answers (hosted /
 * extension floats) or the response carries no table — there is nothing to
 * auto-mount without a launcher.
 */
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
      if (typeof m.path !== 'string' || !m.path.startsWith('/') || m.path === '/') continue;
      if (typeof m.hostPath !== 'string' || m.hostPath.length === 0) continue;
      mappings.push({ path: m.path, hostPath: m.hostPath });
    }
    return mappings;
  } catch {
    return [];
  }
}

/**
 * Mount every table entry that is not already mounted. Failures are
 * per-entry (one bad mapping must not block the rest) and logged, never
 * thrown — boot continues without the mount, exactly like a missing
 * remote mount.
 */
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
