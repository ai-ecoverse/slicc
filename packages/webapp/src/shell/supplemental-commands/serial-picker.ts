/**
 * Extension-side Web Serial picker popup launcher.
 *
 * `navigator.serial.requestPort()` must run inside a user gesture AND
 * inside a normal browser window — the side panel renderer cannot host
 * the chooser reliably (mirrors `usb-picker.ts`). So the extension
 * `serial request` path opens `serial-picker-popup.html` in a real popup
 * window; the popup runs `requestPort` on its own button-click gesture,
 * which grants the port to the extension origin. The popup posts back
 * the port identifiers; the caller then re-acquires the now-granted port
 * via `navigator.serial.getPorts()` in its own realm.
 */

import type { SerialFilter } from '../../kernel/serial-port-registry.js';

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
  const c = (globalThis as { chrome?: { runtime?: { id?: string }; windows?: unknown } }).chrome;
  return !!c?.runtime?.id && !!c.windows;
}

/**
 * Open `serial-picker-popup.html`, passing the requested filters, and
 * resolve with the popup's posted result. Times out as a cancellation
 * so a forgotten popup doesn't wedge the command.
 */
export function openSerialPickerPopup(filters: SerialFilter[]): Promise<SerialPickerResult> {
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

  const requestId = `serial-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const filtersParam = encodeURIComponent(JSON.stringify(filters ?? []));
  const url = chromeApi.runtime.getURL(
    `serial-picker-popup.html?requestId=${encodeURIComponent(requestId)}&filters=${filtersParam}`
  );

  return new Promise<SerialPickerResult>((resolve) => {
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
      if (m?.source !== 'serial-picker-popup' || m.requestId !== requestId) return;
      cleanup();
      if (m.cancelled) {
        resolve({ cancelled: true });
      } else if (typeof m.error === 'string') {
        resolve({ error: m.error });
      } else if (m.granted && m.info) {
        resolve({ granted: true, info: m.info as SerialPickerIdentifiers });
      } else {
        resolve({ error: 'serial picker returned an unexpected response' });
      }
    };
    chromeApi.runtime.onMessage.addListener(listener);

    chromeApi.windows
      .create({ url, type: 'popup', width: 320, height: 90, focused: true })
      .catch((err: unknown) => {
        cleanup();
        resolve({ error: err instanceof Error ? err.message : 'Failed to open serial picker' });
      });
  });
}
