/**
 * Leader-tab permission surface wiring.
 *
 * Mounts a single `<slicc-permissions>` web component into the live WC shell
 * so every gesture-gated picker (camera / mic / USB / HID / serial / FS)
 * routes through ONE in-tab host. The folder-drop path (Wave 1 Spike A)
 * captures a writable `FileSystemDirectoryHandle` synchronously on drop,
 * runs `requestPermission({ mode: 'readwrite' })` in the same activation
 * tick, then stashes the handle in the shared `slicc-pending-mount` IDB
 * store and dispatches a document-level `slicc-mount-pending` event the
 * existing mount UI can consume.
 *
 * Skipped in cherry follower mode: a cross-origin iframe can't hold a
 * writable FS handle (no Permissions-Policy integration; `postMessage` of
 * `FileSystemHandle` is same-origin only), per Spike A's findings.
 */

// Component registration ships through the main barrel side-effect import
// in `wc-shell.ts`; types come from the same barrel.
import type { PermissionGrant, PermissionProviders, SliccPermissions } from '@slicc/webcomponents';

import { createLogger } from '../../core/logger.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import { setLeaderPermissionsSurface } from './wc-permissions-registry.js';

const log = createLogger('wc-permissions');

/** Detail of the `slicc-mount-pending` document-level event we emit on drop. */
export interface MountPendingDetail {
  idbKey: string;
  dirName: string;
  source: 'drop' | 'picker';
}

export interface InstallPermissionsOptions {
  /** Boot runtime — cherry mode skips installation. */
  runtimeMode: UiRuntimeMode;
  /** Host the surface lives in. Defaults to `document.body`. */
  host?: HTMLElement;
  /**
   * Injectable provider seams forwarded onto the mounted element's
   * `providers` field. Any field omitted falls back to the platform
   * default (`navigator.usb` / `navigator.hid` / `navigator.serial` /
   * `window.showDirectoryPicker` / `navigator.mediaDevices`).
   * Hosts use this to swap in an extension-mode popup picker for
   * `filesystem`, or to fake providers under test.
   */
  providers?: PermissionProviders;
}

/**
 * Build a unique IDB key per stashed handle. Mirrors `runDirectoryPicker`'s
 * `pendingMount:dip-…` convention so any downstream consumer that already
 * knows the prefix can pick the handle up.
 */
function freshMountKey(): string {
  return `pendingMount:perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Mount `<slicc-permissions>` into the leader tab and wire the folder-drop
 * grant to the existing pending-handle IDB store. Returns a teardown
 * function plus the element handle (useful for tests + the few callers
 * that want to programmatically invoke `request()`).
 *
 * Returns `null` in cherry mode (no mount; followers focus the leader tab
 * for picker actions instead).
 */
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

/**
 * Stash a granted handle in the shared pending-mount IDB store. Lazy-imports
 * `mount-picker-popup` so the wiring stays out of the boot bundle until the
 * very first drop actually lands.
 */
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
