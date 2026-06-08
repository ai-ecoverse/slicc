/**
 * Execution backends for the `usb` shell command.
 *
 * `LocalUsbBackend` runs in a DOM realm (standalone panel terminal,
 * extension side-panel/offscreen shell) and talks to `navigator.usb`
 * directly via the shared `usb-operations` helpers. `BridgedUsbBackend`
 * runs in the kernel worker (no DOM) and forwards every op to the page
 * over panel-RPC. Both expose the same handle-keyed surface returning
 * `Uint8Array` payloads so the command body is backend-agnostic.
 */

import type { PanelRpcClient } from '../../kernel/panel-rpc.js';
import {
  type DeviceHandleRegistry,
  deviceToInfo,
  getNavigatorUsb,
  getSharedUsbRegistry,
  type UsbControlSetup,
  type UsbDevice,
  type UsbDeviceFilter,
  type UsbDeviceInfo,
} from '../../kernel/usb-device-registry.js';
import * as usbOps from '../../kernel/usb-operations.js';
import { canOpenUsbPickerPopup, openUsbPickerPopup } from './usb-picker.js';

export interface TransferInResult {
  status: string;
  bytes: Uint8Array;
}
export interface TransferOutResult {
  status: string;
  bytesWritten: number;
}

export interface UsbBackend {
  list(): Promise<UsbDeviceInfo[]>;
  request(filters: UsbDeviceFilter[]): Promise<UsbDeviceInfo>;
  info(handle: string): Promise<UsbDeviceInfo>;
  open(handle: string): Promise<void>;
  close(handle: string): Promise<void>;
  selectConfig(handle: string, value: number): Promise<void>;
  claim(handle: string, iface: number): Promise<void>;
  release(handle: string, iface: number): Promise<void>;
  controlIn(handle: string, setup: UsbControlSetup, length: number): Promise<TransferInResult>;
  controlOut(handle: string, setup: UsbControlSetup, bytes: Uint8Array): Promise<TransferOutResult>;
  transferIn(handle: string, ep: number, length: number): Promise<TransferInResult>;
  transferOut(handle: string, ep: number, bytes: Uint8Array): Promise<TransferOutResult>;
  reset(handle: string): Promise<void>;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

class LocalUsbBackend implements UsbBackend {
  constructor(private registry: DeviceHandleRegistry) {}
  private usb() {
    const usb = getNavigatorUsb();
    if (!usb) throw new Error('WebUSB is unavailable in this browser');
    return usb;
  }
  list() {
    return usbOps.usbList(this.registry, this.usb());
  }
  async request(filters: UsbDeviceFilter[]): Promise<UsbDeviceInfo> {
    // Extension realms must route the chooser through a popup window;
    // the side panel cannot host `requestDevice` reliably.
    if (canOpenUsbPickerPopup()) {
      const res = await openUsbPickerPopup(filters);
      if ('cancelled' in res) throw new Error('user cancelled the USB picker');
      if ('error' in res) throw new Error(res.error);
      const device = await this.reacquire(res.info);
      if (!device) throw new Error('granted device could not be re-acquired');
      return deviceToInfo(this.registry.register(device), device);
    }
    return usbOps.usbRequest(this.registry, this.usb(), filters);
  }
  private async reacquire(info: {
    vendorId: number;
    productId: number;
    serialNumber?: string;
  }): Promise<UsbDevice | null> {
    const devices = await this.usb().getDevices();
    const match = devices.find(
      (d) =>
        d.vendorId === info.vendorId &&
        d.productId === info.productId &&
        (info.serialNumber ? d.serialNumber === info.serialNumber : true)
    );
    return match ?? null;
  }
  info(handle: string) {
    return Promise.resolve(usbOps.usbDeviceInfo(this.registry, handle));
  }
  open(handle: string) {
    return usbOps.usbOpen(this.registry, handle);
  }
  close(handle: string) {
    return usbOps.usbClose(this.registry, handle);
  }
  selectConfig(handle: string, value: number) {
    return usbOps.usbSelectConfiguration(this.registry, handle, value);
  }
  claim(handle: string, iface: number) {
    return usbOps.usbClaimInterface(this.registry, handle, iface);
  }
  release(handle: string, iface: number) {
    return usbOps.usbReleaseInterface(this.registry, handle, iface);
  }
  async controlIn(handle: string, setup: UsbControlSetup, length: number) {
    const r = await usbOps.usbControlTransferIn(this.registry, handle, setup, length);
    return { status: r.status, bytes: new Uint8Array(r.bytes) };
  }
  controlOut(handle: string, setup: UsbControlSetup, bytes: Uint8Array) {
    return usbOps.usbControlTransferOut(this.registry, handle, setup, toArrayBuffer(bytes));
  }
  async transferIn(handle: string, ep: number, length: number) {
    const r = await usbOps.usbTransferIn(this.registry, handle, ep, length);
    return { status: r.status, bytes: new Uint8Array(r.bytes) };
  }
  transferOut(handle: string, ep: number, bytes: Uint8Array) {
    return usbOps.usbTransferOut(this.registry, handle, ep, toArrayBuffer(bytes));
  }
  reset(handle: string) {
    return usbOps.usbReset(this.registry, handle);
  }
}

class BridgedUsbBackend implements UsbBackend {
  constructor(private rpc: PanelRpcClient) {}
  // The picker can take many seconds while the user chooses a device,
  // so the request op gets a generous timeout.
  private static REQUEST_TIMEOUT_MS = 5 * 60_000;

  async list() {
    return (await this.rpc.call('usb-list', undefined)).devices;
  }
  async request(filters: UsbDeviceFilter[]) {
    return (
      await this.rpc.call(
        'usb-request',
        { filters },
        { timeoutMs: BridgedUsbBackend.REQUEST_TIMEOUT_MS }
      )
    ).device;
  }
  async info(handle: string) {
    return (await this.rpc.call('usb-device-info', { handle })).device;
  }
  async open(handle: string) {
    await this.rpc.call('usb-open', { handle });
  }
  async close(handle: string) {
    await this.rpc.call('usb-close', { handle });
  }
  async selectConfig(handle: string, value: number) {
    await this.rpc.call('usb-select-configuration', { handle, configurationValue: value });
  }
  async claim(handle: string, iface: number) {
    await this.rpc.call('usb-claim-interface', { handle, interfaceNumber: iface });
  }
  async release(handle: string, iface: number) {
    await this.rpc.call('usb-release-interface', { handle, interfaceNumber: iface });
  }
  async controlIn(handle: string, setup: UsbControlSetup, length: number) {
    const r = await this.rpc.call('usb-control-transfer-in', { handle, setup, length });
    return { status: r.status, bytes: new Uint8Array(r.bytes) };
  }
  async controlOut(handle: string, setup: UsbControlSetup, bytes: Uint8Array) {
    return this.rpc.call('usb-control-transfer-out', {
      handle,
      setup,
      bytes: toArrayBuffer(bytes),
    });
  }
  async transferIn(handle: string, ep: number, length: number) {
    const r = await this.rpc.call('usb-transfer-in', { handle, endpointNumber: ep, length });
    return { status: r.status, bytes: new Uint8Array(r.bytes) };
  }
  async transferOut(handle: string, ep: number, bytes: Uint8Array) {
    return this.rpc.call('usb-transfer-out', {
      handle,
      endpointNumber: ep,
      bytes: toArrayBuffer(bytes),
    });
  }
  async reset(handle: string) {
    await this.rpc.call('usb-reset', { handle });
  }
}

/**
 * Pick the backend for the current realm: the local `navigator.usb`
 * path when a DOM is present, otherwise the panel-RPC bridge. Returns
 * `null` when neither is available (e.g. a worker with no bridge).
 */
export function resolveUsbBackend(
  hasLocalDom: boolean,
  panelRpc: PanelRpcClient | null
): UsbBackend | null {
  if (hasLocalDom && getNavigatorUsb()) {
    return new LocalUsbBackend(getSharedUsbRegistry());
  }
  if (panelRpc) {
    return new BridgedUsbBackend(panelRpc);
  }
  return null;
}
