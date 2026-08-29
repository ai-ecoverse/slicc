/**
 * Local mount handle acquisition for extension popup and standalone direct
 * picker paths. Lives in `fs/` so callers avoid importing up into `shell/`.
 */

import {
  loadAndClearPendingHandle,
  openMountPickerPopup,
  reactivateHandle,
} from '../mount-picker-popup.js';

type ShowDirectoryPickerFn = (opts?: object) => Promise<FileSystemDirectoryHandle>;

/**
 * Extension terminal picker: the picker must run in a popup window so
 * macOS TCC dialogs render properly (the side panel can't host them →
 * renderer crash). The popup stashes the picked handle in IDB and
 * returns its key, which we revive via `loadAndClearPendingHandle` +
 * `reactivateHandle`.
 */
export async function acquireLocalMountViaPopup(): Promise<FileSystemDirectoryHandle> {
  try {
    const result = await openMountPickerPopup();
    if (result.cancelled) {
      throw new Error('mount: cancelled');
    }
    if (result.error) {
      throw new Error(`mount: ${result.error}`);
    }
    if (result.handleInIdb && typeof result.idbKey === 'string') {
      const handle = await loadAndClearPendingHandle(result.idbKey);
      if (!handle) {
        throw new Error('mount: no directory handle found in storage');
      }
      await reactivateHandle(handle);
      return handle;
    }
    throw new Error('mount: unexpected popup result');
  } catch (err: unknown) {
    throw new Error(`mount: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * CLI/standalone direct picker (TCC dialogs work in a regular page
 * context). Worker contexts reach this branch when a panel-terminal user
 * types `mount --source local` directly; the picker requires `window` + a
 * recent user gesture, neither of which the worker has.
 */
export async function acquireLocalMountViaDirectPicker(): Promise<FileSystemDirectoryHandle> {
  if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) {
    throw new Error(
      'mount: local picker requires a user gesture in the panel ' +
        '(unavailable in this runtime). Ask the agent to mount it instead.'
    );
  }
  try {
    return await (
      window as Window & typeof globalThis & { showDirectoryPicker: ShowDirectoryPickerFn }
    ).showDirectoryPicker({ mode: 'readwrite' });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('mount: cancelled');
    }
    throw new Error(`mount: ${err instanceof Error ? err.message : String(err)}`);
  }
}
