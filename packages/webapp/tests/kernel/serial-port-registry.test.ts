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
  // ── Re-enumeration wedge (#serial-stale-handle) ────────────────────────────
  // A board reset during flashing cycles the USB device, so getPorts() returns
  // a NEW SerialPort object. Before the fix the old object stayed registered
  // and its handle failed to open forever, recoverable only by reloading.

  it('serialList evicts entries whose port vanished after re-enumeration', async () => {
    const reg = new SerialPortRegistry();
    const before = makePort();
    const serial = { getPorts: vi.fn(async () => [before]) } as never;

    const first = await serialOps.serialList(reg, serial);
    expect(first[0]?.handle).toBe('serial1');

    // Device re-enumerates: same vid/pid, different object identity.
    const after = makePort();
    (serial as unknown as { getPorts: () => Promise<unknown[]> }).getPorts = async () => [after];

    const second = await serialOps.serialList(reg, serial);
    expect(second).toHaveLength(1);
    // The dead handle must be gone, not merely shadowed.
    expect(reg.get('serial1')).toBeUndefined();
    expect(reg.get(second[0]!.handle)?.port).toBe(after);
  });

  it('retainOnly returns evicted entries so the caller can retire them', () => {
    const reg = new SerialPortRegistry();
    const gone = makePort();
    const kept = makePort();
    const goneHandle = reg.register(gone);
    const keptHandle = reg.register(kept);
    reg.get(goneHandle)!.opened = true;

    const evicted = reg.retainOnly([kept]);
    expect(evicted.map((e) => e.handle)).toEqual([goneHandle]);
    // The entry is handed back still describing the live port, so the caller
    // can close it — dropping it silently would strand an open port.
    expect(evicted[0]!.entry.port).toBe(gone);
    expect(evicted[0]!.entry.opened).toBe(true);
    expect(reg.get(goneHandle)).toBeUndefined();
    expect(reg.get(keptHandle)?.port).toBe(kept);
  });

  it('opening a stale handle explains that it is stale', async () => {
    const reg = new SerialPortRegistry();
    const port = makePort();
    port.open = vi.fn(async () => {
      throw new Error('Failed to open serial port.');
    });
    const handle = reg.register(port);
    await expect(serialOps.serialOpen(reg, handle, { baudRate: 9600 })).rejects.toThrow(
      /may be stale after a device reset/
    );
  });

  it('serialClose is idempotent when the port is already closed', async () => {
    const reg = new SerialPortRegistry();
    const port = makePort();
    port.close = vi.fn(async () => {
      throw new Error('The port is already closed.');
    });
    const handle = reg.register(port);
    reg.get(handle)!.opened = true;
    await expect(serialOps.serialClose(reg, handle)).resolves.toBeUndefined();
    expect(reg.get(handle)?.opened).toBe(false);
  });

  it('serialClose keeps `opened` true when a genuine close fails', async () => {
    const reg = new SerialPortRegistry();
    const port = makePort();
    port.close = vi.fn(async () => {
      throw new Error('device disconnected mid-transfer');
    });
    const handle = reg.register(port);
    reg.get(handle)!.opened = true;
    await expect(serialOps.serialClose(reg, handle)).rejects.toThrow(/disconnected/);
    // The browser port may still be open. Claiming otherwise makes `serial list`
    // wrong and makes esptool's takeOverPort() skip its close.
    expect(reg.get(handle)?.opened).toBe(true);
  });

  it('serialList retires an evicted port that was still open and locked', async () => {
    const reg = new SerialPortRegistry();
    const { readable, reader } = makeReadable([]);
    const { writable, writer } = makeWritable();
    const stale = makePort(readable, writable);
    const handle = reg.register(stale);

    // Simulate a port left open with live stream locks (mid read/write).
    const entry = reg.get(handle)!;
    entry.opened = true;
    entry.reader = reader as unknown as ReadableStreamDefaultReader<Uint8Array>;
    entry.writer = writer as unknown as WritableStreamDefaultWriter<Uint8Array>;

    // Device re-enumerates: getPorts() now reports a different object.
    const fresh = makePort();
    const serial = { getPorts: vi.fn(async () => [fresh]) } as never;
    await serialOps.serialList(reg, serial);

    // Merely forgetting the entry would strand an open, locked port.
    expect(reader.cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
    expect(writer.releaseLock).toHaveBeenCalled();
    expect(stale.close).toHaveBeenCalled();
    expect(reg.get(handle)).toBeUndefined();
  });
});
