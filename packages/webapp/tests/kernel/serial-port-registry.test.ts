import { describe, expect, it, vi } from 'vitest';
import * as serialOps from '../../src/kernel/serial-operations.js';
import {
  deviceToInfo,
  type SerialPort,
  SerialPortRegistry,
} from '../../src/kernel/serial-port-registry.js';

function makeReadable(chunks: Array<Uint8Array | { done: true }>) {
  let i = 0;
  const reader = {
    read: vi.fn(async () => {
      const v = chunks[i++];
      if (!v) return { value: undefined, done: true };
      if ('done' in v) return { value: undefined, done: true };
      return { value: v, done: false };
    }),
    cancel: vi.fn(async () => undefined),
    releaseLock: vi.fn(),
  };
  return {
    readable: { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
    reader,
  };
}

function makeWritable() {
  const writer = {
    write: vi.fn(async () => undefined),
    releaseLock: vi.fn(),
  };
  return {
    writable: { getWriter: () => writer } as unknown as WritableStream<Uint8Array>,
    writer,
  };
}

function makePort(readable?: ReadableStream<Uint8Array>, writable?: WritableStream<Uint8Array>) {
  return {
    readable: readable ?? null,
    writable: writable ?? null,
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
  } as unknown as SerialPort;
}

describe('SerialPortRegistry', () => {
  it('returns the same handle for the same port instance', () => {
    const reg = new SerialPortRegistry();
    const p = makePort();
    const h1 = reg.register(p);
    const h2 = reg.register(p);
    expect(h2).toBe(h1);
    expect(reg.list()).toHaveLength(1);
  });

  it('removes handles', () => {
    const reg = new SerialPortRegistry();
    const h = reg.register(makePort());
    expect(reg.remove(h)).toBe(true);
    expect(reg.get(h)).toBeUndefined();
  });

  it('deviceToInfo omits absent usbVendorId/usbProductId', () => {
    const port = makePort();
    (port.getInfo as () => unknown) = () => ({});
    const reg = new SerialPortRegistry();
    const handle = reg.register(port);
    const info = deviceToInfo(handle, reg.get(handle)!);
    expect(info).toEqual({ handle, opened: false });
  });
});

describe('serial-operations', () => {
  it('serialList registers every port and surfaces their info', async () => {
    const reg = new SerialPortRegistry();
    const ports = [makePort(), makePort()];
    const api = { getPorts: vi.fn(async () => ports), requestPort: vi.fn() };
    const list = await serialOps.serialList(reg, api);
    expect(list).toHaveLength(2);
    expect(new Set(list.map((d) => d.handle)).size).toBe(2);
  });

  it('serialRequest omits the filters key when none provided', async () => {
    const reg = new SerialPortRegistry();
    const port = makePort();
    const api = { getPorts: vi.fn(), requestPort: vi.fn(async () => port) };
    await serialOps.serialRequest(reg, api, []);
    expect(api.requestPort).toHaveBeenCalledWith({});
    await serialOps.serialRequest(reg, api, [{ usbVendorId: 0x10c4 }]);
    expect(api.requestPort).toHaveBeenLastCalledWith({ filters: [{ usbVendorId: 0x10c4 }] });
  });

  it('serialOpen / serialClose tear down reader+writer cleanly', async () => {
    const reg = new SerialPortRegistry();
    const { readable } = makeReadable([new Uint8Array([1, 2, 3])]);
    const { writable } = makeWritable();
    const port = makePort(readable, writable);
    const handle = reg.register(port);
    await serialOps.serialOpen(reg, handle, { baudRate: 115200 });
    expect(reg.get(handle)?.opened).toBe(true);
    await serialOps.serialRead(reg, handle, { maxBytes: 10, timeoutMs: 50 });
    await serialOps.serialWrite(reg, handle, new Uint8Array([4, 5]));
    await serialOps.serialClose(reg, handle);
    expect(reg.get(handle)?.opened).toBe(false);
    expect(port.close).toHaveBeenCalled();
  });

  it('serialRead honours the `until` delimiter and stashes leftover bytes', async () => {
    const reg = new SerialPortRegistry();
    const { readable } = makeReadable([new Uint8Array([0x68, 0x69, 0x0a, 0x99, 0x88])]);
    const port = makePort(readable);
    const handle = reg.register(port);
    await serialOps.serialOpen(reg, handle, { baudRate: 9600 });
    const first = await serialOps.serialRead(reg, handle, {
      maxBytes: 100,
      until: new Uint8Array([0x0a]),
      timeoutMs: 50,
    });
    expect(Array.from(first)).toEqual([0x68, 0x69, 0x0a]);
    const second = await serialOps.serialRead(reg, handle, { maxBytes: 100, timeoutMs: 5 });
    expect(Array.from(second)).toEqual([0x99, 0x88]);
  });

  it('serialRead trims to maxBytes when the buffer overflows', async () => {
    const reg = new SerialPortRegistry();
    const { readable } = makeReadable([new Uint8Array([1, 2, 3, 4, 5])]);
    const port = makePort(readable);
    const handle = reg.register(port);
    await serialOps.serialOpen(reg, handle, { baudRate: 9600 });
    const result = await serialOps.serialRead(reg, handle, { maxBytes: 3, timeoutMs: 30 });
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it('serialWrite rejects payloads above the 4 MiB cap', async () => {
    const reg = new SerialPortRegistry();
    const { writable } = makeWritable();
    const port = makePort(undefined, writable);
    const handle = reg.register(port);
    await expect(
      serialOps.serialWrite(reg, handle, new Uint8Array(5 * 1024 * 1024))
    ).rejects.toThrow(/4 MiB/);
  });

  it('throws a clear error for an unknown handle', async () => {
    const reg = new SerialPortRegistry();
    await expect(serialOps.serialOpen(reg, 'serialX', { baudRate: 1 })).rejects.toThrow(
      /unknown serial handle/
    );
  });
});
