/**
 * Provider seams for the leader `<slicc-permissions>` surface.
 *
 * Extension realms cannot host `showDirectoryPicker` /
 * `navigator.{usb,hid,serial}.request*` directly — the side panel either
 * crashes under TCC or is silently disallowed by Chrome. The picker work
 * runs in `chrome-extension://<id>/picker-popup.html` (a normal browser
 * window, satisfying the user-gesture rule); the popup posts back an
 * identifier envelope and we re-acquire the actual `USBDevice` /
 * `HIDDevice` / `SerialPort` / `FileSystemDirectoryHandle` in the
 * page-side realm before handing it to the surface.
 *
 * Extracted from `wc-live.ts` so the wiring can be unit-tested without
 * spinning up the full shell.
 */

import type { PermissionProviders } from '@slicc/webcomponents';
import { isExtensionRealm } from '../../core/runtime-env.js';

/**
 * Detect the Chrome extension runtime via the canonical
 * `isExtensionRealm()` helper. Exported so the wiring can decide whether
 * to inject popup providers, and so tests can stub the extension check
 * by swapping the global.
 */
export function isExtensionRuntime(): boolean {
  return isExtensionRealm();
}

/**
 * Pick injectable provider seams for the leader surface in extension
 * mode. Returns `undefined` in non-extension runtimes so the surface
 * keeps the platform defaults (`navigator.usb` / `navigator.hid` /
 * `navigator.serial` / `window.showDirectoryPicker`).
 *
 * Each kind routes through the shared `picker-popup.html` window:
 *
 * - `filesystem` — popup `?kind=directory` stashes the granted
 *   `FileSystemDirectoryHandle` in the `slicc-pending-mount` IDB store
 *   (handles can't `postMessage`); we load it back here, then re-stash
 *   so downstream consumers that key off the same store still see it.
 * - `usb` / `hid` / `serial` — popup returns `{ vendorId, productId, … }`;
 *   we re-enumerate via `navigator.{usb,hid,serial}.getDevices()` to find
 *   the now-granted device in the side-panel realm and return it.
 *
 * Each provider throws on cancel / error so the surface routes a clean
 * `slicc-permission-deny` event (matching the platform-default shape).
 */
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
        // Re-stash so downstream consumers that key off the same IDB
        // store can still pick it up; the surface's `permission-request`
        // handler will overwrite this with its own key on the next
        // round-trip if it needs to.
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
        // Mirror `navigator.hid.requestDevice`'s shape (array of devices);
        // the surface picks the first as `device` and exposes `devices`
        // for multi-interface consumers.
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
