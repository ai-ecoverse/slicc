// @vitest-environment jsdom
/**
 * Provider seams that the leader `<slicc-permissions>` surface picks up in
 * extension mode. `chrome.runtime.id` decides whether the popup-backed
 * providers are returned at all; once they ARE, each kind throws on
 * cancel / error and resolves with the re-acquired native device handle.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLeaderPermissionProviders,
  isExtensionRuntime,
} from '../../../src/ui/wc/wc-permissions-providers.js';

const popupMocks = vi.hoisted(() => ({
  openMountPickerPopup: vi.fn(),
  storePendingHandle: vi.fn(),
  loadAndClearPendingHandle: vi.fn(),
  openUsbPickerPopup: vi.fn(),
  openHidPickerPopup: vi.fn(),
  openSerialPickerPopup: vi.fn(),
}));

vi.mock('../../../src/fs/mount-picker-popup.js', () => ({
  openMountPickerPopup: popupMocks.openMountPickerPopup,
  storePendingHandle: popupMocks.storePendingHandle,
  loadAndClearPendingHandle: popupMocks.loadAndClearPendingHandle,
}));

vi.mock('../../../src/shell/supplemental-commands/usb-picker.js', () => ({
  openUsbPickerPopup: popupMocks.openUsbPickerPopup,
}));

vi.mock('../../../src/shell/supplemental-commands/hid-picker.js', () => ({
  openHidPickerPopup: popupMocks.openHidPickerPopup,
}));

vi.mock('../../../src/shell/supplemental-commands/serial-picker.js', () => ({
  openSerialPickerPopup: popupMocks.openSerialPickerPopup,
}));

const navMocks = vi.hoisted(() => ({
  usbGetDevices: vi.fn(),
  hidGetDevices: vi.fn(),
  serialGetPorts: vi.fn(),
}));

vi.mock('../../../src/kernel/usb-device-registry.js', () => ({
  getNavigatorUsb: () => ({ getDevices: navMocks.usbGetDevices }),
}));

vi.mock('../../../src/kernel/hid-device-registry.js', () => ({
  getNavigatorHid: () => ({ getDevices: navMocks.hidGetDevices }),
}));

vi.mock('../../../src/kernel/serial-port-registry.js', () => ({
  getNavigatorSerial: () => ({ getPorts: navMocks.serialGetPorts }),
}));

const ORIGINAL_CHROME = (globalThis as { chrome?: unknown }).chrome;

function setChromeRuntime(id: string | undefined): void {
  if (id === undefined) {
    delete (globalThis as { chrome?: unknown }).chrome;
    return;
  }
  (globalThis as { chrome?: unknown }).chrome = { runtime: { id } };
}

beforeEach(() => {
  for (const m of Object.values(popupMocks)) m.mockReset();
  for (const m of Object.values(navMocks)) m.mockReset();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = ORIGINAL_CHROME;
});

describe('isExtensionRuntime', () => {
  it('returns true only when chrome.runtime.id is a non-empty string', () => {
    setChromeRuntime(undefined);
    expect(isExtensionRuntime()).toBe(false);
    setChromeRuntime('');
    expect(isExtensionRuntime()).toBe(false);
    setChromeRuntime('abc123');
    expect(isExtensionRuntime()).toBe(true);
  });
});

describe('buildLeaderPermissionProviders', () => {
  it('returns undefined outside the extension runtime', async () => {
    expect(await buildLeaderPermissionProviders(false)).toBeUndefined();
  });

  it('returns popup-backed providers for filesystem/usb/hid/serial', async () => {
    const providers = await buildLeaderPermissionProviders(true);
    expect(providers).toBeDefined();
    expect(typeof providers!.filesystem?.showDirectoryPicker).toBe('function');
    expect(typeof providers!.usb?.requestDevice).toBe('function');
    expect(typeof providers!.hid?.requestDevice).toBe('function');
    expect(typeof providers!.serial?.requestPort).toBe('function');
  });

  it('filesystem.showDirectoryPicker loads + re-stashes the granted handle', async () => {
    const handle = { kind: 'directory', name: 'repo' } as unknown as FileSystemDirectoryHandle;
    popupMocks.openMountPickerPopup.mockResolvedValue({ idbKey: 'k1', dirName: 'repo' });
    popupMocks.loadAndClearPendingHandle.mockResolvedValue(handle);
    popupMocks.storePendingHandle.mockResolvedValue(undefined);
    const providers = await buildLeaderPermissionProviders(true);
    const result = await providers!.filesystem!.showDirectoryPicker();
    expect(result).toBe(handle);
    expect(popupMocks.loadAndClearPendingHandle).toHaveBeenCalledWith('k1');
    expect(popupMocks.storePendingHandle).toHaveBeenCalledWith('k1', handle);
  });

  it('filesystem.showDirectoryPicker throws AbortError on cancellation', async () => {
    popupMocks.openMountPickerPopup.mockResolvedValue({ cancelled: true });
    const providers = await buildLeaderPermissionProviders(true);
    await expect(providers!.filesystem!.showDirectoryPicker()).rejects.toThrow(/cancelled/);
  });

  it('usb.requestDevice re-acquires the granted USB device by vid/pid/serial', async () => {
    const matching = { vendorId: 0x10, productId: 0x20, serialNumber: 'S' };
    const other = { vendorId: 0x10, productId: 0x99 };
    popupMocks.openUsbPickerPopup.mockResolvedValue({
      granted: true,
      info: { vendorId: 0x10, productId: 0x20, serialNumber: 'S' },
    });
    navMocks.usbGetDevices.mockResolvedValue([other, matching]);
    const providers = await buildLeaderPermissionProviders(true);
    const result = await providers!.usb!.requestDevice({ filters: [{ vendorId: 0x10 }] });
    expect(result).toBe(matching);
  });

  it('usb.requestDevice throws AbortError on user cancel', async () => {
    popupMocks.openUsbPickerPopup.mockResolvedValue({ cancelled: true });
    const providers = await buildLeaderPermissionProviders(true);
    await expect(providers!.usb!.requestDevice({})).rejects.toThrow(/cancelled/);
  });

  it('usb.requestDevice throws when granted device cannot be re-acquired', async () => {
    popupMocks.openUsbPickerPopup.mockResolvedValue({
      granted: true,
      info: { vendorId: 1, productId: 2 },
    });
    navMocks.usbGetDevices.mockResolvedValue([]);
    const providers = await buildLeaderPermissionProviders(true);
    await expect(providers!.usb!.requestDevice({})).rejects.toThrow(/could not be re-acquired/);
  });

  it('hid.requestDevice returns every matching interface (multi-interface QMK)', async () => {
    const iface0 = { vendorId: 0x594d, productId: 0x604d, collections: [] };
    const iface1 = { vendorId: 0x594d, productId: 0x604d, collections: [] };
    const other = { vendorId: 0x1234, productId: 0x5678 };
    popupMocks.openHidPickerPopup.mockResolvedValue({
      granted: true,
      info: { vendorId: 0x594d, productId: 0x604d },
    });
    navMocks.hidGetDevices.mockResolvedValue([iface0, other, iface1]);
    const providers = await buildLeaderPermissionProviders(true);
    const result = (await providers!.hid!.requestDevice({})) as unknown[];
    expect(result).toEqual([iface0, iface1]);
  });

  it('hid.requestDevice throws when no matching interface is enumerated', async () => {
    popupMocks.openHidPickerPopup.mockResolvedValue({
      granted: true,
      info: { vendorId: 1, productId: 2 },
    });
    navMocks.hidGetDevices.mockResolvedValue([]);
    const providers = await buildLeaderPermissionProviders(true);
    await expect(providers!.hid!.requestDevice({})).rejects.toThrow(/could not be re-acquired/);
  });

  it('serial.requestPort matches by usb vid/pid via getInfo()', async () => {
    const matching = { getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }) };
    const other = { getInfo: () => ({ usbVendorId: 0xaa, usbProductId: 0xbb }) };
    popupMocks.openSerialPickerPopup.mockResolvedValue({
      granted: true,
      info: { usbVendorId: 0x10c4, usbProductId: 0xea60 },
    });
    navMocks.serialGetPorts.mockResolvedValue([other, matching]);
    const providers = await buildLeaderPermissionProviders(true);
    const result = await providers!.serial!.requestPort({});
    expect(result).toBe(matching);
  });

  it('serial.requestPort surfaces popup errors', async () => {
    popupMocks.openSerialPickerPopup.mockResolvedValue({ error: 'kaboom' });
    const providers = await buildLeaderPermissionProviders(true);
    await expect(providers!.serial!.requestPort({})).rejects.toThrow(/kaboom/);
  });
});
