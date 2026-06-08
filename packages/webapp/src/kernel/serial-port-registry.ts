/**
 * Shared Web Serial port-handle registry.
 *
 * `SerialPort` objects are non-serializable, so they can never cross a
 * `postMessage` / `BroadcastChannel` boundary. The kernel worker (no
 * DOM) drives Web Serial through the panel-RPC bridge using opaque
 * string handles; this registry maps those handles to the live
 * `SerialPort` instances on the DOM side (standalone page or extension
 * realm). Mirrors `usb-device-registry.ts`.
 *
 * Unlike WebUSB, a `SerialPort` exposes no descriptor strings (only an
 * optional `usbVendorId` / `usbProductId` via `getInfo()`) and no
 * `opened` flag, so the registry entry carries the open state plus the
 * persistent reader/writer + leftover-byte buffer used across repeated
 * `serial read` / `serial write` calls.
 *
 * Minimal Web Serial types are declared here because the kernel-worker
 * typecheck runs against a no-DOM lib set; only the surface the `serial`
 * command uses is modeled.
 */

/** Open options accepted by `SerialPort.open()`. */
export interface SerialOpenOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

/** Control signals settable via `SerialPort.setSignals()`. */
export interface SerialOutputSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

/** Status signals returned by `SerialPort.getSignals()`. */
export interface SerialInputSignals {
  clearToSend: boolean;
  dataCarrierDetect: boolean;
  dataSetReady: boolean;
  ringIndicator: boolean;
}

/** Identifiers from `SerialPort.getInfo()` (USB-CDC ports only). */
export interface SerialPortInfoDict {
  usbVendorId?: number;
  usbProductId?: number;
}

/** Picker filter passed to `navigator.serial.requestPort()`. */
export interface SerialFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

/** The subset of `SerialPort` the registry and handlers touch. */
export interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfoDict;
  open(options: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: SerialOutputSignals): Promise<void>;
  getSignals(): Promise<SerialInputSignals>;
}

/** The subset of `navigator.serial` the registry helpers use. */
export interface SerialApi {
  getPorts(): Promise<SerialPort[]>;
  requestPort(options?: { filters?: SerialFilter[] }): Promise<SerialPort>;
}

/** Serializable port descriptor returned across the bridge. */
export interface SerialDeviceInfo {
  handle: string;
  usbVendorId?: number;
  usbProductId?: number;
  opened: boolean;
}

/** Per-handle live state held on the DOM side only. */
export interface SerialPortEntry {
  port: SerialPort;
  opened: boolean;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  pendingRead?: Promise<ReadableStreamReadResult<Uint8Array>>;
  leftover?: Uint8Array;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

/** Read `navigator.serial` from the current realm, or null when absent. */
export function getNavigatorSerial(): SerialApi | null {
  const nav = (globalThis as { navigator?: { serial?: SerialApi } }).navigator;
  return nav?.serial ?? null;
}

/** In-memory `handle → SerialPortEntry` map for a single DOM realm. */
export class SerialPortRegistry {
  private byHandle = new Map<string, SerialPortEntry>();
  private counter = 0;

  /** Register a port, returning a stable handle (dedupes by identity). */
  register(port: SerialPort): string {
    for (const [handle, entry] of this.byHandle) {
      if (entry.port === port) return handle;
    }
    const handle = `serial${++this.counter}`;
    this.byHandle.set(handle, { port, opened: false });
    return handle;
  }

  get(handle: string): SerialPortEntry | undefined {
    return this.byHandle.get(handle);
  }

  remove(handle: string): boolean {
    return this.byHandle.delete(handle);
  }

  list(): Array<{ handle: string; entry: SerialPortEntry }> {
    return [...this.byHandle].map(([handle, entry]) => ({ handle, entry }));
  }
}

let sharedRegistry: SerialPortRegistry | null = null;

/** The per-realm shared registry instance. */
export function getSharedSerialRegistry(): SerialPortRegistry {
  if (!sharedRegistry) sharedRegistry = new SerialPortRegistry();
  return sharedRegistry;
}

/** Maximum bytes for a single read/write (v1 cap). */
export const MAX_SERIAL_TRANSFER_BYTES = 4 * 1024 * 1024;

/** Default `serial read` timeout when `--timeout-ms` is omitted. */
export const DEFAULT_SERIAL_READ_TIMEOUT_MS = 1000;

/** Build the serializable descriptor for a registered port entry. */
export function deviceToInfo(handle: string, entry: SerialPortEntry): SerialDeviceInfo {
  const info = entry.port.getInfo();
  return {
    handle,
    ...(info.usbVendorId !== undefined ? { usbVendorId: info.usbVendorId } : {}),
    ...(info.usbProductId !== undefined ? { usbProductId: info.usbProductId } : {}),
    opened: entry.opened,
  };
}
