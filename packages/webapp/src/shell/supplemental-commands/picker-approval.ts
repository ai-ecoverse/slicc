import { buildApprovalCardHtml } from '../../fs/picker-approval-card.js';
import { showToolUI, type ToolExecutionContext, toolUIRegistry } from '../tool-ui.js';

export { buildApprovalCardHtml };

const APPROVAL_TIMEOUT_MS = 120_000;

const APPROVAL_TIMEOUT_SENTINEL = Symbol('picker-approval-timeout');

export interface DevicePickerInfo {
  [key: string]: unknown;
}

interface PickerActionData {
  cancelled?: boolean;
  error?: unknown;
  granted?: boolean;
  handle?: unknown;
  info?: DevicePickerInfo;
}

interface PickerApprovalResponse {
  approved?: boolean;
  denied?: boolean;
  cancelled?: boolean;
  error?: string;
  handle?: string;
  info?: DevicePickerInfo;
}

export interface DeviceApprovalResult {
  handle: string;

  info: DevicePickerInfo;
}

export async function runDevicePickerApproval(
  kind: 'usb-device' | 'serial-port' | 'hid-device',
  filters: unknown[],
  toolContext: ToolExecutionContext
): Promise<DeviceApprovalResult> {
  const uiRequestId = toolUIRegistry.generateId();
  let timedOut = false;

  const rawUiPromise = showToolUI(
    {
      id: uiRequestId,
      html: buildApprovalCardHtml(kind, filters),
      onAction: async (action, data) => {
        if (action !== 'approve') return { denied: true };
        const d = data as PickerActionData | undefined;
        if (d?.cancelled) return { cancelled: true };
        if (d?.error) return { error: String(d.error) };
        if (d?.granted && typeof d.handle === 'string') {
          return { approved: true, handle: d.handle, info: d.info ?? null };
        }

        if (d?.granted && d?.info) {
          return { approved: true, info: d.info };
        }
        return { error: 'picker returned an unexpected response' };
      },
    },
    toolContext.onUpdate
  );

  const safeUiPromise = rawUiPromise.catch((err: unknown) => {
    if (timedOut) return APPROVAL_TIMEOUT_SENTINEL;
    throw err;
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof APPROVAL_TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      toolUIRegistry.cancel(uiRequestId, `${kind}: timed out`);
      resolve(APPROVAL_TIMEOUT_SENTINEL);
    }, APPROVAL_TIMEOUT_MS);
  });

  const result = await Promise.race([safeUiPromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (result === APPROVAL_TIMEOUT_SENTINEL) {
    throw new Error(
      `${kind}: timed out after ${Math.round(APPROVAL_TIMEOUT_MS / 1000)}s waiting for user approval`
    );
  }

  const res = result as PickerApprovalResponse;
  if (res.denied) throw new Error(`${kind}: denied by user`);
  if (res.cancelled) throw new Error(`${kind}: cancelled`);
  if (res.error) throw new Error(`${kind}: ${res.error}`);
  if (!res.approved || !res.info) throw new Error(`${kind}: no device selected`);
  return { handle: res.handle ?? '', info: res.info };
}
