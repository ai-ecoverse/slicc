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
 * comes from {@link PICKER_KIND_TEXT}.
 */

import { showToolUI, type ToolExecutionContext, toolUIRegistry } from '../../tools/tool-ui.js';
import type { PickerKind } from './picker-popup.js';

/** Two minutes — enough for a slow user, short enough to fail loud. */
const APPROVAL_TIMEOUT_MS = 120_000;

const APPROVAL_TIMEOUT_SENTINEL = Symbol('picker-approval-timeout');

interface PickerKindText {
  title: string;
  approve: string;
}

const PICKER_KIND_TEXT: Record<PickerKind, PickerKindText> = {
  directory: { title: 'Mount local directory', approve: 'Select directory' },
  'usb-device': { title: 'Connect USB device', approve: 'Select USB device' },
  'serial-port': { title: 'Connect serial port', approve: 'Select serial port' },
  'hid-device': { title: 'Connect HID device', approve: 'Select HID device' },
};

/** Escapes HTML special characters for safe interpolation into card markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Build the standard approval-card HTML for a picker kind + filters. */
export function buildApprovalCardHtml(
  kind: PickerKind,
  filters: unknown[] = [],
  targetPath?: string
): string {
  const text = PICKER_KIND_TEXT[kind];
  const dataAttr = filters.length
    ? ` data-action-data='${JSON.stringify({ filters }).replace(/'/g, '&apos;')}'`
    : '';
  const metaHtml =
    kind === 'directory' && targetPath
      ? `\n      <div class="sprinkle-action-card__meta">Target: ${escapeHtml(targetPath)}</div>`
      : '';
  return `
    <div class="sprinkle-action-card">
      <div class="sprinkle-action-card__header">${text.title} <span class="sprinkle-badge sprinkle-badge--notice">approval</span></div>${metaHtml}
      <div class="sprinkle-action-card__actions">
        <button class="sprinkle-btn sprinkle-btn--secondary" data-action="deny">Deny</button>
        <button class="sprinkle-btn sprinkle-btn--primary" data-action="approve" data-picker="${kind}"${dataAttr}>${text.approve}</button>
      </div>
    </div>
  `;
}

/** Device-picker approval outcome handed back to the calling command. */
export interface DeviceApprovalResult {
  /** Page-realm registry handle (`usb1`, `serial2`, `hid1`, …). */
  handle: string;
  /** Serializable descriptor (vid/pid/serial number/…). */
  info: Record<string, unknown>;
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
        const d = data as Record<string, unknown> | undefined;
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

  const res = result as {
    approved?: boolean;
    denied?: boolean;
    cancelled?: boolean;
    error?: string;
    handle?: string;
    info?: Record<string, unknown>;
  };
  if (res.denied) throw new Error(`${kind}: denied by user`);
  if (res.cancelled) throw new Error(`${kind}: cancelled`);
  if (res.error) throw new Error(`${kind}: ${res.error}`);
  if (!res.approved || !res.info) throw new Error(`${kind}: no device selected`);
  return { handle: res.handle ?? '', info: res.info };
}
