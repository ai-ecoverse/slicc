/**
 * Extension-side WebHID picker popup launcher.
 *
 * `navigator.hid.requestDevice()` must run inside a user gesture AND
 * inside a normal browser window — the side panel renderer cannot host
 * the chooser reliably (mirrors the `usb-picker` / `mount-popup`
 * rationale). So the extension `hid request` path opens
 * `hid-picker-popup.html` in a real popup window; the popup runs
 * `requestDevice` on its own button-click gesture, which grants the
 * device to the extension origin. The popup posts back the device
 * identifiers; the caller then re-acquires the now-granted device via
 * `navigator.hid.getDevices()` in its own realm.
 */

import type { HidDeviceFilter } from '../../kernel/hid-device-registry.js';

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
  const c = (globalThis as { chrome?: { runtime?: { id?: string }; windows?: unknown } }).chrome;
  return !!c?.runtime?.id && !!c.windows;
}

/**
 * Open `hid-picker-popup.html`, passing the requested filters, and
 * resolve with the popup's posted result. Times out as a cancellation
 * so a forgotten popup doesn't wedge the command.
 */
export function openHidPickerPopup(filters: HidDeviceFilter[]): Promise<HidPickerResult> {
  const chromeApi = (
    globalThis as unknown as {
      chrome: {
        runtime: {
          getURL(path: string): string;
          onMessage: {
            addListener(fn: (msg: unknown) => void): void;
            removeListener(fn: (msg: unknown) => void): void;
          };
        };
        windows: { create(opts: Record<string, unknown>): Promise<unknown> };
      };
    }
  ).chrome;

  const requestId = `hid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const filtersParam = encodeURIComponent(JSON.stringify(filters ?? []));
  const url = chromeApi.runtime.getURL(
    `hid-picker-popup.html?requestId=${encodeURIComponent(requestId)}&filters=${filtersParam}`
  );

  return new Promise<HidPickerResult>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      chromeApi.runtime.onMessage.removeListener(listener);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve({ cancelled: true });
    }, POPUP_TIMEOUT_MS);

    const listener = (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      if (m?.source !== 'hid-picker-popup' || m.requestId !== requestId) return;
      cleanup();
      if (m.cancelled) {
        resolve({ cancelled: true });
      } else if (typeof m.error === 'string') {
        resolve({ error: m.error });
      } else if (m.granted && m.info) {
        resolve({ granted: true, info: m.info as HidPickerIdentifiers });
      } else {
        resolve({ error: 'hid picker returned an unexpected response' });
      }
    };
    chromeApi.runtime.onMessage.addListener(listener);

    chromeApi.windows
      .create({ url, type: 'popup', width: 320, height: 90, focused: true })
      .catch((err: unknown) => {
        cleanup();
        resolve({ error: err instanceof Error ? err.message : 'Failed to open HID picker' });
      });
  });
}
