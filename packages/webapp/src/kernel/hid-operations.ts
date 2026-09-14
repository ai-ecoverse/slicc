import {
  type HidApi,
  type HidDevice,
  type HidDeviceFilter,
  type HidDeviceHandleRegistry,
  type HidDeviceInfo,
  type HidInputReportEvent,
  hidDeviceToInfo,
  MAX_HID_REPORT_BYTES,
} from './hid-device-registry.js';

function resolve(registry: HidDeviceHandleRegistry, handle: string): HidDevice {
  const device = registry.get(handle);
  if (!device) throw new Error(`unknown hid handle '${handle}'`);
  return device;
}

async function ensureOpen(device: HidDevice): Promise<void> {
  if (!device.opened) await device.open();
}

function assertSize(length: number, what: string): void {
  if (length > MAX_HID_REPORT_BYTES) {
    throw new Error(`${what} exceeds the ${MAX_HID_REPORT_BYTES}-byte (4 MiB) v1 limit`);
  }
}

function dataViewToArrayBuffer(view: DataView): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return out;
}

export async function hidList(
  registry: HidDeviceHandleRegistry,
  hid: HidApi
): Promise<HidDeviceInfo[]> {
  const devices = await hid.getDevices();
  return devices.map((d) => hidDeviceToInfo(registry.register(d), d));
}

export async function hidRequest(
  registry: HidDeviceHandleRegistry,
  hid: HidApi,
  filters: HidDeviceFilter[]
): Promise<HidDeviceInfo[]> {
  const devices = await hid.requestDevice({ filters });
  if (devices.length === 0) throw new Error('No device selected.');
  return devices.map((d) => hidDeviceToInfo(registry.register(d), d));
}

export function hidDeviceInfo(registry: HidDeviceHandleRegistry, handle: string): HidDeviceInfo {
  return hidDeviceToInfo(handle, resolve(registry, handle));
}

export async function hidOpen(registry: HidDeviceHandleRegistry, handle: string): Promise<void> {
  await resolve(registry, handle).open();
}

export async function hidClose(registry: HidDeviceHandleRegistry, handle: string): Promise<void> {
  await resolve(registry, handle).close();
}

export async function hidSendReport(
  registry: HidDeviceHandleRegistry,
  handle: string,
  reportId: number,
  bytes: ArrayBuffer
): Promise<void> {
  assertSize(bytes.byteLength, 'send report payload');
  const device = resolve(registry, handle);
  await ensureOpen(device);
  await device.sendReport(reportId, bytes);
}

export async function hidSendFeatureReport(
  registry: HidDeviceHandleRegistry,
  handle: string,
  reportId: number,
  bytes: ArrayBuffer
): Promise<void> {
  assertSize(bytes.byteLength, 'send feature report payload');
  const device = resolve(registry, handle);
  await ensureOpen(device);
  await device.sendFeatureReport(reportId, bytes);
}

export async function hidReceiveFeatureReport(
  registry: HidDeviceHandleRegistry,
  handle: string,
  reportId: number
): Promise<{ reportId: number; bytes: ArrayBuffer }> {
  const device = resolve(registry, handle);
  await ensureOpen(device);
  const view = await device.receiveFeatureReport(reportId);
  return { reportId, bytes: dataViewToArrayBuffer(view) };
}

export async function hidSubscribeInputReports(
  registry: HidDeviceHandleRegistry,
  handle: string,
  onReport: (report: { reportId: number; bytes: ArrayBuffer }) => void
): Promise<() => void> {
  const device = resolve(registry, handle);
  await ensureOpen(device);
  const listener = (ev: HidInputReportEvent) => {
    onReport({ reportId: ev.reportId, bytes: dataViewToArrayBuffer(ev.data) });
  };
  device.addEventListener('inputreport', listener);
  return () => device.removeEventListener('inputreport', listener);
}
