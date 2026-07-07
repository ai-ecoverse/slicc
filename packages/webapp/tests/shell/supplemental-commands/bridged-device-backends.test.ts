import { describe, expect, it, vi } from 'vitest';
import { resolveHidBackend } from '../../../src/shell/supplemental-commands/hid-backends.js';
import { resolveSerialBackend } from '../../../src/shell/supplemental-commands/serial-backends.js';
import { resolveUsbBackend } from '../../../src/shell/supplemental-commands/usb-backends.js';

/**
 * The `BridgedXxxBackend` classes are thin pass-throughs over a
 * `PanelRpcClient`. The bulk of their lines/functions only execute via
 * the resolver path that picks "no DOM, has panelRpc" → bridged backend.
 * These tests exercise every method of each bridged backend with a
 * stub RPC client so the panel-rpc op names, payload shapes, and the
 * Uint8Array <-> ArrayBuffer round-tripping stay covered.
 */

function makeRpc(canned: Record<string, unknown>) {
  const calls: Array<{ op: string; payload: unknown; opts?: { timeoutMs?: number } }> = [];
  const call = vi.fn(async (op: string, payload: unknown, opts?: { timeoutMs?: number }) => {
    calls.push({ op, payload, opts });
    return canned[op] ?? { done: true };
  });
  const onEvent = vi.fn(() => () => undefined);
  return { rpc: { call, onEvent } as never, calls, call, onEvent };
}

describe('resolveUsbBackend + BridgedUsbBackend', () => {
  it('falls back to the bridged backend when no DOM is present', async () => {
    const { rpc, calls } = makeRpc({
      'usb-list': { devices: [{ handle: 'usb1' }] },
      'usb-request': { device: { handle: 'usb2' } },
      'usb-device-info': { device: { handle: 'usb1' } },
      'usb-control-transfer-in': { status: 'ok', bytes: new Uint8Array([1, 2]).buffer },
      'usb-control-transfer-out': { status: 'ok', bytesWritten: 4 },
      'usb-transfer-in': { status: 'ok', bytes: new Uint8Array([9]).buffer },
      'usb-transfer-out': { status: 'ok', bytesWritten: 2 },
    });
    const backend = resolveUsbBackend(false, rpc);
    expect(backend).not.toBeNull();
    expect(await backend!.list()).toEqual([{ handle: 'usb1' }]);
    expect((await backend!.request([{ vendorId: 0x2e8a }])).handle).toBe('usb2');
    expect((await backend!.info('usb1')).handle).toBe('usb1');
    await backend!.open('usb1');
    await backend!.close('usb1');
    await backend!.selectConfig('usb1', 1);
    await backend!.claim('usb1', 0);
    await backend!.release('usb1', 0);
    const setup = {
      requestType: 'vendor' as const,
      recipient: 'device' as const,
      request: 1,
      value: 0,
      index: 0,
    };
    const ctIn = await backend!.controlIn('usb1', setup, 2);
    expect(ctIn.bytes).toEqual(new Uint8Array([1, 2]));
    expect(
      (await backend!.controlOut('usb1', setup, new Uint8Array([1, 2, 3, 4]))).bytesWritten
    ).toBe(4);
    expect((await backend!.transferIn('usb1', 1, 1)).bytes).toEqual(new Uint8Array([9]));
    expect((await backend!.transferOut('usb1', 2, new Uint8Array([3, 4]))).bytesWritten).toBe(2);
    await backend!.reset('usb1');
    expect(calls.map((c) => c.op)).toEqual([
      'usb-list',
      'usb-request',
      'usb-device-info',
      'usb-open',
      'usb-close',
      'usb-select-configuration',
      'usb-claim-interface',
      'usb-release-interface',
      'usb-control-transfer-in',
      'usb-control-transfer-out',
      'usb-transfer-in',
      'usb-transfer-out',
      'usb-reset',
    ]);
    expect(calls[1].opts?.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('returns null when neither DOM nor panelRpc is available', () => {
    expect(resolveUsbBackend(false, null)).toBeNull();
  });
});

describe('resolveHidBackend + BridgedHidBackend', () => {
  it('forwards every op including the subscribe/unsubscribe pair', async () => {
    const { rpc, calls, onEvent } = makeRpc({
      'hid-list': { devices: [{ handle: 'hid1' }] },
      'hid-request': { devices: [{ handle: 'hid1' }, { handle: 'hid2' }] },
      'hid-device-info': { device: { handle: 'hid1' } },
      'hid-receive-feature-report': {
        reportId: 3,
        bytes: new Uint8Array([7, 8, 9]).buffer,
      },
    });
    const backend = resolveHidBackend(false, rpc);
    expect(backend).not.toBeNull();
    expect(await backend!.list()).toEqual([{ handle: 'hid1' }]);
    expect((await backend!.request([])).length).toBe(2);
    expect((await backend!.info('hid1')).handle).toBe('hid1');
    await backend!.open('hid1');
    await backend!.close('hid1');
    await backend!.sendReport('hid1', 1, new Uint8Array([1]));
    await backend!.sendFeatureReport('hid1', 2, new Uint8Array([2]));
    const recv = await backend!.receiveFeatureReport('hid1', 3);
    expect(recv.bytes).toEqual(new Uint8Array([7, 8, 9]));
    const reports: Array<{ reportId: number; bytes: Uint8Array }> = [];
    const unsubscribe = await backend!.subscribeInputReports('hid1', (r) => reports.push(r));
    const handler = (onEvent.mock.calls[0] as unknown[] | undefined)?.[1] as (p: unknown) => void;
    handler({ handle: 'hid1', reportId: 5, bytes: new Uint8Array([0xaa]).buffer });
    handler({ handle: 'other', reportId: 6, bytes: new Uint8Array([0]).buffer });
    expect(reports).toEqual([{ reportId: 5, bytes: new Uint8Array([0xaa]) }]);
    await (unsubscribe as () => Promise<void>)();
    const ops = calls.map((c) => c.op);
    expect(ops).toContain('hid-subscribe-input-reports');
    expect(ops).toContain('hid-unsubscribe-input-reports');
  });

  it('returns null when neither DOM nor panelRpc is available', () => {
    expect(resolveHidBackend(false, null)).toBeNull();
  });

  it('removes the input-report listener when the subscribe RPC rejects', async () => {
    const offSpy = vi.fn();
    const call = vi.fn(async (op: string) => {
      if (op === 'hid-subscribe-input-reports') throw new Error('unknown handle');
      return {};
    });
    const onEvent = vi.fn(() => offSpy);
    const rpc = { call, onEvent } as never;
    const backend = resolveHidBackend(false, rpc);
    await expect(backend!.subscribeInputReports('hid1', () => {})).rejects.toThrow(
      'unknown handle'
    );
    expect(offSpy).toHaveBeenCalledTimes(1);
  });
});

describe('resolveSerialBackend + BridgedSerialBackend', () => {
  it('forwards every op including read margin + write bytesWritten unwrap', async () => {
    const { rpc, calls } = makeRpc({
      'serial-list': { devices: [{ handle: 'serial1' }] },
      'serial-request': { device: { handle: 'serial1' } },
      'serial-device-info': { device: { handle: 'serial1' } },
      'serial-read': { bytes: new Uint8Array([1, 2, 3]).buffer },
      'serial-write': { bytesWritten: 5 },
      'serial-get-signals': { signals: { clearToSend: true } },
    });
    const backend = resolveSerialBackend(false, rpc);
    expect(backend).not.toBeNull();
    expect(await backend!.list()).toEqual([{ handle: 'serial1' }]);
    expect((await backend!.request([{ usbVendorId: 0x10c4 }])).handle).toBe('serial1');
    expect((await backend!.info('serial1')).handle).toBe('serial1');
    await backend!.open('serial1', { baudRate: 115200 });
    expect(await backend!.read('serial1', { maxBytes: 3, until: new Uint8Array([0x0a]) })).toEqual(
      new Uint8Array([1, 2, 3])
    );
    expect(await backend!.write('serial1', new Uint8Array([1, 2]))).toBe(5);
    expect(await backend!.getSignals('serial1')).toEqual({ clearToSend: true });
    await backend!.setSignals('serial1', { dataTerminalReady: true });
    await backend!.close('serial1');
    const readCall = calls.find((c) => c.op === 'serial-read');
    expect(readCall?.opts?.timeoutMs).toBeGreaterThanOrEqual(30_000);
  });

  it('returns null when neither DOM nor panelRpc is available', () => {
    expect(resolveSerialBackend(false, null)).toBeNull();
  });
});

describe('resolveXxxBackend — local DOM path', () => {
  const setNavigator = (v: Record<string, unknown>) =>
    Object.defineProperty(globalThis, 'navigator', {
      value: v,
      configurable: true,
      writable: true,
    });

  function fakeUsbDevice() {
    return {
      vendorId: 0x2e8a,
      productId: 0x0003,
      productName: 'RP2040',
      manufacturerName: 'Pi',
      serialNumber: 'LOCAL-' + Math.random().toString(36).slice(2),
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
    };
  }

  it('LocalUsbBackend wraps every op around the real registry', async () => {
    const dev = fakeUsbDevice();
    setNavigator({
      usb: { getDevices: vi.fn(async () => [dev]), requestDevice: vi.fn(async () => dev) },
    });
    const backend = resolveUsbBackend(true, null);
    expect(backend).not.toBeNull();
    const list = await backend!.list();
    expect(list[0].handle).toMatch(/^usb\d+$/);
    const handle = list[0].handle;
    const requested = await backend!.request([{ vendorId: 0x2e8a }]);
    expect(requested.handle).toBe(handle);
    expect((await backend!.info(handle)).handle).toBe(handle);
    await backend!.open(handle);
    await backend!.close(handle);
    await backend!.selectConfig(handle, 1);
    await backend!.claim(handle, 0);
    await backend!.release(handle, 0);
    const setup = {
      requestType: 'vendor' as const,
      recipient: 'device' as const,
      request: 1,
      value: 0,
      index: 0,
    };
    expect((await backend!.controlIn(handle, setup, 2)).bytes).toEqual(new Uint8Array([1, 2]));
    expect(
      (await backend!.controlOut(handle, setup, new Uint8Array([1, 2, 3, 4]))).bytesWritten
    ).toBe(4);
    expect((await backend!.transferIn(handle, 1, 1)).bytes).toEqual(new Uint8Array([9]));
    expect((await backend!.transferOut(handle, 2, new Uint8Array([3, 4]))).bytesWritten).toBe(2);
    await backend!.reset(handle);
  });

  it('LocalHidBackend wraps every op around the real HID registry', async () => {
    const dev = {
      vendorId: 0x320f,
      productId: 0x5000,
      productName: 'Pad-Local-' + Math.random().toString(36).slice(2),
      opened: false,
      collections: [{ usagePage: 0xff60, usage: 0x61 }],
      open: vi.fn(async function (this: { opened: boolean }) {
        this.opened = true;
      }),
      close: vi.fn(async () => undefined),
      sendReport: vi.fn(async () => undefined),
      sendFeatureReport: vi.fn(async () => undefined),
      receiveFeatureReport: vi.fn(async () => new DataView(new Uint8Array([7]).buffer)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    setNavigator({
      hid: { getDevices: vi.fn(async () => [dev]), requestDevice: vi.fn(async () => [dev]) },
    });
    const backend = resolveHidBackend(true, null);
    expect(backend).not.toBeNull();
    const list = await backend!.list();
    const handle = list[0].handle;
    const req = await backend!.request([]);
    expect(req[0].handle).toBe(handle);
    expect((await backend!.info(handle)).handle).toBe(handle);
    await backend!.open(handle);
    await backend!.close(handle);
    await backend!.sendReport(handle, 1, new Uint8Array([1]));
    await backend!.sendFeatureReport(handle, 2, new Uint8Array([2]));
    const recv = await backend!.receiveFeatureReport(handle, 3);
    expect(recv.bytes).toEqual(new Uint8Array([7]));
    const reports: Array<{ reportId: number; bytes: Uint8Array }> = [];
    const unsub = await backend!.subscribeInputReports(handle, (r) => reports.push(r));
    expect(typeof unsub).toBe('function');
    await (unsub as () => void)();
  });

  it('LocalSerialBackend wraps every op around the real serial registry', async () => {
    const port = {
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
    };
    setNavigator({
      serial: { getPorts: vi.fn(async () => [port]), requestPort: vi.fn(async () => port) },
    });
    const backend = resolveSerialBackend(true, null);
    expect(backend).not.toBeNull();
    const list = await backend!.list();
    const handle = list[0].handle;
    expect(handle).toMatch(/^serial\d+$/);
    const req = await backend!.request([]);
    expect(req.handle).toBe(handle);
    expect((await backend!.info(handle)).handle).toBe(handle);
    await backend!.open(handle, { baudRate: 9600 });
    expect(await backend!.getSignals(handle)).toMatchObject({ clearToSend: true });
    await backend!.setSignals(handle, { dataTerminalReady: true });
    await backend!.close(handle);
  });
});
