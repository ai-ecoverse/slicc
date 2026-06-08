/**
 * Pure WebUSB operations over a {@link DeviceHandleRegistry}.
 *
 * Shared by the page-side panel-RPC handlers (`ui/panel-rpc-handlers.ts`)
 * and the local-DOM backend of the `usb` shell command so both code
 * paths apply identical handle resolution, the 4 MiB transfer cap, and
 * the same serializable result shapes. Every transfer result returns an
 * `ArrayBuffer` so it postMessages cleanly across the bridge; callers
 * wrap it in a `Uint8Array` as needed.
 */

import {
  type DeviceHandleRegistry,
  deviceToInfo,
  MAX_USB_TRANSFER_BYTES,
  type UsbApi,
  type UsbControlSetup,
  type UsbDevice,
  type UsbDeviceFilter,
  type UsbDeviceInfo,
} from './usb-device-registry.js';

function resolve(registry: DeviceHandleRegistry, handle: string): UsbDevice {
  const device = registry.get(handle);
  if (!device) throw new Error(`unknown usb handle '${handle}'`);
  return device;
}

function assertSize(length: number, what: string): void {
  if (length > MAX_USB_TRANSFER_BYTES) {
    throw new Error(`${what} exceeds the ${MAX_USB_TRANSFER_BYTES}-byte (4 MiB) v1 limit`);
  }
}

function toArrayBuffer(result: { buffer: ArrayBuffer; byteOffset: number; byteLength: number }) {
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
}

export async function usbList(
  registry: DeviceHandleRegistry,
  usb: UsbApi
): Promise<UsbDeviceInfo[]> {
  const devices = await usb.getDevices();
  return devices.map((d) => deviceToInfo(registry.register(d), d));
}

export async function usbRequest(
  registry: DeviceHandleRegistry,
  usb: UsbApi,
  filters: UsbDeviceFilter[]
): Promise<UsbDeviceInfo> {
  const device = await usb.requestDevice({ filters });
  return deviceToInfo(registry.register(device), device);
}

export function usbDeviceInfo(registry: DeviceHandleRegistry, handle: string): UsbDeviceInfo {
  return deviceToInfo(handle, resolve(registry, handle));
}

export async function usbOpen(registry: DeviceHandleRegistry, handle: string): Promise<void> {
  await resolve(registry, handle).open();
}

export async function usbClose(registry: DeviceHandleRegistry, handle: string): Promise<void> {
  await resolve(registry, handle).close();
}

export async function usbSelectConfiguration(
  registry: DeviceHandleRegistry,
  handle: string,
  configurationValue: number
): Promise<void> {
  await resolve(registry, handle).selectConfiguration(configurationValue);
}

export async function usbClaimInterface(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number
): Promise<void> {
  await resolve(registry, handle).claimInterface(interfaceNumber);
}

export async function usbReleaseInterface(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number
): Promise<void> {
  await resolve(registry, handle).releaseInterface(interfaceNumber);
}

export async function usbControlTransferIn(
  registry: DeviceHandleRegistry,
  handle: string,
  setup: UsbControlSetup,
  length: number
): Promise<{ status: string; bytes: ArrayBuffer }> {
  assertSize(length, 'control-in length');
  const result = await resolve(registry, handle).controlTransferIn(setup, length);
  return {
    status: result.status ?? 'ok',
    bytes: result.data ? toArrayBuffer(result.data) : new ArrayBuffer(0),
  };
}

export async function usbControlTransferOut(
  registry: DeviceHandleRegistry,
  handle: string,
  setup: UsbControlSetup,
  bytes: ArrayBuffer
): Promise<{ status: string; bytesWritten: number }> {
  assertSize(bytes.byteLength, 'control-out payload');
  const result = await resolve(registry, handle).controlTransferOut(setup, bytes);
  return { status: result.status ?? 'ok', bytesWritten: result.bytesWritten };
}

export async function usbTransferIn(
  registry: DeviceHandleRegistry,
  handle: string,
  endpointNumber: number,
  length: number
): Promise<{ status: string; bytes: ArrayBuffer }> {
  assertSize(length, 'transfer-in length');
  const result = await resolve(registry, handle).transferIn(endpointNumber, length);
  return {
    status: result.status ?? 'ok',
    bytes: result.data ? toArrayBuffer(result.data) : new ArrayBuffer(0),
  };
}

export async function usbTransferOut(
  registry: DeviceHandleRegistry,
  handle: string,
  endpointNumber: number,
  bytes: ArrayBuffer
): Promise<{ status: string; bytesWritten: number }> {
  assertSize(bytes.byteLength, 'transfer-out payload');
  const result = await resolve(registry, handle).transferOut(endpointNumber, bytes);
  return { status: result.status ?? 'ok', bytesWritten: result.bytesWritten };
}

export async function usbReset(registry: DeviceHandleRegistry, handle: string): Promise<void> {
  await resolve(registry, handle).reset();
}
