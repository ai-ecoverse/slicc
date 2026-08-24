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

/**
 * Accept only targets that are already canonical (`/mnt/foo` — absolute,
 * not `/`, no `.`/`..`/empty segments, no trailing slash). The backend keys
 * its /api/hostfs requests and the VFS mount point on the SAME string, and
 * `VirtualFS.mount()` normalizes its argument — a non-canonical target would
 * make those three disagree. The servers reject such mappings at parse time
 * too; this guards a hand-crafted runtime-config.
 */
export function isCanonicalAbsoluteTarget(path: string): boolean {
  if (!path.startsWith('/') || path === '/') return false;
  const segments = path.split('/').slice(1);
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
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
      if (typeof m.path !== 'string' || !isCanonicalAbsoluteTarget(m.path)) continue;
      if (typeof m.hostPath !== 'string' || m.hostPath.length === 0) continue;
      mappings.push({ path: m.path, hostPath: m.hostPath });
    }
    return mappings;
  } catch {
    return [];
  }
}

/**
 * Drop persisted mount-table-store entries whose target is now owned by a
 * configured host mount. When a user converts a picker/S3 mount into a
 * mount-table entry at the same target, the stale IDB row would otherwise be
 * recovered into the already-mounted path and fail with EEXIST (or surface a
 * bogus "please re-mount" prompt).
 */
export function withoutHostMountedTargets<T extends { targetPath: string }>(
  entries: T[],
  mounted: readonly AutoMountMapping[]
): T[] {
  if (mounted.length === 0) return entries;
  const owned = new Set(mounted.map((m) => m.path));
  return entries.filter((entry) => !owned.has(entry.targetPath.replace(/\/+$/, '') || '/'));
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
