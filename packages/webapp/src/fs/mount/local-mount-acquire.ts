import {
  loadAndClearPendingHandle,
  openMountPickerPopup,
  reactivateHandle,
} from '../mount-picker-popup.js';

type ShowDirectoryPickerFn = (opts?: object) => Promise<FileSystemDirectoryHandle>;

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
