/**
 * Extension-side WebUSB picker popup launcher.
 *
 * `navigator.usb.requestDevice()` must run inside a user gesture AND
 * inside a normal browser window — the side panel renderer cannot host
 * the chooser reliably. The unified `picker-popup.html` page hosts the
 * chooser; this module is the typed `usb-device` adapter over the shared
 * launcher in `picker-popup.ts`. The popup runs `requestDevice` on its
 * own button-click gesture; the popup posts back identifiers and the
 * caller re-acquires the now-granted device via `navigator.usb.getDevices()`
 * in its own realm.
 */

import type { UsbDeviceFilter } from '../../kernel/usb-device-registry.js';
import { canOpenPickerPopup, type DevicePickerResult, openPickerPopup } from './picker-popup.js';

const POPUP_TIMEOUT_MS = 60_000;

export interface UsbPickerIdentifiers {
  vendorId: number;
  productId: number;
  serialNumber?: string;
}

export type UsbPickerResult =
  | { granted: true; info: UsbPickerIdentifiers }
  | { cancelled: true }
  | { error: string };

/** True when running inside a Chrome extension realm with `chrome.windows`. */
export function canOpenUsbPickerPopup(): boolean {
  return canOpenPickerPopup();
}

/**
 * Open the unified picker popup as `kind=usb-device`, passing the
 * requested filters, and resolve with the popup's posted result. Times
 * out as a cancellation so a forgotten popup doesn't wedge the command.
 */
export function openUsbPickerPopup(filters: UsbDeviceFilter[]): Promise<UsbPickerResult> {
  return new Promise<UsbPickerResult>((resolve) => {
    let settled = false;
    const finish = (result: UsbPickerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ cancelled: true }), POPUP_TIMEOUT_MS);

    // Pass the same budget down so `openPickerPopup` can tear down its
    // `chrome.runtime.onMessage` listener if the popup never posts back.
    openPickerPopup('usb-device', filters ?? [], undefined, { timeoutMs: POPUP_TIMEOUT_MS })
      .then((raw) => {
        const m = raw as DevicePickerResult;
        if (m.cancelled) finish({ cancelled: true });
        else if (typeof m.error === 'string') finish({ error: m.error });
        else if (m.granted && m.info)
          finish({ granted: true, info: m.info as unknown as UsbPickerIdentifiers });
        else finish({ error: 'usb picker returned an unexpected response' });
      })
      .catch((err: unknown) => {
        finish({ error: err instanceof Error ? err.message : 'Failed to open USB picker' });
      });
  });
}
