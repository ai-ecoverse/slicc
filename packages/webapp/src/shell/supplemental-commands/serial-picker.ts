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

export function canOpenSerialPickerPopup(): boolean {
  return canOpenPickerPopup();
}

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
