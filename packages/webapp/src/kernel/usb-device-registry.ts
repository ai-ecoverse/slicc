/**
 * Shared WebUSB device-handle registry.
 *
 * `USBDevice` objects are non-serializable, so they can never cross a
 * `postMessage` / `BroadcastChannel` boundary. The kernel worker (no
 * DOM) drives WebUSB through the panel-RPC bridge using opaque string
 * handles; this registry maps those handles to the live `USBDevice`
 * instances on the DOM side (standalone page or extension realm).
 *
 * The registry is a per-realm singleton (`getSharedUsbRegistry`) so the
 * gesture-bridge code in `remote-terminal-view.ts` and the panel-RPC
 * handlers in `ui/panel-rpc-handlers.ts` share one map.
 *
 * Minimal WebUSB types are declared here because `lib.dom.d.ts` does
 * not ship them; only the surface the `usb` command uses is modeled.
 */

export interface UsbControlSetup {
  requestType: 'standard' | 'class' | 'vendor';
  recipient: 'device' | 'interface' | 'endpoint' | 'other';
  request: number;
  value: number;
  index: number;
}

export interface UsbDeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}

export interface UsbInTransferResult {
  data?: { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  status?: string;
}

export interface UsbOutTransferResult {
  bytesWritten: number;
  status?: string;
}

/** The subset of `USBDevice` the registry and handlers touch. */
export interface UsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly manufacturerName?: string;
  readonly serialNumber?: string;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  controlTransferIn(setup: UsbControlSetup, length: number): Promise<UsbInTransferResult>;
  controlTransferOut(setup: UsbControlSetup, data?: BufferSource): Promise<UsbOutTransferResult>;
  transferIn(endpointNumber: number, length: number): Promise<UsbInTransferResult>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<UsbOutTransferResult>;
  reset(): Promise<void>;
}

/** The subset of `navigator.usb` the registry helpers use. */
export interface UsbApi {
  getDevices(): Promise<UsbDevice[]>;
  requestDevice(options: { filters: UsbDeviceFilter[] }): Promise<UsbDevice>;
}

/** Serializable device descriptor returned across the bridge. */
export interface UsbDeviceInfo {
  handle: string;
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  opened: boolean;
}

/** Read `navigator.usb` from the current realm, or null when absent. */
export function getNavigatorUsb(): UsbApi | null {
  const nav = (globalThis as { navigator?: { usb?: UsbApi } }).navigator;
  return nav?.usb ?? null;
}

function sameDevice(a: UsbDevice, b: UsbDevice): boolean {
  if (a === b) return true;
  return (
    a.vendorId === b.vendorId &&
    a.productId === b.productId &&
    (a.serialNumber ?? '') === (b.serialNumber ?? '') &&
    !!a.serialNumber
  );
}

/** In-memory `handle → USBDevice` map for a single DOM realm. */
export class DeviceHandleRegistry {
  private byHandle = new Map<string, UsbDevice>();
  private counter = 0;

  /** Register a device, returning a stable handle (dedupes re-grants). */
  register(device: UsbDevice): string {
    for (const [handle, existing] of this.byHandle) {
      if (sameDevice(existing, device)) {
        // Refresh to the latest object so `opened` state stays current.
        this.byHandle.set(handle, device);
        return handle;
      }
    }
    const handle = `usb${++this.counter}`;
    this.byHandle.set(handle, device);
    return handle;
  }

  get(handle: string): UsbDevice | undefined {
    return this.byHandle.get(handle);
  }

  remove(handle: string): boolean {
    return this.byHandle.delete(handle);
  }

  list(): Array<{ handle: string; device: UsbDevice }> {
    return [...this.byHandle].map(([handle, device]) => ({ handle, device }));
  }
}

let sharedRegistry: DeviceHandleRegistry | null = null;

/** The per-realm shared registry instance. */
export function getSharedUsbRegistry(): DeviceHandleRegistry {
  if (!sharedRegistry) sharedRegistry = new DeviceHandleRegistry();
  return sharedRegistry;
}

/** Maximum bytes for a single control/bulk transfer (v1 cap). */
export const MAX_USB_TRANSFER_BYTES = 4 * 1024 * 1024;

/** Build the serializable descriptor for a registered device. */
export function deviceToInfo(handle: string, device: UsbDevice): UsbDeviceInfo {
  return {
    handle,
    vendorId: device.vendorId,
    productId: device.productId,
    ...(device.productName ? { productName: device.productName } : {}),
    ...(device.manufacturerName ? { manufacturerName: device.manufacturerName } : {}),
    ...(device.serialNumber ? { serialNumber: device.serialNumber } : {}),
    opened: device.opened,
  };
}
