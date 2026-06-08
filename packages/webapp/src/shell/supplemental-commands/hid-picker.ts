/**
 * Extension-side WebHID picker popup launcher.
 *
 * `navigator.hid.requestDevice()` must run inside a user gesture AND
 * inside a normal browser window — the side panel renderer cannot host
 * the chooser reliably. The unified `picker-popup.html` page hosts the
 * chooser; this module is the typed `hid-device` adapter over the
 * shared launcher in `picker-popup.ts`. The popup runs `requestDevice`
 * on its own button-click gesture; the popup posts back identifiers and
 * the caller re-acquires the now-granted device via `navigator.hid.getDevices()`
 * in its own realm.
 */

import type { HidDeviceFilter } from '../../kernel/hid-device-registry.js';
import { canOpenPickerPopup, type DevicePickerResult, openPickerPopup } from './picker-popup.js';

const POPUP_TIMEOUT_MS = 60_000;

export interface HidPickerIdentifiers {
  vendorId: number;
  productId: number;
}

export type HidPickerResult =
  | { granted: true; info: HidPickerIdentifiers }
  | { cancelled: true }
  | { error: string };

/** True when running inside a Chrome extension realm with `chrome.windows`. */
export function canOpenHidPickerPopup(): boolean {
  return canOpenPickerPopup();
}

/**
 * Open the unified picker popup as `kind=hid-device`, passing the
 * requested filters, and resolve with the popup's posted result. Times
 * out as a cancellation so a forgotten popup doesn't wedge the command.
 */
export function openHidPickerPopup(filters: HidDeviceFilter[]): Promise<HidPickerResult> {
  return new Promise<HidPickerResult>((resolve) => {
    let settled = false;
    const finish = (result: HidPickerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ cancelled: true }), POPUP_TIMEOUT_MS);

    // Pass the same budget down so `openPickerPopup` can tear down its
    // `chrome.runtime.onMessage` listener if the popup never posts back.
    openPickerPopup('hid-device', filters ?? [], undefined, { timeoutMs: POPUP_TIMEOUT_MS })
      .then((raw) => {
        const m = raw as DevicePickerResult;
        if (m.cancelled) finish({ cancelled: true });
        else if (typeof m.error === 'string') finish({ error: m.error });
        else if (m.granted && m.info)
          finish({ granted: true, info: m.info as unknown as HidPickerIdentifiers });
        else finish({ error: 'hid picker returned an unexpected response' });
      })
      .catch((err: unknown) => {
        finish({ error: err instanceof Error ? err.message : 'Failed to open HID picker' });
      });
  });
}
