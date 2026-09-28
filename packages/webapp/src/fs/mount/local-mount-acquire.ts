import type { PanelRpcClient, PermissionRpcGrant } from '../../kernel/panel-rpc.js';
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

const PANEL_PROMPT_TIMEOUT_MS = 5 * 60_000;

export async function acquireLocalMountViaPanelPrompt(
  rpc: PanelRpcClient,
  targetPath: string
): Promise<FileSystemDirectoryHandle> {
  let grants: PermissionRpcGrant[];
  try {
    ({ grants } = await rpc.call(
      'permission-request',
      {
        kinds: ['filesystem'],
        description: `A command in the terminal asks to mount a local directory at ${targetPath}.`,
      },
      { timeoutMs: PANEL_PROMPT_TIMEOUT_MS }
    ));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.replace(/^permission-request: /, ''));
  }
  const grant = grants.find((g) => g.kind === 'filesystem');
  if (!grant || !('idbKey' in grant)) throw new Error('no directory selected');
  const handle = await loadAndClearPendingHandle(grant.idbKey);
  if (!handle) throw new Error('no directory handle found in storage');
  await reactivateHandle(handle);
  return handle;
}
