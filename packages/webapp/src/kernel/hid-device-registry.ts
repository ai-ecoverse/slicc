export interface HidDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

export interface HidInputReportEvent {
  device: HidDevice;
  reportId: number;
  data: DataView;
}

export interface HidCollectionInfo {
  usagePage?: number;
  usage?: number;
}

export interface HidDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly opened: boolean;
  readonly collections?: ReadonlyArray<HidCollectionInfo>;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener(type: 'inputreport', listener: (ev: HidInputReportEvent) => void): void;
  removeEventListener(type: 'inputreport', listener: (ev: HidInputReportEvent) => void): void;
}

export interface HidApi {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: { filters: HidDeviceFilter[] }): Promise<HidDevice[]>;
}

export interface HidDeviceInfo {
  handle: string;
  vendorId: number;
  productId: number;
  productName?: string;
  usagePage?: number;
  usage?: number;
  opened: boolean;
}

export function getNavigatorHid(): HidApi | null {
  const nav = (globalThis as { navigator?: { hid?: HidApi } }).navigator;
  return nav?.hid ?? null;
}

function firstUsageKey(device: HidDevice): string {
  const c = device.collections?.[0];
  if (!c) return '';
  return `${c.usagePage ?? ''}:${c.usage ?? ''}`;
}

function sameDevice(a: HidDevice, b: HidDevice): boolean {
  if (a === b) return true;

  return (
    a.vendorId === b.vendorId &&
    a.productId === b.productId &&
    (a.productName ?? '') === (b.productName ?? '') &&
    firstUsageKey(a) === firstUsageKey(b) &&
    !!a.productName
  );
}

export class HidDeviceHandleRegistry {
  private byHandle = new Map<string, HidDevice>();
  private counter = 0;

  register(device: HidDevice): string {
    for (const [handle, existing] of this.byHandle) {
      if (sameDevice(existing, device)) {
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

export function getSharedHidRegistry(): HidDeviceHandleRegistry {
  if (!sharedRegistry) sharedRegistry = new HidDeviceHandleRegistry();
  return sharedRegistry;
}

export const MAX_HID_REPORT_BYTES = 4 * 1024 * 1024;

export function hidDeviceToInfo(handle: string, device: HidDevice): HidDeviceInfo {
  const first = device.collections?.[0];
  return {
    handle,
    vendorId: device.vendorId,
    productId: device.productId,
    ...(device.productName ? { productName: device.productName } : {}),
    ...(first?.usagePage !== undefined ? { usagePage: first.usagePage } : {}),
    ...(first?.usage !== undefined ? { usage: first.usage } : {}),
    opened: device.opened,
  };
}
