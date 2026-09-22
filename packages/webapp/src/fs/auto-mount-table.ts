import { apiHeaders, resolveApiUrl } from '../base/api-endpoint.js';
import { createLogger } from '../base/logger.js';
import { normalizePath } from './path-utils.js';

const fetchLog = createLogger('auto-mount-table');

export const AUTO_MOUNT_FETCH_TIMEOUT_MS = 8_000;

const PENDING_MOUNT_TERM_PREFIX = 'pendingMount:term:';

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

export interface AutoMountBackendView {
  kind?: string;
  source?: string;
}

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

export function shadowedPendingMountKeys(targetPaths: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const raw of targetPaths) {
    const normalized = normalizePath(raw);
    if (normalized === '/') continue;
    keys.add(`${PENDING_MOUNT_TERM_PREFIX}${raw}`);
    if (normalized !== raw) keys.add(`${PENDING_MOUNT_TERM_PREFIX}${normalized}`);
  }
  return [...keys];
}

export function pendingMountKeysForOwnedTargets(
  storedKeys: readonly string[],
  ownedPaths: readonly string[]
): string[] {
  const owned = new Set(
    ownedPaths.map((path) => normalizePath(path)).filter((path) => path !== '/')
  );
  const matches: string[] = [];
  for (const key of storedKeys) {
    if (!key.startsWith(PENDING_MOUNT_TERM_PREFIX)) continue;
    const target = normalizePath(key.slice(PENDING_MOUNT_TERM_PREFIX.length));
    if (owned.has(target)) matches.push(key);
  }
  return matches;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return '';
  }
}

export async function fetchAutoMounts(
  fetchImpl: typeof fetch = fetch,
  log?: AutoMountLogger,
  timeoutMs: number = AUTO_MOUNT_FETCH_TIMEOUT_MS
): Promise<AutoMountMapping[]> {
  try {
    const response = await fetchImpl(resolveApiUrl('/api/runtime-config'), {
      cache: 'no-store',
      headers: apiHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
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
    if (!(await mountOne(fs, mapping, HostFsMountBackend, log))) {
      if (occupied) {
        warnAutoMount(
          log,
          'Released a blocking mount but could not mount the configured host folder',
          { ...mapping, replacedKind: backend?.kind ?? 'unknown' }
        );
      }
      continue;
    }
    mounted.push(mapping);
    if (occupied) logReplacedMount(mapping, backend?.kind, log);
  }
  return mounted;
}

export interface ShadowPurgeDeps {
  loadEntries: () => Promise<Array<{ targetPath: string }>>;
  removeMountEntry: (targetPath: string) => Promise<void>;
  clearPendingHandle: (idbKey: string) => Promise<void>;

  listPendingKeys?: () => Promise<string[]>;
}

async function defaultShadowPurgeDeps(): Promise<ShadowPurgeDeps> {
  const { getAllMountEntries, removeMountEntry } = await import('./mount-table-store.js');
  const { clearPendingMountHandle, listPendingMountKeys } = await import('./mount-picker-popup.js');
  return {
    loadEntries: () => getAllMountEntries(),
    removeMountEntry,
    clearPendingHandle: clearPendingMountHandle,
    listPendingKeys: listPendingMountKeys,
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
  const ownedPaths = [
    ...mounted.map((mapping) => mapping.path),
    ...shadowed.map((entry) => entry.targetPath),
  ];
  let storedKeys: string[] = [];
  if (purge.listPendingKeys) {
    try {
      storedKeys = await purge.listPendingKeys();
    } catch (err) {
      warnAutoMount(
        log,
        'Failed to list pending-mount handles while claiming config-owned targets',
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  }
  const keys = [
    ...new Set([
      ...shadowedPendingMountKeys(ownedPaths),
      ...pendingMountKeysForOwnedTargets(storedKeys, ownedPaths),
    ]),
  ];
  for (const key of keys) {
    await bestEffort(log, 'Failed to clear a shadowed pending-mount handle', { key }, () =>
      purge.clearPendingHandle(key)
    );
  }
}

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
