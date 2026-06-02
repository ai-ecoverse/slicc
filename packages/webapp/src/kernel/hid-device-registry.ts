/**
 * Shared WebHID device-handle registry.
 *
 * `HIDDevice` objects are non-serializable, so they can never cross a
 * `postMessage` / `BroadcastChannel` boundary. The kernel worker (no
 * DOM) drives WebHID through the panel-RPC bridge using opaque string
 * handles; this registry maps those handles to the live `HIDDevice`
 * instances on the DOM side (standalone page or extension realm).
 *
 * Mirrors `usb-device-registry.ts`. The registry is a per-realm
 * singleton (`getSharedHidRegistry`) so the gesture-bridge code in
 * `remote-terminal-view.ts` and the panel-RPC handlers in
 * `ui/panel-rpc-handlers.ts` share one map.
 *
 * Minimal WebHID types are declared here because `lib.dom.d.ts` does
 * not ship them; only the surface the `hid` command uses is modeled.
 */

export interface HidDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

/** An `inputreport` event delivered by an `HIDDevice`. */
export interface HidInputReportEvent {
  device: HidDevice;
  reportId: number;
  data: DataView;
}

/** The subset of `HIDDevice` the registry and handlers touch. */
export interface HidDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener(type: 'inputreport', listener: (ev: HidInputReportEvent) => void): void;
  removeEventListener(type: 'inputreport', listener: (ev: HidInputReportEvent) => void): void;
}

/** The subset of `navigator.hid` the registry helpers use. */
export interface HidApi {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: { filters: HidDeviceFilter[] }): Promise<HidDevice[]>;
}

/** Serializable device descriptor returned across the bridge. */
export interface HidDeviceInfo {
  handle: string;
  vendorId: number;
  productId: number;
  productName?: string;
  opened: boolean;
}

/** Read `navigator.hid` from the current realm, or null when absent. */
export function getNavigatorHid(): HidApi | null {
  const nav = (globalThis as { navigator?: { hid?: HidApi } }).navigator;
  return nav?.hid ?? null;
}

function sameDevice(a: HidDevice, b: HidDevice): boolean {
  if (a === b) return true;
  // WebHID exposes no serial number, so value-equality is best-effort:
  // dedupe devices sharing vendor/product/productName (a documented v1
  // limitation — two identical units may share a handle). Reference
  // identity above covers the common case where the browser returns
  // stable `HIDDevice` objects across `getDevices()` calls.
  return (
    a.vendorId === b.vendorId &&
    a.productId === b.productId &&
    (a.productName ?? '') === (b.productName ?? '') &&
    !!a.productName
  );
}

/** In-memory `handle → HIDDevice` map for a single DOM realm. */
export class HidDeviceHandleRegistry {
  private byHandle = new Map<string, HidDevice>();
  private counter = 0;

  /** Register a device, returning a stable handle (dedupes re-grants). */
  register(device: HidDevice): string {
    for (const [handle, existing] of this.byHandle) {
      if (sameDevice(existing, device)) {
        // Refresh to the latest object so `opened` state stays current.
        this.byHandle.set(handle, device);
        return handle;
      }
    }
    const handle = `hid${++this.counter}`;
    this.byHandle.set(handle, device);
    return handle;
  }

  get(handle: string): HidDevice | undefined {
    return this.byHandle.get(handle);
  }

  remove(handle: string): boolean {
    return this.byHandle.delete(handle);
  }

  list(): Array<{ handle: string; device: HidDevice }> {
    return [...this.byHandle].map(([handle, device]) => ({ handle, device }));
  }
}

let sharedRegistry: HidDeviceHandleRegistry | null = null;

/** The per-realm shared registry instance. */
export function getSharedHidRegistry(): HidDeviceHandleRegistry {
  if (!sharedRegistry) sharedRegistry = new HidDeviceHandleRegistry();
  return sharedRegistry;
}

/** Maximum bytes for a single report (v1 cap, mirrors WebUSB). */
export const MAX_HID_REPORT_BYTES = 4 * 1024 * 1024;

/** Build the serializable descriptor for a registered device. */
export function hidDeviceToInfo(handle: string, device: HidDevice): HidDeviceInfo {
  return {
    handle,
    vendorId: device.vendorId,
    productId: device.productId,
    ...(device.productName ? { productName: device.productName } : {}),
    opened: device.opened,
  };
}
