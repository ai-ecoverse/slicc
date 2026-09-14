// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_CHROME = (globalThis as { chrome?: unknown }).chrome;
(globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'test-ext-id' } };

const mocks = vi.hoisted(() => ({
  openMountPickerPopup: vi.fn(),
  openUsbPickerPopup: vi.fn(),
  openSerialPickerPopup: vi.fn(),
  openHidPickerPopup: vi.fn(),
}));

vi.mock('../../src/fs/mount-picker-popup.js', () => ({
  openMountPickerPopup: mocks.openMountPickerPopup,

  storePendingHandle: vi.fn(),
  loadAndClearPendingHandle: vi.fn(),
}));

vi.mock('../../src/shell/supplemental-commands/usb-picker.js', () => ({
  openUsbPickerPopup: mocks.openUsbPickerPopup,
}));

vi.mock('../../src/shell/supplemental-commands/serial-picker.js', () => ({
  openSerialPickerPopup: mocks.openSerialPickerPopup,
}));

vi.mock('../../src/shell/supplemental-commands/hid-picker.js', () => ({
  openHidPickerPopup: mocks.openHidPickerPopup,
}));

const { handleDipPickerAction } = await import('../../src/ui/dip.js');

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

afterEach(() => {});

describe('handleDipPickerAction (extension)', () => {
  it('routes directory through mount-picker popup and forwards { handleInIdb, idbKey, dirName }', async () => {
    mocks.openMountPickerPopup.mockResolvedValue({ idbKey: 'k-42', dirName: 'repo' });
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'directory' },
      onLick
    );
    expect(mocks.openMountPickerPopup).toHaveBeenCalledTimes(1);
    expect(onLick).toHaveBeenCalledWith('approve', {
      handleInIdb: true,
      idbKey: 'k-42',
      dirName: 'repo',
    });
  });

  it('surfaces a directory-popup cancellation as { cancelled }', async () => {
    mocks.openMountPickerPopup.mockResolvedValue({ cancelled: true });
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'directory' },
      onLick
    );
    expect(onLick).toHaveBeenCalledWith('approve', { cancelled: true });
  });

  it('routes usb-device through the popup and forwards info', async () => {
    mocks.openUsbPickerPopup.mockResolvedValue({
      granted: true,
      info: { vendorId: 0x1, productId: 0x2 },
    });
    const onLick = vi.fn();
    await handleDipPickerAction(
      {
        type: 'dip-picker-action',
        action: 'approve',
        picker: 'usb-device',
        data: { filters: [{ vendorId: 0x1 }] },
      },
      onLick
    );
    expect(mocks.openUsbPickerPopup).toHaveBeenCalledWith([{ vendorId: 0x1 }]);
    expect(onLick).toHaveBeenCalledWith('approve', {
      granted: true,
      info: { vendorId: 0x1, productId: 0x2 },
    });
  });

  it('routes serial-port through the popup', async () => {
    mocks.openSerialPickerPopup.mockResolvedValue({
      granted: true,
      info: { usbVendorId: 0x10c4, usbProductId: 0xea60 },
    });
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'serial-port' },
      onLick
    );
    expect(mocks.openSerialPickerPopup).toHaveBeenCalledWith([]);
    expect(onLick).toHaveBeenCalledWith('approve', {
      granted: true,
      info: { usbVendorId: 0x10c4, usbProductId: 0xea60 },
    });
  });

  it('routes hid-device through the popup', async () => {
    mocks.openHidPickerPopup.mockResolvedValue({
      granted: true,
      info: { vendorId: 0x594d, productId: 0x604d },
    });
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'hid-device' },
      onLick
    );
    expect(onLick).toHaveBeenCalledWith('approve', {
      granted: true,
      info: { vendorId: 0x594d, productId: 0x604d },
    });
  });

  it('surfaces popup errors as { error } to onLick', async () => {
    mocks.openUsbPickerPopup.mockResolvedValue({ error: 'WebUSB unavailable' });
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'usb-device' },
      onLick
    );
    expect(onLick).toHaveBeenCalledWith('approve', { error: 'WebUSB unavailable' });
  });

  it('surfaces an unknown picker kind as an error', async () => {
    const onLick = vi.fn();
    await handleDipPickerAction(
      { type: 'dip-picker-action', action: 'approve', picker: 'mystery' as never },
      onLick
    );
    expect(onLick).toHaveBeenCalledWith('approve', { error: 'unknown picker kind: mystery' });
  });
});

afterEach(() => {
  if (ORIGINAL_CHROME === undefined) {
    delete (globalThis as { chrome?: unknown }).chrome;
  } else {
    (globalThis as { chrome?: unknown }).chrome = ORIGINAL_CHROME;
  }
});
