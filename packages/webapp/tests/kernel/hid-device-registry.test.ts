import { describe, expect, it, vi } from 'vitest';
import {
  type HidApi,
  type HidDevice,
  HidDeviceHandleRegistry,
  hidDeviceToInfo,
} from '../../src/kernel/hid-device-registry.js';
import * as hidOps from '../../src/kernel/hid-operations.js';

function fakeDevice(over: Partial<HidDevice> = {}): HidDevice {
  const listeners = new Set<(ev: unknown) => void>();
  const device = {
    vendorId: 0x320f,
    productId: 0x5000,
    productName: 'Nano Pad',
    opened: false,
    collections: [{ usagePage: 0x01, usage: 0x06 }],
    open: vi.fn().mockImplementation(async function (this: { opened: boolean }) {
      this.opened = true;
    }),
    close: vi.fn().mockResolvedValue(undefined),
    sendReport: vi.fn().mockResolvedValue(undefined),
    sendFeatureReport: vi.fn().mockResolvedValue(undefined),
    receiveFeatureReport: vi.fn().mockResolvedValue(new DataView(new ArrayBuffer(0))),
    addEventListener: vi.fn((_t: string, l: (ev: unknown) => void) => listeners.add(l)),
    removeEventListener: vi.fn((_t: string, l: (ev: unknown) => void) => listeners.delete(l)),
    ...over,
  } as HidDevice & { __listeners: Set<(ev: unknown) => void> };
  (device as { __listeners: typeof listeners }).__listeners = listeners;
  return device;
}

describe('HidDeviceHandleRegistry', () => {
  it('keeps distinct interfaces of one vid/pid as separate handles', () => {
    const reg = new HidDeviceHandleRegistry();
    const keyboard = fakeDevice({ collections: [{ usagePage: 0x01, usage: 0x06 }] });
    const consumer = fakeDevice({ collections: [{ usagePage: 0x0c, usage: 0x01 }] });
    const rawHid = fakeDevice({ collections: [{ usagePage: 0xff60, usage: 0x61 }] });
    const h1 = reg.register(keyboard);
    const h2 = reg.register(consumer);
    const h3 = reg.register(rawHid);
    expect(new Set([h1, h2, h3]).size).toBe(3);
    expect(reg.list()).toHaveLength(3);
  });

  it('dedupes a re-grant of the same interface by vid/pid/name/usagePage', () => {
    const reg = new HidDeviceHandleRegistry();
    const a = fakeDevice();
    const aAgain = fakeDevice({ opened: true });
    const h1 = reg.register(a);
    const h2 = reg.register(aAgain);
    expect(h2).toBe(h1);
    expect(reg.get(h1)?.opened).toBe(true);
  });

  it('reference identity short-circuits collection comparison', () => {
    const reg = new HidDeviceHandleRegistry();
    const d = fakeDevice({ collections: undefined });
    const h1 = reg.register(d);
    const h2 = reg.register(d);
    expect(h2).toBe(h1);
  });
});

describe('hidDeviceToInfo', () => {
  it('surfaces the first collection usagePage and usage', () => {
    const info = hidDeviceToInfo(
      'hid7',
      fakeDevice({ collections: [{ usagePage: 0xff60, usage: 0x61 }] })
    );
    expect(info).toMatchObject({
      handle: 'hid7',
      usagePage: 0xff60,
      usage: 0x61,
      opened: false,
    });
  });

  it('omits usagePage/usage when the device exposes no collections', () => {
    const info = hidDeviceToInfo('hid8', fakeDevice({ collections: undefined }));
    expect(info.usagePage).toBeUndefined();
    expect(info.usage).toBeUndefined();
  });
});

describe('hid-operations', () => {
  it('hidRequest registers every granted interface and returns them all', async () => {
    const reg = new HidDeviceHandleRegistry();
    const granted = [
      fakeDevice({ collections: [{ usagePage: 0x01, usage: 0x06 }] }),
      fakeDevice({ collections: [{ usagePage: 0x0c, usage: 0x01 }] }),
      fakeDevice({ collections: [{ usagePage: 0xff60, usage: 0x61 }] }),
    ];
    const hid: HidApi = {
      getDevices: vi.fn().mockResolvedValue([]),
      requestDevice: vi.fn().mockResolvedValue(granted),
    };
    const infos = await hidOps.hidRequest(reg, hid, []);
    expect(infos).toHaveLength(3);
    expect(new Set(infos.map((i) => i.handle)).size).toBe(3);
    expect(infos.map((i) => i.usagePage)).toEqual([0x01, 0x0c, 0xff60]);
    expect(reg.list()).toHaveLength(3);
  });

  it('hidRequest throws when the user cancels (empty grant array)', async () => {
    const reg = new HidDeviceHandleRegistry();
    const hid: HidApi = {
      getDevices: vi.fn().mockResolvedValue([]),
      requestDevice: vi.fn().mockResolvedValue([]),
    };
    await expect(hidOps.hidRequest(reg, hid, [])).rejects.toThrow(/No device selected/);
  });

  it('auto-opens a closed device before sendReport', async () => {
    const reg = new HidDeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    await hidOps.hidSendReport(reg, handle, 0, new ArrayBuffer(2));
    expect(device.open).toHaveBeenCalledTimes(1);
    expect(device.sendReport).toHaveBeenCalled();
  });

  it('skips open when the device is already open', async () => {
    const reg = new HidDeviceHandleRegistry();
    const device = fakeDevice({ opened: true });
    const handle = reg.register(device);
    await hidOps.hidSendFeatureReport(reg, handle, 1, new ArrayBuffer(1));
    expect(device.open).not.toHaveBeenCalled();
    expect(device.sendFeatureReport).toHaveBeenCalled();
  });

  it('auto-opens a closed device before subscribing to input reports', async () => {
    const reg = new HidDeviceHandleRegistry();
    const device = fakeDevice();
    const handle = reg.register(device);
    const reports: Array<{ reportId: number; bytes: ArrayBuffer }> = [];
    const unsubscribe = await hidOps.hidSubscribeInputReports(reg, handle, (r) => reports.push(r));
    expect(device.open).toHaveBeenCalledTimes(1);
    expect(device.addEventListener).toHaveBeenCalledWith('inputreport', expect.any(Function));
    unsubscribe();
    expect(device.removeEventListener).toHaveBeenCalled();
  });
});
