/**
 * Pure WebHID operations over a {@link HidDeviceHandleRegistry}.
 *
 * Shared by the page-side panel-RPC handlers (`ui/panel-rpc-handlers.ts`)
 * and the local-DOM backend of the `hid` shell command so both code
 * paths apply identical handle resolution, the 4 MiB report cap, and
 * the same serializable result shapes. Report payloads are exchanged as
 * `ArrayBuffer`s so they postMessage cleanly across the bridge; callers
 * wrap them in a `Uint8Array` as needed.
 */

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

function assertSize(length: number, what: string): void {
  if (length > MAX_HID_REPORT_BYTES) {
    throw new Error(`${what} exceeds the ${MAX_HID_REPORT_BYTES}-byte (4 MiB) v1 limit`);
  }
}

function dataViewToArrayBuffer(view: DataView): ArrayBuffer {
  // `DataView.buffer` is `ArrayBufferLike`, so a plain `.slice()` widens
  // to `ArrayBuffer | SharedArrayBuffer`. Copy into a fresh `ArrayBuffer`
  // so the bridge always gets a transferable, non-shared buffer.
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
): Promise<HidDeviceInfo> {
  // Unlike WebUSB, `requestDevice` resolves with an ARRAY of granted
  // devices (a single chooser pick can map to multiple HID interfaces).
  // v1 takes the first; an empty array means the user cancelled.
  const devices = await hid.requestDevice({ filters });
  const device = devices[0];
  if (!device) throw new Error('No device selected.');
  return hidDeviceToInfo(registry.register(device), device);
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
  await resolve(registry, handle).sendReport(reportId, bytes);
}

export async function hidSendFeatureReport(
  registry: HidDeviceHandleRegistry,
  handle: string,
  reportId: number,
  bytes: ArrayBuffer
): Promise<void> {
  assertSize(bytes.byteLength, 'send feature report payload');
  await resolve(registry, handle).sendFeatureReport(reportId, bytes);
}

export async function hidReceiveFeatureReport(
  registry: HidDeviceHandleRegistry,
  handle: string,
  reportId: number
): Promise<{ reportId: number; bytes: ArrayBuffer }> {
  const view = await resolve(registry, handle).receiveFeatureReport(reportId);
  return { reportId, bytes: dataViewToArrayBuffer(view) };
}

/**
 * Attach an `inputreport` listener to a device, returning an
 * unsubscribe. The local backend uses this directly; the page-side
 * panel-RPC handler uses it to fan input reports back over the bridge
 * event channel. Report data is normalized to an `ArrayBuffer`.
 */
export function hidSubscribeInputReports(
  registry: HidDeviceHandleRegistry,
  handle: string,
  onReport: (report: { reportId: number; bytes: ArrayBuffer }) => void
): () => void {
  const device = resolve(registry, handle);
  const listener = (ev: HidInputReportEvent) => {
    onReport({ reportId: ev.reportId, bytes: dataViewToArrayBuffer(ev.data) });
  };
  device.addEventListener('inputreport', listener);
  return () => device.removeEventListener('inputreport', listener);
}
