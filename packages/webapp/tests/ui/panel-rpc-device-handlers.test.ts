import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Targeted tests for the WebUSB / WebHID / Web Serial / esptool panel-RPC
 * handlers in `createStandalonePanelRpcHandlers`. These wire the kernel
 * worker's device commands to the page-side registries and to the
 * `*-operations` helpers; the existing test file only covers the
 * DOM-free handlers (tray-*, oauth-extras, etc.) so the device handlers
 * stayed at the file's 7% baseline.
 */

vi.mock('../../src/kernel/esptool-operations.js', () => ({
  esptoolChipInfo: vi.fn(async (_r: unknown, _h: string, _b: number, log?: (l: string) => void) => {
    log?.('Detecting chip type...');
    return {
      chip: 'ESP32',
      mac: 'aa:bb:cc:dd:ee:ff',
      features: ['WiFi'],
      crystalMHz: 40,
    };
  }),
  esptoolReadMac: vi.fn(async (_r: unknown, _h: string, _b: number, log?: (l: string) => void) => {
    log?.('MAC=aa:bb:cc:dd:ee:ff');
    return { mac: 'aa:bb:cc:dd:ee:ff' };
  }),
  esptoolEraseFlash: vi.fn(
    async (_r: unknown, _h: string, _b: number, log?: (l: string) => void) => {
      log?.('Erasing flash...');
    }
  ),
  esptoolFlash: vi.fn(
    async (
      _r: unknown,
      _h: string,
      _b: number,
      _e: boolean,
      _s: unknown,
      log?: (l: string) => void
    ) => {
      log?.('Writing at 0x1000...');
    }
  ),
  esptoolReadFlash: vi.fn(
    async (
      _r: unknown,
      _h: string,
      _b: number,
      _a: number,
      _sz: number,
      log?: (l: string) => void
    ) => {
      log?.('Reading flash...');
      return new Uint8Array([0x01, 0x02, 0x03]);
    }
  ),
  esptoolReadReg: vi.fn(async () => ({ value: 0xdeadbeef })),
  esptoolFlashId: vi.fn(async () => ({ id: 0x1234, manufacturer: 0xab, device: 0xcd })),
  esptoolEraseRegion: vi.fn(
    async (
      _r: unknown,
      _h: string,
      _b: number,
      _a: number,
      _sz: number,
      log?: (l: string) => void
    ) => {
      log?.('Erasing region...');
    }
  ),
  esptoolRun: vi.fn(async (_r: unknown, _h: string, _b: number, log?: (l: string) => void) => {
    log?.('Resetting...');
  }),
}));

type AnyNavigator = {
  usb?: unknown;
  hid?: unknown;
  serial?: unknown;
  mediaDevices?: unknown;
  clipboard?: unknown;
};
const setNavigator = (v: AnyNavigator) => {
  Object.defineProperty(globalThis, 'navigator', {
    value: v,
    configurable: true,
    writable: true,
  });
};
const getNavigator = (): AnyNavigator | undefined =>
  (globalThis as { navigator?: AnyNavigator }).navigator;

function fakeUsbDevice(over: Record<string, unknown> = {}) {
  return {
    vendorId: 0x2e8a,
    productId: 0x0003,
    productName: 'RP2040',
    manufacturerName: 'Raspberry Pi',
    serialNumber: 'ABC-' + Math.random().toString(36).slice(2),
    opened: false,
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    selectConfiguration: vi.fn(async () => undefined),
    claimInterface: vi.fn(async () => undefined),
    releaseInterface: vi.fn(async () => undefined),
    controlTransferIn: vi.fn(async () => ({
      status: 'ok',
      data: { buffer: new Uint8Array([1, 2]).buffer, byteOffset: 0, byteLength: 2 },
    })),
    controlTransferOut: vi.fn(async () => ({ status: 'ok', bytesWritten: 4 })),
    transferIn: vi.fn(async () => ({
      status: 'ok',
      data: { buffer: new Uint8Array([9]).buffer, byteOffset: 0, byteLength: 1 },
    })),
    transferOut: vi.fn(async () => ({ status: 'ok', bytesWritten: 2 })),
    reset: vi.fn(async () => undefined),
    ...over,
  };
}

function fakeHidDevice(over: Record<string, unknown> = {}) {
  return {
    vendorId: 0x320f,
    productId: 0x5000,
    productName: 'Pad-' + Math.random().toString(36).slice(2),
    opened: false,
    collections: [{ usagePage: 0xff60, usage: 0x61 }],
    open: vi.fn(async function (this: { opened: boolean }) {
      this.opened = true;
    }),
    close: vi.fn(async () => undefined),
    sendReport: vi.fn(async () => undefined),
    sendFeatureReport: vi.fn(async () => undefined),
    receiveFeatureReport: vi.fn(async () => new DataView(new Uint8Array([7, 8, 9]).buffer)),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...over,
  };
}

function fakeSerialPort(over: Record<string, unknown> = {}) {
  return {
    readable: null,
    writable: null,
    getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }),
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    setSignals: vi.fn(async () => undefined),
    getSignals: vi.fn(async () => ({
      clearToSend: true,
      dataCarrierDetect: false,
      dataSetReady: true,
      ringIndicator: false,
    })),
    ...over,
  };
}

let previousNavigator: AnyNavigator | undefined;

beforeEach(() => {
  vi.resetModules();
  previousNavigator = getNavigator();
});

afterEach(() => {
  if (previousNavigator) setNavigator(previousNavigator);
  else Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
});

async function loadHandlers(emitEvent?: (channel: string, payload: unknown) => void) {
  const mod = await import('../../src/ui/panel-rpc-handlers.js');
  return mod.createStandalonePanelRpcHandlers({ emitEvent });
}

async function loadKernel() {
  const usb = await import('../../src/kernel/usb-device-registry.js');
  const hid = await import('../../src/kernel/hid-device-registry.js');
  const serial = await import('../../src/kernel/serial-port-registry.js');
  return { usb, hid, serial };
}

describe('createStandalonePanelRpcHandlers — WebUSB', () => {
  it('rejects every WebUSB op clearly when navigator.usb is missing', async () => {
    setNavigator({});
    const handlers = await loadHandlers();
    await expect(handlers['usb-list']!(undefined)).rejects.toThrow(/WebUSB is unavailable/);
    await expect(handlers['usb-request']!({ filters: [] })).rejects.toThrow(
      /WebUSB is unavailable/
    );
  });

  it('list / request register granted devices and surface them', async () => {
    const granted = fakeUsbDevice({ serialNumber: 'PRESENT-1' });
    const fresh = fakeUsbDevice({ serialNumber: 'PICKED-1' });
    const usbApi = {
      getDevices: vi.fn(async () => [granted]),
      requestDevice: vi.fn(async () => fresh),
    };
    setNavigator({ usb: usbApi });
    const handlers = await loadHandlers();
    const list = await handlers['usb-list']!(undefined);
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0]).toMatchObject({ vendorId: 0x2e8a, productId: 0x0003, opened: false });
    const requested = await handlers['usb-request']!({ filters: [{ vendorId: 0x2e8a }] });
    expect(usbApi.requestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: 0x2e8a }] });
    expect(requested.device.serialNumber).toBe('PICKED-1');
  });

  it('routes the device lifecycle ops through the registered USBDevice', async () => {
    const dev = fakeUsbDevice({ serialNumber: 'LIFE-1' });
    setNavigator({ usb: { getDevices: vi.fn(async () => [dev]), requestDevice: vi.fn() } });
    const { usb } = await loadKernel();
    const handle = usb.getSharedUsbRegistry().register(dev);
    const handlers = await loadHandlers();
    expect((await handlers['usb-device-info']!({ handle })).device.handle).toBe(handle);
    expect(await handlers['usb-open']!({ handle })).toEqual({ done: true });
    expect(dev.open).toHaveBeenCalledOnce();
    expect(await handlers['usb-close']!({ handle })).toEqual({ done: true });
    expect(dev.close).toHaveBeenCalledOnce();
    expect(await handlers['usb-select-configuration']!({ handle, configurationValue: 1 })).toEqual({
      done: true,
    });
    expect(dev.selectConfiguration).toHaveBeenCalledWith(1);
    expect(await handlers['usb-claim-interface']!({ handle, interfaceNumber: 0 })).toEqual({
      done: true,
    });
    expect(await handlers['usb-release-interface']!({ handle, interfaceNumber: 0 })).toEqual({
      done: true,
    });
    expect(await handlers['usb-reset']!({ handle })).toEqual({ done: true });
    expect(dev.reset).toHaveBeenCalledOnce();
  });

  it('forwards control + bulk transfers through the registered device', async () => {
    const dev = fakeUsbDevice({ serialNumber: 'XFER-1' });
    setNavigator({ usb: { getDevices: vi.fn(async () => [dev]), requestDevice: vi.fn() } });
    const { usb } = await loadKernel();
    const handle = usb.getSharedUsbRegistry().register(dev);
    const handlers = await loadHandlers();
    const setup = {
      requestType: 'vendor' as const,
      recipient: 'device' as const,
      request: 1,
      value: 0,
      index: 0,
    };
    const ctIn = await handlers['usb-control-transfer-in']!({ handle, setup, length: 2 });
    expect(ctIn.status).toBe('ok');
    expect(new Uint8Array(ctIn.bytes)).toEqual(new Uint8Array([1, 2]));
    const ctOut = await handlers['usb-control-transfer-out']!({
      handle,
      setup,
      bytes: new Uint8Array([5, 6, 7, 8]).buffer,
    });
    expect(ctOut).toEqual({ status: 'ok', bytesWritten: 4 });
    const tIn = await handlers['usb-transfer-in']!({ handle, endpointNumber: 1, length: 1 });
    expect(new Uint8Array(tIn.bytes)).toEqual(new Uint8Array([9]));
    const tOut = await handlers['usb-transfer-out']!({
      handle,
      endpointNumber: 2,
      bytes: new Uint8Array([0xff, 0xfe]).buffer,
    });
    expect(tOut).toEqual({ status: 'ok', bytesWritten: 2 });
  });
});

describe('createStandalonePanelRpcHandlers — WebHID', () => {
  it('rejects every WebHID op clearly when navigator.hid is missing', async () => {
    setNavigator({});
    const handlers = await loadHandlers();
    await expect(handlers['hid-list']!(undefined)).rejects.toThrow(/WebHID is unavailable/);
    await expect(handlers['hid-request']!({ filters: [] })).rejects.toThrow(
      /WebHID is unavailable/
    );
  });

  it('list / request register every granted interface', async () => {
    const grantedA = fakeHidDevice({
      productName: 'kbd',
      collections: [{ usagePage: 0x01, usage: 0x06 }],
    });
    const grantedB = fakeHidDevice({
      productName: 'kbd',
      collections: [{ usagePage: 0xff60, usage: 0x61 }],
    });
    const hidApi = {
      getDevices: vi.fn(async () => [grantedA]),
      requestDevice: vi.fn(async () => [grantedA, grantedB]),
    };
    setNavigator({ hid: hidApi });
    const handlers = await loadHandlers();
    const list = await handlers['hid-list']!(undefined);
    expect(list.devices).toHaveLength(1);
    const req = await handlers['hid-request']!({ filters: [{ vendorId: 0x320f }] });
    expect(req.devices).toHaveLength(2);
    expect(req.devices.map((d) => d.usagePage)).toEqual([0x01, 0xff60]);
  });

  it('routes device-info / open / close through the registered HIDDevice', async () => {
    const dev = fakeHidDevice({ productName: 'hid-life-1' });
    setNavigator({ hid: { getDevices: vi.fn(async () => [dev]), requestDevice: vi.fn() } });
    const { hid } = await loadKernel();
    const handle = hid.getSharedHidRegistry().register(dev);
    const handlers = await loadHandlers();
    expect((await handlers['hid-device-info']!({ handle })).device.handle).toBe(handle);
    await handlers['hid-open']!({ handle });
    expect(dev.open).toHaveBeenCalledOnce();
    await handlers['hid-close']!({ handle });
    expect(dev.close).toHaveBeenCalledOnce();
  });

  it('send / send-feature / receive-feature forward report payloads', async () => {
    const dev = fakeHidDevice({ productName: 'hid-xfer-1' });
    setNavigator({ hid: { getDevices: vi.fn(async () => [dev]), requestDevice: vi.fn() } });
    const { hid } = await loadKernel();
    const handle = hid.getSharedHidRegistry().register(dev);
    const handlers = await loadHandlers();
    await handlers['hid-send-report']!({
      handle,
      reportId: 1,
      bytes: new Uint8Array([1, 2, 3]).buffer,
    });
    expect(dev.sendReport).toHaveBeenCalledWith(1, expect.any(ArrayBuffer));
    await handlers['hid-send-feature-report']!({
      handle,
      reportId: 2,
      bytes: new Uint8Array([4, 5]).buffer,
    });
    expect(dev.sendFeatureReport).toHaveBeenCalledWith(2, expect.any(ArrayBuffer));
    const recv = await handlers['hid-receive-feature-report']!({ handle, reportId: 3 });
    expect(recv.reportId).toBe(3);
    expect(new Uint8Array(recv.bytes)).toEqual(new Uint8Array([7, 8, 9]));
  });

  it('subscribe / unsubscribe input reports keep the listener around and tear it down', async () => {
    const listeners: Array<(ev: unknown) => void> = [];
    const dev = fakeHidDevice({
      productName: 'hid-watch-1',
      addEventListener: vi.fn((_t: string, l: (ev: unknown) => void) => listeners.push(l)),
      removeEventListener: vi.fn((_t: string, l: (ev: unknown) => void) => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      }),
    });
    setNavigator({ hid: { getDevices: vi.fn(async () => [dev]), requestDevice: vi.fn() } });
    const { hid } = await loadKernel();
    const handle = hid.getSharedHidRegistry().register(dev);
    const events: Array<{ channel: string; payload: unknown }> = [];
    const handlers = await loadHandlers((channel, payload) => events.push({ channel, payload }));
    await handlers['hid-subscribe-input-reports']!({ handle });
    expect(listeners).toHaveLength(1);
    listeners[0]({ reportId: 7, data: new DataView(new Uint8Array([0xaa, 0xbb]).buffer) });
    expect(events).toHaveLength(1);
    expect(events[0].channel).toBe('hid-input-report');
    expect((events[0].payload as { handle: string; reportId: number }).reportId).toBe(7);
    await handlers['hid-subscribe-input-reports']!({ handle });
    expect(listeners).toHaveLength(1);
    handlers['hid-unsubscribe-input-reports']!({ handle });
    expect(listeners).toHaveLength(0);
    handlers['hid-unsubscribe-input-reports']!({ handle });
  });
});

describe('createStandalonePanelRpcHandlers — Web Serial', () => {
  it('rejects every Web Serial op clearly when navigator.serial is missing', async () => {
    setNavigator({});
    const handlers = await loadHandlers();
    await expect(handlers['serial-list']!(undefined)).rejects.toThrow(/Web Serial is unavailable/);
    await expect(handlers['serial-request']!({ filters: [] })).rejects.toThrow(
      /Web Serial is unavailable/
    );
  });

  it('list / request register granted ports', async () => {
    const port = fakeSerialPort();
    const serialApi = {
      getPorts: vi.fn(async () => [port]),
      requestPort: vi.fn(async () => port),
    };
    setNavigator({ serial: serialApi });
    const handlers = await loadHandlers();
    const list = await handlers['serial-list']!(undefined);
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0]).toMatchObject({ usbVendorId: 0x10c4, opened: false });
    const req = await handlers['serial-request']!({ filters: [{ usbVendorId: 0x10c4 }] });
    expect(serialApi.requestPort).toHaveBeenCalledWith({ filters: [{ usbVendorId: 0x10c4 }] });
    expect(req.device.usbVendorId).toBe(0x10c4);
  });

  it('serial-request omits the empty-filters wrapper', async () => {
    const port = fakeSerialPort();
    const serialApi = {
      getPorts: vi.fn(async () => [port]),
      requestPort: vi.fn(async () => port),
    };
    setNavigator({ serial: serialApi });
    const handlers = await loadHandlers();
    await handlers['serial-request']!({ filters: [] });
    expect(serialApi.requestPort).toHaveBeenCalledWith({});
  });

  it('open / close / device-info / get-signals / set-signals forward to the port', async () => {
    const port = fakeSerialPort();
    setNavigator({ serial: { getPorts: vi.fn(async () => [port]), requestPort: vi.fn() } });
    const { serial } = await loadKernel();
    const handle = serial.getSharedSerialRegistry().register(port);
    const handlers = await loadHandlers();
    expect((await handlers['serial-device-info']!({ handle })).device.handle).toBe(handle);
    await handlers['serial-open']!({ handle, options: { baudRate: 115200 } });
    expect(port.open).toHaveBeenCalledWith({ baudRate: 115200 });
    const signals = await handlers['serial-get-signals']!({ handle });
    expect(signals).toEqual({
      signals: {
        clearToSend: true,
        dataCarrierDetect: false,
        dataSetReady: true,
        ringIndicator: false,
      },
    });
    await handlers['serial-set-signals']!({ handle, signals: { dataTerminalReady: true } });
    expect(port.setSignals).toHaveBeenCalledWith({ dataTerminalReady: true });
    await handlers['serial-close']!({ handle });
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('read / write forward Uint8Array payloads through the streaming readers/writers', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), undefined];
    const reader = {
      read: vi.fn(async () => {
        const v = chunks.shift();
        return v ? { value: v, done: false } : { value: undefined, done: true };
      }),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
    const writer = {
      write: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
    const readable = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const writable = { getWriter: () => writer } as unknown as WritableStream<Uint8Array>;
    const port = fakeSerialPort({ readable, writable });
    setNavigator({ serial: { getPorts: vi.fn(async () => [port]), requestPort: vi.fn() } });
    const { serial } = await loadKernel();
    const handle = serial.getSharedSerialRegistry().register(port);
    const handlers = await loadHandlers();
    const read = await handlers['serial-read']!({
      handle,
      maxBytes: 10,
      until: new Uint8Array([0x0a]).buffer,
      timeoutMs: 50,
    });
    expect(new Uint8Array(read.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    const w = await handlers['serial-write']!({
      handle,
      bytes: new Uint8Array([0xaa, 0xbb]).buffer,
    });
    expect(w.bytesWritten).toBe(2);
    expect(writer.write).toHaveBeenCalledOnce();
  });
});

describe('createStandalonePanelRpcHandlers — esptool', () => {
  it('chip-info / read-mac / flash-id / read-reg surface esptool-operations results', async () => {
    const port = fakeSerialPort();
    setNavigator({ serial: { getPorts: vi.fn(async () => [port]), requestPort: vi.fn() } });
    const { serial } = await loadKernel();
    const handle = serial.getSharedSerialRegistry().register(port);
    const events: Array<{ channel: string; line: string }> = [];
    const handlers = await loadHandlers((channel, payload) =>
      events.push({ channel, line: (payload as { line: string }).line })
    );
    expect(await handlers['esptool-chip-info']!({ handle, baudRate: 115200 })).toMatchObject({
      chip: 'ESP32',
    });
    expect(await handlers['esptool-read-mac']!({ handle, baudRate: 115200 })).toMatchObject({
      mac: 'aa:bb:cc:dd:ee:ff',
    });
    expect(await handlers['esptool-flash-id']!({ handle, baudRate: 115200 })).toMatchObject({
      id: 0x1234,
    });
    expect(
      await handlers['esptool-read-reg']!({ handle, baudRate: 115200, address: 0x60008000 })
    ).toMatchObject({ value: 0xdeadbeef });
  });

  it('erase / flash / read-flash / erase-region / run delegate to esptool-operations', async () => {
    const port = fakeSerialPort();
    setNavigator({ serial: { getPorts: vi.fn(async () => [port]), requestPort: vi.fn() } });
    const { serial } = await loadKernel();
    const handle = serial.getSharedSerialRegistry().register(port);
    const handlers = await loadHandlers();
    expect(await handlers['esptool-erase-flash']!({ handle, baudRate: 115200 })).toEqual({
      done: true,
    });
    expect(
      await handlers['esptool-flash']!({
        handle,
        baudRate: 115200,
        eraseAll: false,
        segments: [{ address: 0x1000, bytes: new Uint8Array([1, 2]).buffer }],
      })
    ).toEqual({ done: true });
    const readResult = await handlers['esptool-read-flash']!({
      handle,
      baudRate: 115200,
      address: 0,
      size: 3,
    });
    expect(new Uint8Array(readResult.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(
      await handlers['esptool-erase-region']!({
        handle,
        baudRate: 115200,
        address: 0x1000,
        size: 4096,
      })
    ).toEqual({ done: true });
    expect(await handlers['esptool-run']!({ handle, baudRate: 115200 })).toEqual({ done: true });
  });
});

describe('createStandalonePanelRpcHandlers — page misc', () => {
  it('page-info returns the page origin / href / title', async () => {
    setNavigator({});
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'http://x.test', href: 'http://x.test/a' } },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: { title: 'Slicc' },
      configurable: true,
    });
    const handlers = await loadHandlers();
    const info = handlers['page-info']!(undefined);
    expect(info).toEqual({
      origin: 'http://x.test',
      href: 'http://x.test/a',
      title: 'Slicc',
    });
  });

  it('speak-text rejects when speechSynthesis is unavailable', async () => {
    setNavigator({});
    const original = (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
    delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
    const handlers = await loadHandlers();
    await expect(handlers['speak-text']!({ text: 'hi' })).rejects.toThrow(
      /speechSynthesis is unavailable/
    );
    if (original) (globalThis as { speechSynthesis?: unknown }).speechSynthesis = original;
  });

  it('list-voices rejects when speechSynthesis is unavailable', async () => {
    setNavigator({});
    const original = (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
    delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
    const handlers = await loadHandlers();
    await expect(handlers['list-voices']!(undefined)).rejects.toThrow(
      /speechSynthesis is unavailable/
    );
    if (original) (globalThis as { speechSynthesis?: unknown }).speechSynthesis = original;
  });

  it('play-audio / play-chime reject when AudioContext is unavailable', async () => {
    setNavigator({});
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    const handlers = await loadHandlers();
    await expect(handlers['play-audio']!({ bytes: new ArrayBuffer(0) })).rejects.toThrow(
      /Web Audio API is unavailable/
    );
    await expect(handlers['play-chime']!({ tone: 'success' })).rejects.toThrow(
      /Web Audio API is unavailable/
    );
    if (original) (globalThis as { AudioContext?: unknown }).AudioContext = original;
  });

  it('clipboard ops reject clearly when the clipboard API is absent', async () => {
    setNavigator({ clipboard: undefined } as AnyNavigator);
    const handlers = await loadHandlers();
    await expect(handlers['clipboard-read-text']!(undefined)).rejects.toThrow(
      /clipboard API unavailable/
    );
    await expect(handlers['clipboard-write-text']!({ text: 'x' })).rejects.toThrow(
      /clipboard API unavailable/
    );
    await expect(
      handlers['clipboard-write-image']!({
        bytes: new ArrayBuffer(0),
        mimeType: 'image/png',
      })
    ).rejects.toThrow(/clipboard image API unavailable/);
  });

  it('enumerate-media-devices rejects when mediaDevices is unavailable', async () => {
    setNavigator({});
    const handlers = await loadHandlers();
    await expect(handlers['enumerate-media-devices']!(undefined)).rejects.toThrow(
      /enumerateDevices is not supported/
    );
  });

  it('window-open posts through window.open and reports opened', async () => {
    setNavigator({});
    Object.defineProperty(globalThis, 'window', {
      value: {
        open: vi.fn(() => ({})),
        location: { origin: '', href: '' },
      },
      configurable: true,
      writable: true,
    });
    const handlers = await loadHandlers();
    const opened = await handlers['window-open']!({
      url: 'https://example.com/',
      target: '_blank',
      features: 'noopener',
    });
    expect(opened).toEqual({ opened: true });
    const closed = await handlers['window-open']!({ url: 'https://x' });
    expect(closed.opened).toBe(true);
  });

  it('enumerate-media-devices splits the kinds and trims missing groupId', async () => {
    const devs = [
      { kind: 'videoinput', deviceId: 'v1', label: 'Cam 1', groupId: 'g1' },
      { kind: 'audioinput', deviceId: 'a1', label: '', groupId: '' },
      { kind: 'audiooutput', deviceId: 'o1', label: 'Out', groupId: 'g2' },
    ];
    setNavigator({
      mediaDevices: {
        enumerateDevices: vi.fn(async () => devs),
      },
    });
    const handlers = await loadHandlers();
    const result = await handlers['enumerate-media-devices']!(undefined);
    expect(result.videoinputs).toEqual([{ deviceId: 'v1', label: 'Cam 1', groupId: 'g1' }]);
    expect(result.audioinputs).toEqual([{ deviceId: 'a1', label: '' }]);
  });

  it('clipboard-read-text returns navigator.clipboard.readText() value', async () => {
    setNavigator({
      clipboard: { readText: vi.fn(async () => 'hello'), writeText: vi.fn(async () => undefined) },
    });
    const handlers = await loadHandlers();
    expect(await handlers['clipboard-read-text']!(undefined)).toEqual({ text: 'hello' });
  });

  it('clipboard-write-text writes through and short-circuits when document is missing', async () => {
    setNavigator({
      clipboard: { readText: vi.fn(), writeText: vi.fn(async () => undefined) },
    });
    Object.defineProperty(globalThis, 'document', { value: undefined, configurable: true });
    const handlers = await loadHandlers();
    expect(await handlers['clipboard-write-text']!({ text: 'copied' })).toEqual({ done: true });
    expect(
      (
        globalThis as unknown as {
          navigator: { clipboard: { writeText: ReturnType<typeof vi.fn> } };
        }
      ).navigator.clipboard.writeText.mock.calls
    ).toEqual([['copied']]);
  });

  it('clipboard-write-text honours an already-focused document', async () => {
    setNavigator({
      clipboard: { readText: vi.fn(), writeText: vi.fn(async () => undefined) },
    });
    Object.defineProperty(globalThis, 'document', {
      value: { hasFocus: () => true },
      configurable: true,
    });
    const handlers = await loadHandlers();
    await handlers['clipboard-write-text']!({ text: 'focused' });
  });

  it('speak-text resolves on utterance end and applies the requested voice', async () => {
    setNavigator({});
    const voice = { name: 'Daniel', lang: 'en-GB', default: false };
    const utterances: Array<Record<string, unknown>> = [];
    class Utt {
      onend?: () => void;
      lang?: string;
      voice?: unknown;
      rate?: number;
      pitch?: number;
      volume?: number;
      constructor(public text: string) {
        utterances.push(this as unknown as Record<string, unknown>);
      }
    }
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      value: Utt,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'speechSynthesis', {
      value: {
        getVoices: () => [voice],
        speak: (u: { onend?: () => void }) => setTimeout(() => u.onend?.(), 0),
      },
      configurable: true,
    });
    const handlers = await loadHandlers();
    const done = await handlers['speak-text']!({
      text: 'hi',
      lang: 'en-GB',
      voice: 'Daniel',
      rate: 1.1,
      pitch: 0.9,
      volume: 0.5,
    });
    expect(done).toEqual({ done: true });
    expect(utterances[0]).toMatchObject({
      text: 'hi',
      lang: 'en-GB',
      rate: 1.1,
      pitch: 0.9,
      volume: 0.5,
      voice,
    });
  });

  it('list-voices waits for voiceschanged and returns the loaded voices', async () => {
    setNavigator({});
    const voices = [
      { name: 'Daniel', lang: 'en-GB', default: false },
      { name: 'Karen', lang: 'en-AU', default: true },
    ];
    const listeners: Array<() => void> = [];
    let firstCall = true;
    Object.defineProperty(globalThis, 'speechSynthesis', {
      value: {
        getVoices: () => (firstCall ? [] : voices),
        addEventListener: (_t: string, l: () => void) => listeners.push(l),
        removeEventListener: (_t: string, l: () => void) => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
      configurable: true,
    });
    const handlers = await loadHandlers();
    const promise = handlers['list-voices']!(undefined);
    await Promise.resolve();
    firstCall = false;
    listeners.forEach((l) => {
      l();
    });
    const result = await promise;
    expect(result.voices.map((v) => v.name)).toEqual(['Daniel', 'Karen']);
    // Web Speech voices are never on-device.
    expect(result.voices.every((v) => v.onDevice === false)).toBe(true);
  });

  it('speak-status returns the page-side kokoro status', async () => {
    vi.doMock('../../src/speech/speak.js', () => ({
      kokoroStatus: () => ({ state: 'loading', loaded: 2, total: 8, etaSeconds: 4 }),
      kokoroWarmup: vi.fn(),
    }));
    const handlers = await loadHandlers();
    const status = await handlers['speak-status']!(undefined);
    expect(status).toEqual({ state: 'loading', loaded: 2, total: 8, etaSeconds: 4 });
    vi.doUnmock('../../src/speech/speak.js');
  });

  it('speak-warmup kicks the page-side warmup and returns initial status', async () => {
    const kokoroWarmup = vi.fn(() => ({ state: 'idle' as const }));
    vi.doMock('../../src/speech/speak.js', () => ({
      kokoroStatus: () => ({ state: 'idle' }),
      kokoroWarmup,
    }));
    const handlers = await loadHandlers();
    const status = await handlers['speak-warmup']!(undefined);
    expect(kokoroWarmup).toHaveBeenCalledOnce();
    expect(status).toEqual({ state: 'idle' });
    vi.doUnmock('../../src/speech/speak.js');
  });

  it('speak-warmup surfaces a page-side warmup failure as a rejection', async () => {
    vi.doMock('../../src/speech/speak.js', () => ({
      kokoroStatus: () => ({ state: 'idle' }),
      kokoroWarmup: () => {
        throw new Error('speech-assets: BroadcastChannel is unavailable');
      },
    }));
    const handlers = await loadHandlers();
    await expect(handlers['speak-warmup']!(undefined)).rejects.toThrow(/BroadcastChannel/);
    vi.doUnmock('../../src/speech/speak.js');
  });
});
