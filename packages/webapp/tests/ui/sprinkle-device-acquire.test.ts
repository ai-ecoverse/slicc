// @vitest-environment jsdom
/**
 * Pins that sprinkle / trusted-dip `slicc.{usb,hid,serial}.request()` acquires
 * devices through the leader `<slicc-permissions>` Grant prompt when mounted
 * (#3605 / #3631), so the Allow click supplies the user gesture the
 * iframe→leader postMessage hop otherwise drops. Sibling of #3604 / #3574 —
 * must use `prompt()`, not `request()` (request invokes the OS chooser
 * immediately with no Allow UI).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HidApi } from '../../src/kernel/hid-device-registry.js';
import type { SerialApi } from '../../src/kernel/serial-port-registry.js';
import type { UsbApi } from '../../src/kernel/usb-device-registry.js';

const surfaceMock = vi.hoisted(() => ({
  request: vi.fn(),
  prompt: vi.fn(),
}));

const surfaceHolder = vi.hoisted(() => ({ value: surfaceMock as typeof surfaceMock | null }));

vi.mock('../../src/ui/wc/wc-permissions-registry.js', () => ({
  getLeaderPermissionsSurface: () => surfaceHolder.value,
}));

import {
  acquireSprinkleHidDevices,
  acquireSprinkleSerialPort,
  acquireSprinkleUsbDevice,
  sprinkleGestureHid,
  sprinkleGestureSerial,
  sprinkleGestureUsb,
} from '../../src/ui/sprinkle-device-acquire.js';

describe('acquireSprinkleUsbDevice / Hid / Serial', () => {
  beforeEach(() => {
    surfaceHolder.value = surfaceMock;
    surfaceMock.request.mockReset();
    surfaceMock.prompt.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes USB through surface.prompt({ kinds: ["usb"] }) with filters', async () => {
    const device = { vendorId: 0x2341 };
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'granted',
      grants: [{ kind: 'usb', device }],
    });
    const usb: UsbApi = {
      getDevices: vi.fn(async () => []),
      requestDevice: vi.fn(),
    };
    const filters = [{ vendorId: 0x2341 }];

    expect(await acquireSprinkleUsbDevice(usb, filters)).toBe(device);
    expect(surfaceMock.prompt).toHaveBeenCalledWith({
      kinds: ['usb'],
      description: 'A sprinkle or dip asks to use a USB device.',
      requestOptions: { usb: { filters } },
    });
    expect(surfaceMock.request).not.toHaveBeenCalled();
    expect(usb.requestDevice).not.toHaveBeenCalled();
  });

  it('routes HID through prompt and returns every granted interface', async () => {
    const devices = [{ i: 0 }, { i: 1 }];
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'granted',
      grants: [{ kind: 'hid', device: devices[0], devices }],
    });
    const hid: HidApi = {
      getDevices: vi.fn(async () => []),
      requestDevice: vi.fn(),
    };

    expect(await acquireSprinkleHidDevices(hid, [])).toBe(devices);
    expect(surfaceMock.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kinds: ['hid'],
        description: 'A sprinkle or dip asks to use a HID device.',
      })
    );
    expect(surfaceMock.request).not.toHaveBeenCalled();
  });

  it('routes serial through prompt with filters', async () => {
    const port = { p: 1 };
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'granted',
      grants: [{ kind: 'serial', port }],
    });
    const serial: SerialApi = {
      getPorts: vi.fn(async () => []),
      requestPort: vi.fn(),
    };
    const filters = [{ usbVendorId: 0x2e8a }];

    expect(await acquireSprinkleSerialPort(serial, filters)).toBe(port);
    expect(surfaceMock.prompt).toHaveBeenCalledWith({
      kinds: ['serial'],
      description: 'A sprinkle or dip asks to use a serial port.',
      requestOptions: { serial: { filters } },
    });
    expect(surfaceMock.request).not.toHaveBeenCalled();
  });

  it('rejects when the user cancels the Grant prompt', async () => {
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'cancelled',
      grants: [],
      reason: 'cancelled',
    });
    const usb: UsbApi = { getDevices: vi.fn(), requestDevice: vi.fn() };

    await expect(acquireSprinkleUsbDevice(usb, [])).rejects.toThrow('usb request cancelled');
    expect(surfaceMock.request).not.toHaveBeenCalled();
  });

  it('rejects with the prompt reason when the grant fails for a non-cancel cause', async () => {
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'error',
      grants: [],
      reason: 'unavailable',
      message: 'WebUSB unavailable',
    });
    const usb: UsbApi = { getDevices: vi.fn(), requestDevice: vi.fn() };

    await expect(acquireSprinkleUsbDevice(usb, [])).rejects.toThrow(
      'usb request unavailable: WebUSB unavailable'
    );
  });

  it('falls back to navigator pickers when no surface is mounted', async () => {
    surfaceHolder.value = null;
    const device = { vendorId: 1 };
    const devices = [{ hid: true }];
    const port = { serial: true };
    const usb: UsbApi = {
      getDevices: vi.fn(async () => []),
      requestDevice: vi.fn(async () => device as never),
    };
    const hid: HidApi = {
      getDevices: vi.fn(async () => []),
      requestDevice: vi.fn(async () => devices as never),
    };
    const serial: SerialApi = {
      getPorts: vi.fn(async () => []),
      requestPort: vi.fn(async () => port as never),
    };

    expect(await acquireSprinkleUsbDevice(usb, [{ vendorId: 1 }])).toBe(device);
    expect(await acquireSprinkleHidDevices(hid, [])).toBe(devices);
    expect(await acquireSprinkleSerialPort(serial, [])).toBe(port);
    expect(usb.requestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: 1 }] });
    expect(hid.requestDevice).toHaveBeenCalledWith({ filters: [] });
    expect(serial.requestPort).toHaveBeenCalledWith({});
    expect(surfaceMock.prompt).not.toHaveBeenCalled();
  });

  it('sprinkleGesture* wrappers expose the same prompt path for *Ops.usbRequest', async () => {
    const device = { picked: true };
    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'granted',
      grants: [{ kind: 'usb', device }],
    });
    const usb: UsbApi = { getDevices: vi.fn(async () => []), requestDevice: vi.fn() };

    expect(await sprinkleGestureUsb(usb).requestDevice({ filters: [] })).toEqual(device);
    expect(usb.requestDevice).not.toHaveBeenCalled();

    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'granted',
      grants: [{ kind: 'hid', device: { a: 1 }, devices: [{ a: 1 }] }],
    });
    const hid: HidApi = { getDevices: vi.fn(async () => []), requestDevice: vi.fn() };
    expect(await sprinkleGestureHid(hid).requestDevice({ filters: [] })).toEqual([{ a: 1 }]);

    surfaceMock.prompt.mockResolvedValueOnce({
      status: 'granted',
      grants: [{ kind: 'serial', port: { s: 1 } }],
    });
    const serial: SerialApi = { getPorts: vi.fn(async () => []), requestPort: vi.fn() };
    expect(await sprinkleGestureSerial(serial).requestPort()).toEqual({ s: 1 });
  });
});
