import type { SliccPermissions } from '@slicc/webcomponents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HidApi } from '../../../src/kernel/hid-device-registry.js';
import type { SerialApi } from '../../../src/kernel/serial-port-registry.js';
import type { UsbApi } from '../../../src/kernel/usb-device-registry.js';
import {
  gestureDisplayMedia,
  gestureHid,
  gestureSerial,
  gestureUsb,
  hasUserGesture,
} from '../../../src/ui/panel-rpc/gesture-picker.js';

function activation(isActive: boolean | undefined): void {
  vi.stubGlobal('navigator', isActive === undefined ? {} : { userActivation: { isActive } });
}

function surface(result: unknown) {
  const prompt = vi.fn(async () => result);
  return { prompt, get: () => ({ prompt }) as unknown as SliccPermissions };
}

const usb: UsbApi = {
  getDevices: vi.fn(async () => []),
  requestDevice: vi.fn(async () => ({ direct: true }) as never),
};

describe('device choosers without a user gesture', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the direct chooser while the page holds a gesture (or cannot tell)', () => {
    activation(true);
    expect(hasUserGesture()).toBe(true);
    expect(gestureUsb(usb, () => null)).toBe(usb);
    activation(undefined);
    expect(hasUserGesture()).toBe(true);
  });

  it('opens the chooser from the permission prompt, with the command’s filters', async () => {
    activation(false);
    const s = surface({ status: 'granted', grants: [{ kind: 'usb', device: { picked: 1 } }] });
    const filters = [{ vendorId: 0x2341 }];
    expect(await gestureUsb(usb, s.get).requestDevice({ filters })).toEqual({ picked: 1 });
    expect(s.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ['usb'], requestOptions: { usb: { filters } } })
    );
    expect(usb.requestDevice).not.toHaveBeenCalled();
  });

  it('hands back every HID interface and the serial port the prompt granted', async () => {
    activation(false);
    const hid = { getDevices: vi.fn(), requestDevice: vi.fn() } as unknown as HidApi;
    const devices = [{ i: 0 }, { i: 1 }];
    const h = surface({
      status: 'granted',
      grants: [{ kind: 'hid', device: devices[0], devices }],
    });
    expect(await gestureHid(hid, h.get).requestDevice({ filters: [] })).toBe(devices);
    const serial = { getPorts: vi.fn(), requestPort: vi.fn() } as unknown as SerialApi;
    const s = surface({ status: 'granted', grants: [{ kind: 'serial', port: { p: 1 } }] });
    expect(await gestureSerial(serial, s.get).requestPort()).toEqual({ p: 1 });
    expect(s.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ requestOptions: { serial: { filters: [] } } })
    );
  });

  it('fails with the prompt’s reason on cancel, and clearly without a prompt', async () => {
    activation(false);
    const s = surface({ status: 'cancelled', reason: 'cancelled', grants: [] });
    await expect(gestureUsb(usb, s.get).requestDevice({ filters: [] })).rejects.toThrow(
      'usb request: cancelled'
    );
    await expect(gestureUsb(usb, () => null).requestDevice({ filters: [] })).rejects.toThrow(
      /needs a click/
    );
  });

  it('shares a screen through the prompt, with the capture constraints', async () => {
    const getDisplayMedia = vi.fn(async () => ({ direct: true }));
    vi.stubGlobal('navigator', {
      userActivation: { isActive: false },
      mediaDevices: { getDisplayMedia },
    });
    const stream = { prompted: true };
    const s = surface({ status: 'granted', grants: [{ kind: 'screenshare', stream }] });
    const constraints = { video: true, audio: false };
    expect(await gestureDisplayMedia(s.get)(constraints)).toBe(stream);
    expect(s.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kinds: ['screenshare'],
        description: 'A command in the terminal asks to share a screen.',
        requestOptions: { screenshare: { constraints } },
      })
    );
    expect(getDisplayMedia).not.toHaveBeenCalled();

    // With a gesture the browser's picker opens directly.
    vi.stubGlobal('navigator', {
      userActivation: { isActive: true },
      mediaDevices: { getDisplayMedia },
    });
    expect(await gestureDisplayMedia(s.get)(constraints)).toEqual({ direct: true });
    expect(getDisplayMedia).toHaveBeenCalledWith(constraints);
  });
});
