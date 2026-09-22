/**
 * Mount table — host folders the launcher serves over `/api/hostfs` and the
 * kernel mounts automatically, with no picker and no Chrome permission prompt.
 *
 * The table is owned by the launcher: node-server `--mount=<os>:<vfs>` or
 * the Sliccstart Settings → Mounts tab, surfaced as `autoMounts` on the
 * local `/api/runtime-config`. Only mappings whose OS folder existed at
 * server startup are advertised. Everything the user initiates from inside
 * the webapp (`mount <path>` → picker) is untouched by this module and
 * keeps its permission prompts — except a picker (or any other non-hostfs
 * backend) sitting on a target the table owns. That target is config-owned:
 * the live backend is replaced and its persisted row and pending-mount
 * handle are dropped.
 *
 * Applied twice on purpose. `Orchestrator.init` runs it as soon as the
 * shared filesystem exists, before scoop restore, so a long boot cannot
 * lose the path to a user picker. `recoverPersistedMounts` runs it again
 * after the lick handler is installed, which retries a fetch that failed
 * early and still filters persisted rows out of mount recovery.
 */

import { apiHeaders, resolveApiUrl } from '../base/api-endpoint.js';
import { createLogger } from '../base/logger.js';

const fetchLog = createLogger('auto-mount-table');

/** Panel-terminal pending-mount prefix. Must match `localMountIdbKey`. */
const PENDING_MOUNT_TERM_PREFIX = 'pendingMount:term:';

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

/** Backend already registered at a path, when the FS can say. */
export interface AutoMountBackendView {
  kind?: string;
  source?: string;
}

/** Minimal FS surface needed to mount — lets tests stub VirtualFS. */
export interface AutoMountFS {
  listMounts(): string[];
  mount(path: string, backend: unknown): Promise<void> | void;
  unmount?(path: string): Promise<void> | void;
  getMountBackend?(path: string): AutoMountBackendView | null;
}

export interface AutoMountLogger {
  info?: (msg: string, data?: unknown) => void;
  warn?: (msg: string, data?: unknown) => void;
}

type HostFsCtor = new (opts: { targetPath: string; hostPath: string }) => unknown;

function warnAutoMount(log: AutoMountLogger | undefined, msg: string, data?: unknown): void {
  if (log?.warn) log.warn(msg, data);
  else fetchLog.warn(msg, data);
}

function configuredHostSource(hostPath: string): string {
  return `hostfs://${hostPath}`;
}

function isConfiguredHostMount(
  backend: AutoMountBackendView | null | undefined,
  mapping: AutoMountMapping
): boolean {
  return backend?.kind === 'hostfs' && backend.source === configuredHostSource(mapping.hostPath);
}

/**
 * IDB keys under which a picker may have armed a handle for these targets.
 * Includes the raw spelling and the trailing-slash-stripped form: the panel
 * stores `pendingMount:term:` plus the path the user typed, while the mount
 * table stores the normalized target.
 */
export function shadowedPendingMountKeys(targetPaths: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const raw of targetPaths) {
    const normalized = raw.replace(/\/+$/, '') || '/';
    if (normalized === '/') continue;
    keys.add(`${PENDING_MOUNT_TERM_PREFIX}${raw}`);
    if (normalized !== raw) keys.add(`${PENDING_MOUNT_TERM_PREFIX}${normalized}`);
  }
  return [...keys];
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return '';
  }
}

/**
 * Fetch the mount table. Returns `[]` when no local server answers (hosted /
 * extension floats) or the response carries no table — there is nothing to
 * auto-mount without a launcher. A non-OK response or a thrown fetch is
 * logged (status and body when the server answered); an absent `autoMounts`
 * field stays quiet.
 */
export async function fetchAutoMounts(
  fetchImpl: typeof fetch = fetch,
  log?: AutoMountLogger
): Promise<AutoMountMapping[]> {
  try {
    const response = await fetchImpl(resolveApiUrl('/api/runtime-config'), {
      cache: 'no-store',
      headers: apiHeaders(),
    });
    if (!response.ok) {
      warnAutoMount(log, 'Mount table fetch failed', {
        status: response.status,
        body: await readErrorBody(response),
      });
      return [];
    }
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
  } catch (err) {
    warnAutoMount(log, 'Mount table fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
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
 * The complement of {@link withoutHostMountedTargets}: the persisted rows a
 * configured host mount now shadows. The caller purges these from the store
 * for good, not just for this boot — a shadowed row left armed means the
 * first boot where the launcher stops advertising the target silently falls
 * back to the persisted FS-Access handle, and a boot-time index walk of a
 * tree the user thought was config-owned (2026-08-24: an iCloud
 * `~/Desktop/kb` behind a hostfs mapping). Pending-mount handles for the
 * same target (`pendingMount:term:<path>`) are cleared alongside the row.
 */
export function hostShadowedEntries<T extends { targetPath: string }>(
  entries: T[],
  mounted: readonly AutoMountMapping[]
): T[] {
  if (mounted.length === 0) return [];
  const owned = new Set(mounted.map((m) => m.path));
  return entries.filter((entry) => owned.has(entry.targetPath.replace(/\/+$/, '') || '/'));
}

async function mountOne(
  fs: AutoMountFS,
  mapping: AutoMountMapping,
  HostFsMountBackend: HostFsCtor,
  log?: AutoMountLogger
): Promise<boolean> {
  try {
    const backend = new HostFsMountBackend({
      targetPath: mapping.path,
      hostPath: mapping.hostPath,
    });
    await fs.mount(mapping.path, backend);
    log?.info?.('Auto-mounted host folder from the mount table', mapping);
    return true;
  } catch (err) {
    warnAutoMount(log, 'Failed to auto-mount host folder', {
      ...mapping,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Free `mapping.path` when some other backend already owns it. Returns false
 * when the path is still occupied (no `unmount`, or unmount threw) — the
 * caller must not mount over it and must not treat the target as owned.
 */
async function releaseBlockingMount(
  fs: AutoMountFS,
  mapping: AutoMountMapping,
  backend: AutoMountBackendView | null,
  log?: AutoMountLogger
): Promise<boolean> {
  const kind = backend?.kind ?? 'unknown';
  if (!fs.unmount) {
    warnAutoMount(log, 'Configured host folder is blocked by an existing mount', {
      ...mapping,
      kind,
    });
    return false;
  }
  try {
    await fs.unmount(mapping.path);
    return true;
  } catch (err) {
    warnAutoMount(log, 'Failed to unmount a mount blocking a config-owned target', {
      ...mapping,
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function logReplacedMount(
  mapping: AutoMountMapping,
  kind: string | undefined,
  log?: AutoMountLogger
): void {
  const replacedKind = kind ?? 'unknown';
  if (replacedKind === 'hostfs') {
    log?.info?.('Re-mounted host folder because the configured host path changed', {
      ...mapping,
      replacedKind,
    });
    return;
  }
  warnAutoMount(log, 'Replaced a non-hostfs mount with the configured host folder', {
    ...mapping,
    replacedKind,
  });
}

/**
 * Mount every table entry. A target that already has the configured hostfs
 * backend is left in place and still returned, so the caller purges shadowed
 * rows. Any other backend at a config-owned target is unmounted and replaced.
 * Failures are per-entry (one bad mapping must not block the rest) and
 * logged, never thrown — boot continues without that mount.
 *
 * The returned list is every mapping now owned by hostfs, not only the ones
 * mounted in this call. Callers use it to drop persisted rows and pending
 * handles at those targets.
 */
export async function mountConfiguredHostMounts(
  fs: AutoMountFS,
  log?: AutoMountLogger,
  fetchImpl: typeof fetch = fetch
): Promise<AutoMountMapping[]> {
  const mappings = await fetchAutoMounts(fetchImpl, log);
  if (mappings.length === 0) return [];
  const existing = new Set(fs.listMounts());
  const mounted: AutoMountMapping[] = [];
  const { HostFsMountBackend } = await import('./mount/backend-hostfs.js');
  for (const mapping of mappings) {
    const occupied = existing.has(mapping.path);
    const backend = occupied ? (fs.getMountBackend?.(mapping.path) ?? null) : null;
    if (occupied && isConfiguredHostMount(backend, mapping)) {
      mounted.push(mapping);
      continue;
    }
    if (occupied && !(await releaseBlockingMount(fs, mapping, backend, log))) continue;
    if (!(await mountOne(fs, mapping, HostFsMountBackend, log))) continue;
    mounted.push(mapping);
    if (occupied) logReplacedMount(mapping, backend?.kind, log);
  }
  return mounted;
}

export interface ShadowPurgeDeps {
  loadEntries: () => Promise<Array<{ targetPath: string }>>;
  removeMountEntry: (targetPath: string) => Promise<void>;
  clearPendingHandle: (idbKey: string) => Promise<void>;
}

async function defaultShadowPurgeDeps(): Promise<ShadowPurgeDeps> {
  const { getAllMountEntries, removeMountEntry } = await import('./mount-table-store.js');
  const { clearPendingMountHandle } = await import('./mount-picker-popup.js');
  return {
    loadEntries: () => getAllMountEntries(),
    removeMountEntry,
    clearPendingHandle: clearPendingMountHandle,
  };
}

async function bestEffort(
  log: AutoMountLogger | undefined,
  msg: string,
  detail: { path?: string; key?: string },
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    warnAutoMount(log, msg, {
      ...detail,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete persisted mount-table rows and armed pending-mount handles for
 * targets {@link mountConfiguredHostMounts} now owns. Other targets are
 * left alone. A missing row or handle is success. Best-effort per key.
 */
export async function purgeShadowedHostMountState(
  mounted: readonly AutoMountMapping[],
  log?: AutoMountLogger,
  deps?: ShadowPurgeDeps
): Promise<void> {
  if (mounted.length === 0) return;
  const purge = deps ?? (await defaultShadowPurgeDeps());
  let entries: Array<{ targetPath: string }> = [];
  try {
    entries = await purge.loadEntries();
  } catch (err) {
    warnAutoMount(log, 'Failed to read persisted mounts while claiming config-owned targets', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const shadowed = hostShadowedEntries(entries, mounted);
  for (const stale of shadowed) {
    await bestEffort(log, 'Failed to purge host-owned mount row', { path: stale.targetPath }, () =>
      purge.removeMountEntry(stale.targetPath)
    );
  }
  const keys = shadowedPendingMountKeys([
    ...mounted.map((mapping) => mapping.path),
    ...shadowed.map((entry) => entry.targetPath),
  ]);
  for (const key of keys) {
    await bestEffort(log, 'Failed to clear a shadowed pending-mount handle', { key }, () =>
      purge.clearPendingHandle(key)
    );
  }
}

/**
 * Mount the launcher's table and forget picker state at those targets.
 * Never throws — one bad mapping or a stuck IndexedDB must not stop boot.
 */
export async function applyConfiguredHostMounts(
  fs: AutoMountFS,
  log?: AutoMountLogger,
  fetchImpl: typeof fetch = fetch
): Promise<AutoMountMapping[]> {
  const mounted = await mountConfiguredHostMounts(fs, log, fetchImpl);
  try {
    await purgeShadowedHostMountState(mounted, log);
  } catch (err) {
    warnAutoMount(log, 'Failed to purge state shadowed by configured host mounts', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return mounted;
}
