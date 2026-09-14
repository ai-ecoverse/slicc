import type { PermissionGrant, PermissionProviders, SliccPermissions } from '@slicc/webcomponents';

import { createLogger } from '../../base/logger.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import { setLeaderPermissionsSurface } from './wc-permissions-registry.js';

const log = createLogger('wc-permissions');

export interface MountPendingDetail {
  idbKey: string;
  dirName: string;
  source: 'drop' | 'picker';
}

export interface InstallPermissionsOptions {
  runtimeMode: UiRuntimeMode;

  host?: HTMLElement;

  providers?: PermissionProviders;
}

function freshMountKey(): string {
  return `pendingMount:perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function installLeaderPermissionsSurface(
  options: InstallPermissionsOptions
): { element: SliccPermissions; dispose: () => void } | null {
  if (options.runtimeMode === 'cherry') return null;
  const host = options.host ?? document.body;
  const element = document.createElement('slicc-permissions') as SliccPermissions;
  element.setAttribute('data-leader-permissions', '');
  if (options.providers) {
    element.providers = options.providers;
  }
  host.appendChild(element);
  setLeaderPermissionsSurface(element);

  const onGrant = (event: Event): void => {
    const detail = (event as CustomEvent<PermissionGrant>).detail;
    if (detail.kind !== 'filesystem' || detail.source !== 'drop') return;
    void stashDroppedHandle(detail.handle).then((idbKey) => {
      document.dispatchEvent(
        new CustomEvent<MountPendingDetail>('slicc-mount-pending', {
          detail: { idbKey, dirName: detail.handle.name, source: 'drop' },
          bubbles: true,
          composed: true,
        })
      );
    });
  };

  element.addEventListener('slicc-permission-grant', onGrant);

  return {
    element,
    dispose() {
      element.removeEventListener('slicc-permission-grant', onGrant);
      element.remove();
      setLeaderPermissionsSurface(null);
    },
  };
}

async function stashDroppedHandle(handle: FileSystemDirectoryHandle): Promise<string> {
  const idbKey = freshMountKey();
  try {
    const { storePendingHandle } = await import('../../fs/mount-picker-popup.js');
    await storePendingHandle(idbKey, handle);
  } catch (err) {
    log.warn('failed to stash dropped handle', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  return idbKey;
}

export interface MountShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MountPendingConsumerDeps {
  runShell: (command: string) => Promise<MountShellResult>;

  doc?: Document;

  loadHandle?: (idbKey: string) => Promise<FileSystemDirectoryHandle | null>;

  storeHandle?: (idbKey: string, handle: FileSystemDirectoryHandle) => Promise<void>;

  mountKeyFor?: (targetPath: string) => string;
}

const MOUNT_CONSUMER_FLAG = '__sliccMountPendingConsumer';

export function parseMountPaths(stdout: string): Set<string> {
  const paths = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line === 'No active mounts') continue;
    const first = line.split(/\s+/)[0];
    if (first.startsWith('/')) paths.add(first);
  }
  return paths;
}

export function sanitizeMountSegment(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'folder';
}

export function pickFreeMountPath(seg: string, existing: Set<string>): string {
  let candidate = `/mnt/${seg}`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `/mnt/${seg}-${n++}`;
  }
  return candidate;
}

export function installMountPendingConsumer(deps: MountPendingConsumerDeps): () => void {
  const doc = deps.doc ?? document;
  const flagged = doc as Document & { [MOUNT_CONSUMER_FLAG]?: boolean };
  if (flagged[MOUNT_CONSUMER_FLAG]) {
    return () => {};
  }
  flagged[MOUNT_CONSUMER_FLAG] = true;

  let chain: Promise<void> = Promise.resolve();

  const onPending = (event: Event): void => {
    const detail = (event as CustomEvent<MountPendingDetail>).detail;
    if (!detail?.idbKey) return;
    chain = chain
      .then(() => mountDroppedFolder(detail, deps))
      .catch((err) => {
        log.error('slicc-mount-pending consumer failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  doc.addEventListener('slicc-mount-pending', onPending);

  return () => {
    doc.removeEventListener('slicc-mount-pending', onPending);
    flagged[MOUNT_CONSUMER_FLAG] = false;
  };
}

async function mountDroppedFolder(
  detail: MountPendingDetail,
  deps: MountPendingConsumerDeps
): Promise<void> {
  const loadHandle = deps.loadHandle ?? (await defaultPickerHelpers()).loadAndClearPendingHandle;
  const storeHandle = deps.storeHandle ?? (await defaultPickerHelpers()).storePendingHandle;
  const mountKeyFor = deps.mountKeyFor ?? (await defaultMountKeyFor());

  let handle: FileSystemDirectoryHandle | null;
  try {
    handle = await loadHandle(detail.idbKey);
  } catch (err) {
    log.warn('failed to read pending handle from IDB', {
      idbKey: detail.idbKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!handle) {
    log.warn('pending mount handle missing or expired', { idbKey: detail.idbKey });
    return;
  }

  let existing = new Set<string>();
  try {
    const list = await deps.runShell('mount list');
    existing = parseMountPaths(list.stdout);
  } catch (err) {
    log.warn('mount list probe failed; assuming no existing mounts', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const targetPath = pickFreeMountPath(sanitizeMountSegment(detail.dirName), existing);

  try {
    await storeHandle(mountKeyFor(targetPath), handle);
  } catch (err) {
    log.warn('failed to stash handle for worker adoption', {
      targetPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let result: MountShellResult;
  try {
    result = await deps.runShell(`mount ${targetPath}`);
  } catch (err) {
    log.error('mount command threw', {
      targetPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (result.exitCode !== 0) {
    log.error('mount command returned non-zero', {
      targetPath,
      stderr: result.stderr.trim(),
    });
    return;
  }
  log.info('mounted dropped folder', { targetPath, dirName: detail.dirName });
}

async function defaultPickerHelpers(): Promise<typeof import('../../fs/mount-picker-popup.js')> {
  return import('../../fs/mount-picker-popup.js');
}

async function defaultMountKeyFor(): Promise<(targetPath: string) => string> {
  const { localMountIdbKey } = await import('../../kernel/remote-terminal-view.js');
  return localMountIdbKey;
}
