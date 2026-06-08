/**
 * Extension-side Web Serial picker popup launcher.
 *
 * `navigator.serial.requestPort()` must run inside a user gesture AND
 * inside a normal browser window — the side panel renderer cannot host
 * the chooser reliably. The unified `picker-popup.html` page hosts the
 * chooser; this module is the typed `serial-port` adapter over the
 * shared launcher in `picker-popup.ts`. The popup runs `requestPort` on
 * its own button-click gesture; the popup posts back identifiers and the
 * caller re-acquires the now-granted port via `navigator.serial.getPorts()`
 * in its own realm.
 */

import type { SerialFilter } from '../../kernel/serial-port-registry.js';
import { canOpenPickerPopup, type DevicePickerResult, openPickerPopup } from './picker-popup.js';

const POPUP_TIMEOUT_MS = 60_000;

export interface SerialPickerIdentifiers {
  usbVendorId?: number;
  usbProductId?: number;
}

export type SerialPickerResult =
  | { granted: true; info: SerialPickerIdentifiers }
  | { cancelled: true }
  | { error: string };

/** True when running inside a Chrome extension realm with `chrome.windows`. */
export function canOpenSerialPickerPopup(): boolean {
  return canOpenPickerPopup();
}

/**
 * Open the unified picker popup as `kind=serial-port`, passing the
 * requested filters, and resolve with the popup's posted result. Times
 * out as a cancellation so a forgotten popup doesn't wedge the command.
 */
export function openSerialPickerPopup(filters: SerialFilter[]): Promise<SerialPickerResult> {
  return new Promise<SerialPickerResult>((resolve) => {
    let settled = false;
    const finish = (result: SerialPickerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ cancelled: true }), POPUP_TIMEOUT_MS);

    // Pass the same budget down so `openPickerPopup` can tear down its
    // `chrome.runtime.onMessage` listener if the popup never posts back.
    openPickerPopup('serial-port', filters ?? [], undefined, { timeoutMs: POPUP_TIMEOUT_MS })
      .then((raw) => {
        const m = raw as DevicePickerResult;
        if (m.cancelled) finish({ cancelled: true });
        else if (typeof m.error === 'string') finish({ error: m.error });
        else if (m.granted && m.info)
          finish({ granted: true, info: m.info as unknown as SerialPickerIdentifiers });
        else finish({ error: 'serial picker returned an unexpected response' });
      })
      .catch((err: unknown) => {
        finish({ error: err instanceof Error ? err.message : 'Failed to open serial picker' });
      });
  });
}
