import type { ToolExecutionContext } from '../../base/tool-execution-context.js';
import { loadAndClearPendingHandle, reactivateHandle } from '../../fs/mount-picker-popup.js';
import { buildApprovalCardHtml } from '../../fs/picker-approval-card.js';
import { showToolUI, toolUIRegistry } from '../tool-ui.js';

const MOUNT_TOOL_UI_TIMEOUT_MS = 5 * 60 * 1000;

const MOUNT_PANEL_ACK_TIMEOUT_MS = 5_000;

const MOUNT_TIMEOUT_SENTINEL: unique symbol = Symbol('mount:timeout');

const MOUNT_NO_PANEL_SENTINEL: unique symbol = Symbol('mount:no-panel');

type ShowDirectoryPickerFn = (opts?: object) => Promise<FileSystemDirectoryHandle>;

interface DirectoryApprovalActionData {
  handleInIdb?: boolean;
  idbKey?: string;
  cancelled?: boolean;
  error?: unknown;
}

interface MountDirectoryApprovalResult {
  approved?: boolean;
  handle?: FileSystemDirectoryHandle;
  denied?: boolean;
  cancelled?: boolean;
  error?: string;
}

export async function runMountDirectoryApproval(
  toolContext: ToolExecutionContext,
  targetPath: string
): Promise<FileSystemDirectoryHandle> {
  const uiRequestId = toolUIRegistry.generateId();
  let timedOut = false;
  let noPanel = false;

  const rawUiPromise = showToolUI(
    {
      id: uiRequestId,
      html: buildApprovalCardHtml('directory', [], targetPath),
      onAction: (action, data) => resolveMountDirectoryApprovalAction(action, data),
    },
    toolContext.onUpdate
  );

  const safeUiPromise = rawUiPromise.catch((err: unknown) => {
    if (timedOut) return MOUNT_TIMEOUT_SENTINEL;
    if (noPanel) return MOUNT_NO_PANEL_SENTINEL;
    throw err;
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof MOUNT_TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      toolUIRegistry.cancel(uiRequestId, 'mount: timed out');
      resolve(MOUNT_TIMEOUT_SENTINEL);
    }, MOUNT_TOOL_UI_TIMEOUT_MS);
  });

  const noPanelPromise = new Promise<typeof MOUNT_NO_PANEL_SENTINEL>((resolve) => {
    toolUIRegistry.waitForMount(uiRequestId, MOUNT_PANEL_ACK_TIMEOUT_MS).then(
      () => {},
      () => {
        if (timedOut) return;
        noPanel = true;
        toolUIRegistry.cancel(uiRequestId, 'mount: panel did not render the approval card');
        resolve(MOUNT_NO_PANEL_SENTINEL);
      }
    );
  });

  const result = await Promise.race([safeUiPromise, timeoutPromise, noPanelPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (result === MOUNT_TIMEOUT_SENTINEL) {
    throw new Error(
      `mount: timed out after ${Math.round(MOUNT_TOOL_UI_TIMEOUT_MS / 60000)} minute(s) ` +
        'waiting for user approval'
    );
  }
  if (result === MOUNT_NO_PANEL_SENTINEL) {
    throw new Error(
      'mount: chat panel did not render the approval card — open the chat panel and retry'
    );
  }
  if (!result) {
    throw new Error('mount: tool UI not available');
  }

  const res = result as MountDirectoryApprovalResult;
  if (res.denied) throw new Error('mount: denied by user');
  if (res.cancelled) throw new Error('mount: cancelled');
  if (res.error) throw new Error(`mount: ${res.error}`);
  if (!res.handle) throw new Error('mount: no directory selected');
  return res.handle;
}

async function resolveMountDirectoryApprovalAction(
  action: string,
  data: unknown
): Promise<MountDirectoryApprovalResult> {
  if (action !== 'approve') return { denied: true };
  const d = data as DirectoryApprovalActionData | undefined;

  if (d?.handleInIdb && typeof d.idbKey === 'string') {
    try {
      const handle = await loadAndClearPendingHandle(d.idbKey);
      if (!handle) return { error: 'No directory handle found in storage' };
      await reactivateHandle(handle);
      return { approved: true, handle };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (d?.cancelled) return { cancelled: true };
  if (d?.error) return { error: String(d.error) };

  try {
    const handle = await (
      window as Window & typeof globalThis & { showDirectoryPicker: ShowDirectoryPickerFn }
    ).showDirectoryPicker({ mode: 'readwrite' });
    return { approved: true, handle };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { cancelled: true };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
