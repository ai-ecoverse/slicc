/**
 * Generic device/directory picker popup launcher (extension float only).
 *
 * The side panel cannot reliably host system pickers — `showDirectoryPicker`
 * crashes the panel under TCC, and `navigator.{usb,serial,hid}.request*`
 * also misbehave inside the panel. Each chooser is hosted in a dedicated
 * popup window (`chrome.windows.create`) that runs the chooser on its own
 * button click, satisfying Chrome's user-gesture rule and posting the
 * outcome back via `chrome.runtime` messaging.
 *
 * All four pickers (mount, usb, serial, hid) share one launcher and one
 * popup page (`picker-popup.html` + `picker-popup.js`) parameterized by
 * `?kind=`. Per-kind config (popup window title, popup window dimensions)
 * lives in {@link PICKER_KIND_CONFIG}.
 *
 * Mount results carry an opaque `{ handleInIdb, idbKey, dirName }` because
 * `FileSystemDirectoryHandle` is non-postable; the popup writes the handle
 * to the shared `slicc-pending-mount` IndexedDB store and the caller pulls
 * it back via `loadAndClearPendingHandle`. Device results carry
 * `{ granted, info }` identifiers; the caller re-acquires the device in
 * its own realm via `navigator.{usb,serial,hid}.getDevices()`.
 */

const log = (() => {
  try {
    return console;
  } catch {
    return undefined;
  }
})();

export type PickerKind = 'directory' | 'usb-device' | 'serial-port' | 'hid-device';

interface PickerKindConfig {
  width: number;
  height: number;
}

/** Per-kind popup window dimensions. Title is set by the popup itself. */
const PICKER_KIND_CONFIG: Record<PickerKind, PickerKindConfig> = {
  directory: { width: 320, height: 120 },
  'usb-device': { width: 320, height: 120 },
  'serial-port': { width: 320, height: 120 },
  'hid-device': { width: 320, height: 120 },
};

/** Mount-kind result. Handle is stored in IDB because it can't postMessage. */
export interface DirectoryPickerResult {
  handleInIdb?: boolean;
  idbKey?: string;
  dirName?: string;
  cancelled?: boolean;
  error?: string;
}

/** Device-kind result (usb/serial/hid). Identifiers only; caller re-acquires. */
export interface DevicePickerResult {
  granted?: boolean;
  info?: Record<string, unknown>;
  cancelled?: boolean;
  error?: string;
}

export type PickerPopupResult = DirectoryPickerResult | DevicePickerResult;

/** Type guard for the extension globals the launcher needs. */
function getChromeApis(): {
  windows?: {
    create?: (opts: Record<string, unknown>) => Promise<{ id?: number }>;
    onRemoved?: {
      addListener: (l: (windowId: number) => void) => void;
      removeListener: (l: (windowId: number) => void) => void;
    };
  };
  runtime?: { id?: string; onMessage?: { addListener: Function; removeListener: Function } };
} | null {
  const c = (globalThis as { chrome?: unknown }).chrome as
    | {
        windows?: {
          create?: (opts: Record<string, unknown>) => Promise<{ id?: number }>;
          onRemoved?: {
            addListener: (l: (windowId: number) => void) => void;
            removeListener: (l: (windowId: number) => void) => void;
          };
        };
        runtime?: {
          id?: string;
          onMessage?: { addListener: Function; removeListener: Function };
          getURL?: (path: string) => string;
        };
      }
    | undefined;
  return c ?? null;
}

export interface OpenPickerPopupOptions {
  /**
   * When the popup doesn't post a result back within this many ms, the
   * `chrome.runtime.onMessage` listener is removed and the promise
   * resolves with `{ cancelled: true }`. Without this safeguard a popup
   * the user closes (or that never reaches its button) leaves the
   * listener installed forever — the per-kind wrappers used to layer
   * their own timeouts on top of this Promise, which kept their outer
   * promises settled but never tore down the inner listener.
   */
  timeoutMs?: number;
}

/**
 * Returns `true` when the extension popup picker can be opened — i.e. we
 * are inside the extension realm AND `chrome.windows.create` is reachable.
 * Used by both the side panel and the in-page tool-ui-renderer to decide
 * whether to dispatch via popup (extension) or run the chooser inline
 * (standalone).
 */
export function canOpenPickerPopup(): boolean {
  const chromeApis = getChromeApis();
  return !!(chromeApis?.runtime?.id && typeof chromeApis.windows?.create === 'function');
}

/**
 * Open the unified picker popup for `kind`, await the popup's result
 * message, and return it. The popup runs the chooser on its own button
 * click (user gesture). `requestId` may be supplied to correlate the
 * round-trip (the mount tool-ui-renderer reuses the showToolUI request
 * id so a stale popup can't race a fresh approval).
 *
 * Throws when the extension launcher is not reachable; callers should
 * gate with {@link canOpenPickerPopup}.
 */
export async function openPickerPopup(
  kind: PickerKind,
  filters: unknown[] = [],
  requestId: string = `picker-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  options: OpenPickerPopupOptions = {}
): Promise<PickerPopupResult> {
  const chromeApis = getChromeApis();
  if (!chromeApis?.runtime?.onMessage || !chromeApis.windows?.create) {
    throw new Error('picker popup: chrome.windows.create not available');
  }
  const onMessage = chromeApis.runtime.onMessage;
  const onWindowRemoved = chromeApis.windows.onRemoved;
  const getURL = (chromeApis.runtime as { getURL?: (path: string) => string }).getURL?.bind(
    chromeApis.runtime
  );

  const dims = PICKER_KIND_CONFIG[kind];
  const filtersJson = encodeURIComponent(JSON.stringify(filters ?? []));
  const params = `kind=${encodeURIComponent(kind)}&requestId=${encodeURIComponent(requestId)}&filters=${filtersJson}`;
  const popupUrl = getURL
    ? `${getURL('picker-popup.html')}?${params}`
    : `picker-popup.html?${params}`;

  return new Promise<PickerPopupResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let popupWindowId: number | undefined;

    const cleanup = () => {
      try {
        onMessage.removeListener(handler);
      } catch {
        /* listener already gone */
      }
      if (onWindowRemoved && windowRemovedHandler) {
        try {
          onWindowRemoved.removeListener(windowRemovedHandler);
        } catch {
          /* listener already gone */
        }
      }
      if (timer !== undefined) clearTimeout(timer);
    };

    const finish = (result: PickerPopupResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handler = (msg: unknown): void => {
      if (settled) return;
      const m = msg as {
        source?: string;
        kind?: string;
        requestId?: string;
      } & PickerPopupResult;
      if (m?.source !== 'picker-popup' || m.kind !== kind || m.requestId !== requestId) return;
      const { source: _s, kind: _k, requestId: _r, ...rest } = m;
      void _s;
      void _k;
      void _r;
      finish(rest as PickerPopupResult);
    };
    onMessage.addListener(handler);

    // Detect user closing the popup window without picking. Browsers that
    // don't expose `chrome.windows.onRemoved` (or the test harness) fall
    // back to the timeout below.
    const windowRemovedHandler = onWindowRemoved
      ? (windowId: number) => {
          if (popupWindowId !== undefined && windowId === popupWindowId) {
            finish({ cancelled: true });
          }
        }
      : undefined;
    if (onWindowRemoved && windowRemovedHandler) {
      onWindowRemoved.addListener(windowRemovedHandler);
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => finish({ cancelled: true }), options.timeoutMs);
    }

    chromeApis.windows!.create!({
      url: popupUrl,
      type: 'popup',
      width: dims.width,
      height: dims.height,
      focused: true,
    })
      .then((win) => {
        if (!win?.id) {
          finish({ error: 'failed to open picker window' });
          return;
        }
        popupWindowId = win.id;
      })
      .catch((err: unknown) => {
        log?.warn?.('picker popup window.create failed', err);
        finish({ error: err instanceof Error ? err.message : String(err) });
      });
  });
}
