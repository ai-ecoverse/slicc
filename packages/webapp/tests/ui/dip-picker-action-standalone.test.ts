// @vitest-environment jsdom
/**
 * Wave 9b — `handleDipPickerAction` standalone branch.
 *
 * Pins that the cone-driven approval card's Approve click routes the
 * directory / USB / serial / HID picker through the leader
 * `<slicc-permissions>` surface (`getLeaderPermissionsSurface`) instead of
 * the legacy direct-navigator path. The extension popup branch lives in
 * `dip-picker-action.test.ts`; this file deliberately leaves the
 * `chrome.runtime` global UNSET so `dip.ts:isExtension` captures `false`
 * at module init.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Ensure no extension runtime is present for this worker.
const ORIGINAL_CHROME = (globalThis as { chrome?: unknown }).chrome;
delete (globalThis as { chrome?: unknown }).chrome;

const surfaceMock = vi.hoisted(() => ({
  request: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));

vi.mock('../../src/ui/wc/wc-permissions-registry.js', () => ({
  getLeaderPermissionsSurface: () => surfaceMock,
}));

vi.mock('../../src/fs/mount-picker-popup.js', () => ({
  storePendingHandle: vi.fn(async () => {}),
  openMountPickerPopup: vi.fn(),
  loadAndClearPendingHandle: vi.fn(),
}));

const usbMod = vi.hoisted(() => ({
  getSharedUsbRegistry: vi.fn(() => ({ register: vi.fn(() => 'usb1') })),
  deviceToInfo: vi.fn(() => ({ handle: 'usb1', vendorId: 0x2e8a, productId: 0x0003 })),
}));
vi.mock('../../src/kernel/usb-device-registry.js', () => ({
  getSharedUsbRegistry: usbMod.getSharedUsbRegistry,
  deviceToInfo: usbMod.deviceToInfo,
  getNavigatorUsb: vi.fn(),
}));

const hidMod = vi.hoisted(() => ({
  getSharedHidRegistry: vi.fn(() => ({ register: vi.fn(() => 'hid1') })),
  hidDeviceToInfo: vi.fn((handle) => ({ handle, vendorId: 0x594d, productId: 0x604d })),
}));
vi.mock('../../src/kernel/hid-device-registry.js', () => ({
  getSharedHidRegistry: hidMod.getSharedHidRegistry,
  hidDeviceToInfo: hidMod.hidDeviceToInfo,
  getNavigatorHid: vi.fn(),
}));

const serialMod = vi.hoisted(() => ({
  getSharedSerialRegistry: vi.fn(() => ({
    register: vi.fn(() => 'serial1'),
    get: vi.fn(() => ({ usbVendorId: 0x10c4 })),
  })),
  deviceToInfo: vi.fn(() => ({ handle: 'serial1', usbVendorId: 0x10c4 })),
}));
vi.mock('../../src/kernel/serial-port-registry.js', () => ({
  getSharedSerialRegistry: serialMod.getSharedSerialRegistry,
  deviceToInfo: serialMod.deviceToInfo,
  getNavigatorSerial: vi.fn(),
}));

const { handleDipPickerAction } = await import('../../src/ui/dip.js');

beforeEach(() => {
  surfaceMock.request.mockReset();
  surfaceMock.addEventListener.mockReset();
  surfaceMock.removeEventListener.mockReset();
});

afterEach(() => {
  if (ORIGINAL_CHROME !== undefined) {
    (globalThis as { chrome?: unknown }).chrome = ORIGINAL_CHROME;
  }
});

describe('handleDipPickerAction (standalone) — routes pickers through <slicc-permissions>', () => {
  it('directory: surface grant → { handleInIdb, idbKey, dirName }', async () => {
    const handle = { name: 'projects' } as unknown as FileSystemDirectoryHandle;
    surfaceMock.request.mockResolvedValueOnce({
      kind: 'filesystem',
      handle,
      source: 'picker',
      permission: 'granted',
    });
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'directory' },
      onLick
    );
    expect(surfaceMock.request).toHaveBeenCalledWith('filesystem', undefined);
    const call = onLick.mock.calls[0];
    expect(call[0]).toBe('approve');
    expect(call[1].handleInIdb).toBe(true);
    expect(call[1].dirName).toBe('projects');
    expect(call[1].idbKey).toMatch(/^pendingMount:dip-/);
  });

  it('usb-device: surface grant → { granted, handle, info }', async () => {
    surfaceMock.request.mockResolvedValueOnce({
      kind: 'usb',
      device: { vendorId: 0x2e8a, productId: 0x0003 },
    });
    const onLick = vi.fn();
    await handleDipPickerAction(
      {
        type: 'dip-picker-action',
        action: 'approve',
        picker: 'usb-device',
        data: { filters: [{ vendorId: 0x2e8a }] },
      },
      onLick
    );
    expect(surfaceMock.request).toHaveBeenCalledWith('usb', { filters: [{ vendorId: 0x2e8a }] });
    expect(onLick).toHaveBeenCalledWith('approve', {
      granted: true,
      handle: 'usb1',
      info: { handle: 'usb1', vendorId: 0x2e8a, productId: 0x0003 },
    });
  });

  it('serial-port: surface grant → { granted, handle, info }', async () => {
    surfaceMock.request.mockResolvedValueOnce({
      kind: 'serial',
      port: { getInfo: () => ({ usbVendorId: 0x10c4 }) },
    });
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'serial-port' },
      onLick
    );
    // No filters → opts omitted (matches terminal path).
    expect(surfaceMock.request).toHaveBeenCalledWith('serial', undefined);
    expect(onLick).toHaveBeenCalledWith('approve', {
      granted: true,
      handle: 'serial1',
      info: { handle: 'serial1', usbVendorId: 0x10c4 },
    });
  });

  it('hid-device: surface grant → registers EVERY granted interface', async () => {
    const devices = [
      { vendorId: 0x594d, productId: 0x604d, collections: [] },
      { vendorId: 0x594d, productId: 0x604d, collections: [] },
    ];
    surfaceMock.request.mockResolvedValueOnce({
      kind: 'hid',
      device: devices[0],
      devices,
    });
    const registerSpy = vi.fn().mockReturnValueOnce('hid1').mockReturnValueOnce('hid2');
    hidMod.getSharedHidRegistry.mockReturnValueOnce({ register: registerSpy } as never);
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'hid-device' },
      onLick
    );
    expect(surfaceMock.request).toHaveBeenCalledWith('hid', { filters: [] });
    expect(registerSpy).toHaveBeenCalledTimes(2);
    const lick = onLick.mock.calls[0][1];
    expect(lick.granted).toBe(true);
    expect(lick.devices).toHaveLength(2);
  });

  it('translates a cancelled deny event into { cancelled: true }', async () => {
    // Surface returns null and dispatches deny — the helper installs a
    // listener and reads denyRef.current. Simulate by capturing the
    // listener and invoking it before request resolves.
    let denyHandler: ((ev: Event) => void) | undefined;
    surfaceMock.addEventListener.mockImplementation((_type, cb) => {
      denyHandler = cb as (ev: Event) => void;
    });
    surfaceMock.request.mockImplementationOnce(async () => {
      denyHandler?.(
        new CustomEvent('slicc-permission-deny', {
          detail: { kind: 'usb', reason: 'cancelled' },
        })
      );
      return null;
    });
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'usb-device' },
      onLick
    );
    expect(onLick).toHaveBeenCalledWith('approve', { cancelled: true });
  });

  it('translates an unavailable deny into a stable error string', async () => {
    let denyHandler: ((ev: Event) => void) | undefined;
    surfaceMock.addEventListener.mockImplementation((_type, cb) => {
      denyHandler = cb as (ev: Event) => void;
    });
    surfaceMock.request.mockImplementationOnce(async () => {
      denyHandler?.(
        new CustomEvent('slicc-permission-deny', {
          detail: { kind: 'filesystem', reason: 'unavailable', message: 'no FSAccess' },
        })
      );
      return null;
    });
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'directory' },
      onLick
    );
    expect(onLick).toHaveBeenCalledWith('approve', {
      error: 'File System Access API not available',
    });
  });
});
