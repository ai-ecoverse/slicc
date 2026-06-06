import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VirtualFS } from '../../src/fs/index.js';
import {
  getSharedHidRegistry,
  type HidApi,
  type HidDevice,
  type HidInputReportEvent,
} from '../../src/kernel/hid-device-registry.js';
import type { LickEvent } from '../../src/scoops/lick-manager.js';
import { SprinkleBridge, type SprinkleHidInputReport } from '../../src/ui/sprinkle-bridge.js';

/**
 * Build a fake HID device that records calls and lets the test fire
 * `inputreport` events through whatever listener the bridge attaches via
 * `addEventListener`.
 */
function makeFakeHidDevice(over: Partial<HidDevice> = {}) {
  const listeners = new Set<(ev: HidInputReportEvent) => void>();
  const state = { opened: false };
  const device: HidDevice = {
    get opened() {
      return state.opened;
    },
    vendorId: 0x320f,
    productId: 0x5000,
    productName: 'Test HID',
    collections: [{ usagePage: 0xff60, usage: 0x61 }],
    open: vi.fn(async () => {
      state.opened = true;
    }),
    close: vi.fn(async () => {
      state.opened = false;
    }),
    sendReport: vi.fn(async () => undefined),
    sendFeatureReport: vi.fn(async () => undefined),
    receiveFeatureReport: vi.fn(async () => new DataView(new ArrayBuffer(0))),
    addEventListener: vi.fn((type, listener) => {
      if (type === 'inputreport') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type, listener) => {
      if (type === 'inputreport') listeners.delete(listener);
    }),
    ...over,
  };
  return {
    device,
    fire(reportId: number, bytes: Uint8Array) {
      const ev = {
        device,
        reportId,
        data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      } as HidInputReportEvent;
      for (const l of listeners) l(ev);
    },
    listenerCount: () => listeners.size,
  };
}

function buildBridge(iframePusher?: (name: string, channel: string, payload: unknown) => void) {
  const mockFs = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readDir: vi.fn(),
    exists: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
  } as unknown as VirtualFS;
  return new SprinkleBridge(
    mockFs,
    vi.fn() as unknown as (event: LickEvent) => void,
    vi.fn() as unknown as (name: string) => void,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn().mockResolvedValue({ base64: '', width: 0, height: 0, mimeType: 'image/png' }),
    undefined,
    iframePusher
  );
}

/** Stub `navigator.hid` for the duration of a test, then restore. */
function stubNavigatorHid(hid: HidApi): () => void {
  const nav = (globalThis as { navigator?: { hid?: HidApi } }).navigator;
  if (!nav) {
    (globalThis as { navigator?: { hid?: HidApi } }).navigator = { hid };
    return () => {
      delete (globalThis as { navigator?: { hid?: HidApi } }).navigator;
    };
  }
  const prev = nav.hid;
  nav.hid = hid;
  return () => {
    if (prev) nav.hid = prev;
    else delete nav.hid;
  };
}

describe('SprinkleBridge — slicc.hid surface', () => {
  let restoreHid: (() => void) | null = null;

  afterEach(() => {
    // Reset the shared page-side registry between tests so handles don't
    // leak. The registry is module-private; we re-import it fresh via
    // its singleton accessor and clear every entry.
    const reg = getSharedHidRegistry();
    for (const { handle } of reg.list()) reg.remove(handle);
    if (restoreHid) {
      restoreHid();
      restoreHid = null;
    }
  });

  it('hid.list() returns descriptors for previously granted devices', async () => {
    const { device } = makeFakeHidDevice();
    const hid: HidApi = {
      getDevices: vi.fn().mockResolvedValue([device]),
      requestDevice: vi.fn(),
    };
    restoreHid = stubNavigatorHid(hid);
    const bridge = buildBridge();
    const api = bridge.createAPI('demo');
    const infos = await api.hid.list();
    expect(infos).toHaveLength(1);
    expect(infos[0].vendorId).toBe(0x320f);
    expect(infos[0].handle).toMatch(/^hid\d+$/);
  });

  it('list → open → on(inputreport) → sendReport → push delivers a report', async () => {
    const fake = makeFakeHidDevice();
    const hid: HidApi = {
      getDevices: vi.fn().mockResolvedValue([fake.device]),
      requestDevice: vi.fn(),
    };
    restoreHid = stubNavigatorHid(hid);
    const pusher = vi.fn();
    const bridge = buildBridge(pusher);
    const api = bridge.createAPI('demo');

    const [info] = await api.hid.list();
    await api.hid.open(info.handle);
    expect(fake.device.open).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount()).toBe(1);

    const received: SprinkleHidInputReport[] = [];
    api.hid.on('inputreport', (r) => received.push(r));

    await api.hid.sendReport(info.handle, 0, new Uint8Array([0x01, 0x02]));
    expect(fake.device.sendReport).toHaveBeenCalledWith(0, expect.any(ArrayBuffer));

    fake.fire(7, new Uint8Array([0xaa, 0xbb, 0xcc]));
    // Inline listeners deliver asynchronously via setTimeout(…, 0)
    await new Promise((r) => setTimeout(r, 5));

    expect(received).toHaveLength(1);
    expect(received[0].handle).toBe(info.handle);
    expect(received[0].reportId).toBe(7);
    expect(Array.from(received[0].data)).toEqual([0xaa, 0xbb, 0xcc]);

    expect(pusher).toHaveBeenCalledWith('demo', 'hid:inputreport', {
      handle: info.handle,
      reportId: 7,
      data: expect.any(Uint8Array),
    });
  });

  it('hid.close() and removeSprinkle() detach the input-report listener', async () => {
    const fake = makeFakeHidDevice();
    const hid: HidApi = {
      getDevices: vi.fn().mockResolvedValue([fake.device]),
      requestDevice: vi.fn(),
    };
    restoreHid = stubNavigatorHid(hid);
    const bridge = buildBridge();
    const api = bridge.createAPI('demo');
    const [info] = await api.hid.list();

    await api.hid.open(info.handle);
    expect(fake.listenerCount()).toBe(1);

    await api.hid.close(info.handle);
    expect(fake.listenerCount()).toBe(0);
    expect(fake.device.close).toHaveBeenCalledTimes(1);

    // Re-open then drop via removeSprinkle to cover the close-implicit path.
    await api.hid.open(info.handle);
    expect(fake.listenerCount()).toBe(1);
    bridge.removeSprinkle('demo');
    expect(fake.listenerCount()).toBe(0);
  });

  it('off() removes a single listener without tearing down the subscription', async () => {
    const fake = makeFakeHidDevice();
    const hid: HidApi = {
      getDevices: vi.fn().mockResolvedValue([fake.device]),
      requestDevice: vi.fn(),
    };
    restoreHid = stubNavigatorHid(hid);
    const bridge = buildBridge();
    const api = bridge.createAPI('demo');
    const [info] = await api.hid.list();
    await api.hid.open(info.handle);

    const a = vi.fn();
    const b = vi.fn();
    api.hid.on('inputreport', a);
    api.hid.on('inputreport', b);
    api.hid.off('inputreport', a);

    fake.fire(0, new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 5));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    // Subscription stays alive while the device is still open.
    expect(fake.listenerCount()).toBe(1);
  });

  it('_device() routes through the same per-channel dispatcher', async () => {
    const fake = makeFakeHidDevice();
    const hid: HidApi = {
      getDevices: vi.fn().mockResolvedValue([fake.device]),
      requestDevice: vi.fn(),
    };
    restoreHid = stubNavigatorHid(hid);
    const bridge = buildBridge();
    const api = bridge.createAPI('demo');
    const infos = (await api._device('hid', 'list', [])) as Array<{ handle: string }>;
    expect(infos).toHaveLength(1);
    await expect(api._device('hid', 'unknown-op', [])).rejects.toThrow(/unknown op/);
    await expect(api._device('bogus' as 'hid', 'list', [])).rejects.toThrow(
      /unknown device channel/
    );
  });
});
