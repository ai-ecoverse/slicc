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

export function canOpenHidPickerPopup(): boolean {
  return canOpenPickerPopup();
}

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
