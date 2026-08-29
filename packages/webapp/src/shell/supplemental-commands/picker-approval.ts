/**
 * Shared cone-side approval card for picker kinds (mount/usb/serial/hid).
 *
 * Cone-driven device pickers can't run `navigator.{usb,serial,hid}.request*`
 * inline — the agent's tool-call arrives without a user activation, so
 * Chrome rejects with "must be handling a user gesture". Mirroring the
 * `mount` cone flow, we surface a `showToolUI` approval card in chat; the
 * user click on **Approve** propagates the activation through the dip
 * (standalone) or the unified picker popup (extension) to the chooser
 * itself, then registers the granted device into the shared page-side
 * registry and resolves back into the worker that owns the command.
 *
 * Each kind shares the same card markup (title + Approve/Deny buttons +
 * `data-picker=<kind>` attribute carrying the filters); per-kind text
 * comes from `fs/picker-approval-card.ts`.
 */

import { buildApprovalCardHtml } from '../../fs/picker-approval-card.js';
import { showToolUI, type ToolExecutionContext, toolUIRegistry } from '../tool-ui.js';

export { buildApprovalCardHtml };

/** Two minutes — enough for a slow user, short enough to fail loud. */
const APPROVAL_TIMEOUT_MS = 120_000;

const APPROVAL_TIMEOUT_SENTINEL = Symbol('picker-approval-timeout');

/** Serializable device descriptor returned by browser picker APIs. */
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

/** Device-picker approval outcome handed back to the calling command. */
export interface DeviceApprovalResult {
  /** Page-realm registry handle (`usb1`, `serial2`, `hid1`, …). */
  handle: string;
  /** Serializable descriptor (vid/pid/serial number/…). */
  info: DevicePickerInfo;
}

/**
 * Show a device-picker approval card and resolve with the granted device
 * handle + info, mirroring the mount cone flow. The actual chooser runs
 * on the user's click (in `dip.ts:handleDipPickerAction` for standalone,
 * or via `picker-popup.html` for extension).
 *
 * Throws on cancellation, denial, error, or timeout — the calling shell
 * command surfaces those messages directly.
 */
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
        // Extension popup-swap path posts `{ granted, info }` without a
        // handle — the offscreen command is responsible for re-acquiring
        // in its own realm. Surface the raw info so the caller can drive
        // that re-acquire.
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
