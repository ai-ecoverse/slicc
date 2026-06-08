/**
 * Pure Web Serial operations over a {@link SerialPortRegistry}.
 *
 * Shared by the page-side panel-RPC handlers (`ui/panel-rpc-handlers.ts`)
 * and the local-DOM backend of the `serial` shell command so both code
 * paths apply identical handle resolution, the 4 MiB transfer cap, and
 * the same serializable result shapes. Reads stream the port's
 * `ReadableStream` in chunks and race each chunk against a deadline; the
 * registry entry keeps the live reader, a pending-read promise, and any
 * leftover bytes so repeated `serial read` calls don't drop data.
 */

import {
  DEFAULT_SERIAL_READ_TIMEOUT_MS,
  deviceToInfo,
  MAX_SERIAL_TRANSFER_BYTES,
  type SerialApi,
  type SerialDeviceInfo,
  type SerialFilter,
  type SerialInputSignals,
  type SerialOpenOptions,
  type SerialOutputSignals,
  type SerialPortEntry,
  type SerialPortRegistry,
} from './serial-port-registry.js';

export interface SerialReadOptions {
  maxBytes?: number;
  until?: Uint8Array;
  timeoutMs?: number;
}

function resolve(registry: SerialPortRegistry, handle: string): SerialPortEntry {
  const entry = registry.get(handle);
  if (!entry) throw new Error(`unknown serial handle '${handle}'`);
  return entry;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function indexOfSub(hay: Uint8Array, needle: Uint8Array, start: number): number {
  if (needle.length === 0) return -1;
  outer: for (let i = Math.max(0, start); i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export async function serialList(
  registry: SerialPortRegistry,
  serial: SerialApi
): Promise<SerialDeviceInfo[]> {
  const ports = await serial.getPorts();
  return ports.map((p) => {
    const handle = registry.register(p);
    return deviceToInfo(handle, registry.get(handle)!);
  });
}

export async function serialRequest(
  registry: SerialPortRegistry,
  serial: SerialApi,
  filters: SerialFilter[]
): Promise<SerialDeviceInfo> {
  const port = await serial.requestPort(filters.length ? { filters } : {});
  const handle = registry.register(port);
  return deviceToInfo(handle, registry.get(handle)!);
}

export function serialDeviceInfo(registry: SerialPortRegistry, handle: string): SerialDeviceInfo {
  return deviceToInfo(handle, resolve(registry, handle));
}

export async function serialOpen(
  registry: SerialPortRegistry,
  handle: string,
  options: SerialOpenOptions
): Promise<void> {
  const entry = resolve(registry, handle);
  await entry.port.open(options);
  entry.opened = true;
}

export async function serialClose(registry: SerialPortRegistry, handle: string): Promise<void> {
  const entry = resolve(registry, handle);
  if (entry.reader) {
    try {
      await entry.reader.cancel();
    } catch {
      /* reader may already be closed */
    }
    try {
      entry.reader.releaseLock();
    } catch {
      /* lock may already be released */
    }
    entry.reader = undefined;
  }
  entry.pendingRead = undefined;
  entry.leftover = undefined;
  if (entry.writer) {
    try {
      entry.writer.releaseLock();
    } catch {
      /* lock may already be released */
    }
    entry.writer = undefined;
  }
  await entry.port.close();
  entry.opened = false;
}

function getReader(entry: SerialPortEntry): ReadableStreamDefaultReader<Uint8Array> {
  if (!entry.reader) {
    if (!entry.port.readable) throw new Error('serial port is not readable (is it open?)');
    entry.reader = entry.port.readable.getReader();
  }
  return entry.reader;
}

function getWriter(entry: SerialPortEntry): WritableStreamDefaultWriter<Uint8Array> {
  if (!entry.writer) {
    if (!entry.port.writable) throw new Error('serial port is not writable (is it open?)');
    entry.writer = entry.port.writable.getWriter();
  }
  return entry.writer;
}

/**
 * Read from the port until `maxBytes` is reached, the `until` delimiter
 * is seen, or the timeout elapses — whichever comes first. Excess bytes
 * past the cut point are stashed on the entry as `leftover` so the next
 * call resumes cleanly; a chunk that arrives after the timeout is kept
 * as `pendingRead` for the same reason.
 */
export async function serialRead(
  registry: SerialPortRegistry,
  handle: string,
  opts: SerialReadOptions
): Promise<Uint8Array> {
  const entry = resolve(registry, handle);
  const maxBytes = Math.min(opts.maxBytes ?? MAX_SERIAL_TRANSFER_BYTES, MAX_SERIAL_TRANSFER_BYTES);
  const until = opts.until?.length ? opts.until : undefined;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SERIAL_READ_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);

  let acc = entry.leftover ?? new Uint8Array(0);
  entry.leftover = undefined;
  let searchFrom = 0;

  const settle = (): Uint8Array | null => {
    if (until) {
      const idx = indexOfSub(acc, until, Math.max(0, searchFrom - (until.length - 1)));
      if (idx >= 0) {
        const end = idx + until.length;
        entry.leftover = acc.slice(end);
        return acc.slice(0, end);
      }
    }
    if (acc.length >= maxBytes) {
      entry.leftover = acc.slice(maxBytes);
      return acc.slice(0, maxBytes);
    }
    return null;
  };

  const fromLeftover = settle();
  if (fromLeftover) return fromLeftover;

  const reader = getReader(entry);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const readPromise = entry.pendingRead ?? reader.read();
    entry.pendingRead = readPromise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'__timeout'>((res) => {
      timer = setTimeout(() => res('__timeout'), remaining);
    });
    let result: ReadableStreamReadResult<Uint8Array> | '__timeout';
    try {
      result = await Promise.race([readPromise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result === '__timeout') break;
    entry.pendingRead = undefined;
    if (result.done) {
      entry.reader = undefined;
      break;
    }
    if (result.value?.length) {
      searchFrom = acc.length;
      acc = concat(acc, result.value);
      const done = settle();
      if (done) return done;
    }
  }
  return acc;
}

export async function serialWrite(
  registry: SerialPortRegistry,
  handle: string,
  bytes: Uint8Array
): Promise<number> {
  if (bytes.length > MAX_SERIAL_TRANSFER_BYTES) {
    throw new Error(
      `serial write payload exceeds the ${MAX_SERIAL_TRANSFER_BYTES}-byte (4 MiB) v1 limit`
    );
  }
  const entry = resolve(registry, handle);
  const writer = getWriter(entry);
  await writer.write(bytes);
  return bytes.length;
}

export async function serialGetSignals(
  registry: SerialPortRegistry,
  handle: string
): Promise<SerialInputSignals> {
  return resolve(registry, handle).port.getSignals();
}

export async function serialSetSignals(
  registry: SerialPortRegistry,
  handle: string,
  signals: SerialOutputSignals
): Promise<void> {
  await resolve(registry, handle).port.setSignals(signals);
}
