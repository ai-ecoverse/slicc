import type { PermissionProviders } from '@slicc/webcomponents';
import { isExtensionRealm } from '../../core/runtime-env.js';

export function isExtensionRuntime(): boolean {
  return isExtensionRealm();
}

export async function buildLeaderPermissionProviders(
  extension: boolean = isExtensionRuntime()
): Promise<PermissionProviders | undefined> {
  if (!extension) return undefined;
  const [
    { openMountPickerPopup, storePendingHandle, loadAndClearPendingHandle },
    usbMod,
    hidMod,
    serialMod,
  ] = await Promise.all([
    import('../../fs/mount-picker-popup.js'),
    import('../../shell/supplemental-commands/usb-picker.js'),
    import('../../shell/supplemental-commands/hid-picker.js'),
    import('../../shell/supplemental-commands/serial-picker.js'),
  ]);
  return {
    filesystem: {
      async showDirectoryPicker(): Promise<FileSystemDirectoryHandle> {
        const result = await openMountPickerPopup();
        if (result.cancelled) {
          throw new DOMException('mount picker cancelled', 'AbortError');
        }
        if (result.error) {
          throw new Error(result.error);
        }
        if (!result.idbKey) {
          throw new Error('mount picker returned no handle key');
        }
        const handle = await loadAndClearPendingHandle(result.idbKey);
        if (!handle) {
          throw new Error('mount picker returned no handle');
        }

        await storePendingHandle(result.idbKey, handle);
        return handle;
      },
    },
    usb: {
      async requestDevice(opts: { filters?: unknown[] }) {
        const res = await usbMod.openUsbPickerPopup(
          (opts?.filters ?? []) as Parameters<typeof usbMod.openUsbPickerPopup>[0]
        );
        if ('cancelled' in res) throw new DOMException('usb picker cancelled', 'AbortError');
        if ('error' in res) throw new Error(res.error);
        const device = await reacquireUsb(res.info);
        if (!device) throw new Error('granted USB device could not be re-acquired');
        return device;
      },
    },
    hid: {
      async requestDevice(opts: { filters?: unknown[] }) {
        const res = await hidMod.openHidPickerPopup(
          (opts?.filters ?? []) as Parameters<typeof hidMod.openHidPickerPopup>[0]
        );
        if ('cancelled' in res) throw new DOMException('hid picker cancelled', 'AbortError');
        if ('error' in res) throw new Error(res.error);
        const devices = await reacquireHidAll(res.info);
        if (devices.length === 0) throw new Error('granted HID device could not be re-acquired');

        return devices;
      },
    },
    serial: {
      async requestPort(opts?: { filters?: unknown[] }) {
        const res = await serialMod.openSerialPickerPopup(
          (opts?.filters ?? []) as Parameters<typeof serialMod.openSerialPickerPopup>[0]
        );
        if ('cancelled' in res) throw new DOMException('serial picker cancelled', 'AbortError');
        if ('error' in res) throw new Error(res.error);
        const port = await reacquireSerial(res.info);
        if (!port) throw new Error('granted serial port could not be re-acquired');
        return port;
      },
    },
  };
}

interface UsbInfo {
  vendorId: number;
  productId: number;
  serialNumber?: string;
}

async function reacquireUsb(info: UsbInfo): Promise<unknown> {
  const { getNavigatorUsb } = await import('../../kernel/usb-device-registry.js');
  const usb = getNavigatorUsb();
  if (!usb) throw new Error('WebUSB is unavailable in this browser');
  const devices = await usb.getDevices();
  return (
    devices.find(
      (d) =>
        d.vendorId === info.vendorId &&
        d.productId === info.productId &&
        (info.serialNumber ? d.serialNumber === info.serialNumber : true)
    ) ?? null
  );
}

async function reacquireHidAll(info: { vendorId: number; productId: number }): Promise<unknown[]> {
  const { getNavigatorHid } = await import('../../kernel/hid-device-registry.js');
  const hid = getNavigatorHid();
  if (!hid) throw new Error('WebHID is unavailable in this browser');
  const devices = await hid.getDevices();
  return devices.filter((d) => d.vendorId === info.vendorId && d.productId === info.productId);
}

async function reacquireSerial(info: {
  usbVendorId?: number;
  usbProductId?: number;
}): Promise<unknown> {
  const { getNavigatorSerial } = await import('../../kernel/serial-port-registry.js');
  const serial = getNavigatorSerial();
  if (!serial) throw new Error('Web Serial is unavailable in this browser');
  const ports = await serial.getPorts();
  const matches = ports.filter((p) => {
    const portInfo = p.getInfo();
    if (info.usbVendorId !== undefined && portInfo.usbVendorId !== info.usbVendorId) return false;
    if (info.usbProductId !== undefined && portInfo.usbProductId !== info.usbProductId)
      return false;
    return true;
  });
  return matches[0] ?? ports[0] ?? null;
}
