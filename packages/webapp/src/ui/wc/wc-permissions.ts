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

// ---------------------------------------------------------------------------
// slicc-mount-pending consumer (Spike A back-half)
// ---------------------------------------------------------------------------

/** Captured output of a single worker shell command. */
export interface MountShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MountPendingConsumerDeps {
  /**
   * Run a single shell command in the kernel-worker shell and resolve with
   * its captured output. The standalone wiring backs this with a
   * `TerminalSessionClient`; tests inject a stub.
   */
  runShell: (command: string) => Promise<MountShellResult>;
  /** Document to listen on. Defaults to the global `document`. */
  doc?: Document;
  /**
   * Recover (and clear) a stashed handle from the shared pending-mount IDB
   * store. Defaults to `mount-picker-popup.loadAndClearPendingHandle`.
   */
  loadHandle?: (idbKey: string) => Promise<FileSystemDirectoryHandle | null>;
  /**
   * Stash a handle under `idbKey`. Defaults to
   * `mount-picker-popup.storePendingHandle`.
   */
  storeHandle?: (idbKey: string, handle: FileSystemDirectoryHandle) => Promise<void>;
  /**
   * Build the worker-side adopt key for a target path. Defaults to
   * `remote-terminal-view.localMountIdbKey` — the SAME key
   * `mount-commands.tryAdoptPrePickedHandle` reads, so the worker's existing
   * pre-picked-handle fast path mounts the dropped folder.
   */
  mountKeyFor?: (targetPath: string) => string;
}

/** Marker so re-renders / HMR don't double-register the document listener. */
const MOUNT_CONSUMER_FLAG = '__sliccMountPendingConsumer';

/** Parse `mount list` stdout into the set of currently-mounted target paths. */
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

/**
 * Reduce a dropped directory name to a single safe `/mnt` path segment:
 * the worker `mount` command splits on whitespace, so spaces / slashes
 * would break the forwarded command line.
 */
export function sanitizeMountSegment(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'folder';
}

/** First free `/mnt/<seg>` path, falling back to `-2`, `-3`, … on collision. */
export function pickFreeMountPath(seg: string, existing: Set<string>): string {
  let candidate = `/mnt/${seg}`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `/mnt/${seg}-${n++}`;
  }
  return candidate;
}

/**
 * Register the document-level `slicc-mount-pending` consumer: it recovers the
 * dropped handle from IDB, derives a collision-safe `/mnt/<name>` target, and
 * drives the worker's existing local-mount fast path
 * (`tryAdoptPrePickedHandle` → `LocalMountBackend` → `fs.mount`) by re-stashing
 * the handle under the worker's adopt key and forwarding `mount <target>`.
 *
 * Drops are processed strictly sequentially (a shared chain) so two quick
 * drops can't both claim the same free path. Registration is idempotent — a
 * second call (re-render / HMR) is a no-op until the first teardown runs.
 *
 * Cross-runtime: the standalone / electron-overlay / hosted-leader floats all
 * boot through `attachWcClient`, so this consumer is live there. The extension
 * rides the same path structurally (shared-origin IDB + `OffscreenClient`
 * shell exec), but the side-panel→offscreen drop capture is NOT verified here
 * — see the Spike A spec note; treat extension as a follow-up.
 */
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

/** Adopt one dropped handle and mount it; resolves once the mount settles. */
async function mountDroppedFolder(
  detail: MountPendingDetail,
  deps: MountPendingConsumerDeps
): Promise<void> {
  const loadHandle = deps.loadHandle ?? (await defaultPickerHelpers()).loadAndClearPendingHandle;
  const storeHandle = deps.storeHandle ?? (await defaultPickerHelpers()).storePendingHandle;
  const mountKeyFor = deps.mountKeyFor ?? (await defaultMountKeyFor());

  // Fail fast if the handle is gone before touching the shell.
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

  // Collision-safe target. A failed `mount list` degrades to "assume empty"
  // rather than aborting the mount entirely.
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

  // Re-key the handle under the worker's adopt key so `mountLocal`'s
  // `tryAdoptPrePickedHandle` fast path picks it up.
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

/** Lazily load the IDB handle helpers (kept out of the boot bundle). */
async function defaultPickerHelpers(): Promise<typeof import('../../fs/mount-picker-popup.js')> {
  return import('../../fs/mount-picker-popup.js');
}

/** Lazily load the canonical worker adopt-key builder. */
async function defaultMountKeyFor(): Promise<(targetPath: string) => string> {
  const { localMountIdbKey } = await import('../../kernel/remote-terminal-view.js');
  return localMountIdbKey;
}
