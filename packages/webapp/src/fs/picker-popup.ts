import { isExtensionRealm } from '../base/runtime-env.js';

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

const PICKER_KIND_CONFIG: Record<PickerKind, PickerKindConfig> = {
  directory: { width: 320, height: 120 },
  'usb-device': { width: 320, height: 120 },
  'serial-port': { width: 320, height: 120 },
  'hid-device': { width: 320, height: 120 },
};

export interface DirectoryPickerResult {
  handleInIdb?: boolean;
  idbKey?: string;
  dirName?: string;
  cancelled?: boolean;
  error?: string;
}

export interface DevicePickerInfo {
  vendorId?: number;
  productId?: number;
  usbVendorId?: number;
  usbProductId?: number;
  serialNumber?: string;
}

export interface DevicePickerResult {
  granted?: boolean;
  info?: DevicePickerInfo;
  cancelled?: boolean;
  error?: string;
}

export type PickerPopupResult = DirectoryPickerResult | DevicePickerResult;

interface ChromeWindowCreateOptions {
  url: string;
  type?: 'popup' | 'normal' | 'panel' | 'app' | 'devtools';
  width?: number;
  height?: number;
  focused?: boolean;
}

interface ChromeWindowsApi {
  create?: (opts: ChromeWindowCreateOptions) => Promise<{ id?: number }>;
  onRemoved?: {
    addListener: (l: (windowId: number) => void) => void;
    removeListener: (l: (windowId: number) => void) => void;
  };
}

interface ChromeRuntimeApi {
  id?: string;
  onMessage?: {
    addListener: (l: (msg: unknown) => void) => void;
    removeListener: (l: (msg: unknown) => void) => void;
  };
  getURL?: (path: string) => string;
}

function getChromeApis(): {
  windows?: ChromeWindowsApi;
  runtime?: ChromeRuntimeApi;
} | null {
  const c = (globalThis as { chrome?: unknown }).chrome as
    | {
        windows?: ChromeWindowsApi;
        runtime?: ChromeRuntimeApi;
      }
    | undefined;
  return c ?? null;
}

export interface OpenPickerPopupOptions {
  timeoutMs?: number;
}

export function canOpenPickerPopup(): boolean {
  const chromeApis = getChromeApis();
  return isExtensionRealm() && typeof chromeApis?.windows?.create === 'function';
}

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
  const getURL = chromeApis.runtime.getURL?.bind(chromeApis.runtime);

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
      } catch {}
      if (onWindowRemoved && windowRemovedHandler) {
        try {
          onWindowRemoved.removeListener(windowRemovedHandler);
        } catch {}
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
