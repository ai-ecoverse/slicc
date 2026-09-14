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

export function canOpenUsbPickerPopup(): boolean {
  return canOpenPickerPopup();
}

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
