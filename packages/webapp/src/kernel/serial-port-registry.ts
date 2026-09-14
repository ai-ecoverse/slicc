export interface SerialOpenOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

export interface SerialOutputSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

export interface SerialInputSignals {
  clearToSend: boolean;
  dataCarrierDetect: boolean;
  dataSetReady: boolean;
  ringIndicator: boolean;
}

export interface SerialPortInfoDict {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfoDict;
  open(options: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: SerialOutputSignals): Promise<void>;
  getSignals(): Promise<SerialInputSignals>;
}

export interface SerialApi {
  getPorts(): Promise<SerialPort[]>;
  requestPort(options?: { filters?: SerialFilter[] }): Promise<SerialPort>;
}

export interface SerialDeviceInfo {
  handle: string;
  usbVendorId?: number;
  usbProductId?: number;
  opened: boolean;
}

export interface SerialPortEntry {
  port: SerialPort;
  opened: boolean;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  pendingRead?: Promise<ReadableStreamReadResult<Uint8Array>>;
  leftover?: Uint8Array;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

export function getNavigatorSerial(): SerialApi | null {
  const nav = (globalThis as { navigator?: { serial?: SerialApi } }).navigator;
  return nav?.serial ?? null;
}

export class SerialPortRegistry {
  private byHandle = new Map<string, SerialPortEntry>();
  private counter = 0;

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

  retainOnly(live: readonly SerialPort[]): Array<{ handle: string; entry: SerialPortEntry }> {
    const evicted: Array<{ handle: string; entry: SerialPortEntry }> = [];
    for (const [handle, entry] of [...this.byHandle]) {
      if (live.includes(entry.port)) continue;
      this.byHandle.delete(handle);
      evicted.push({ handle, entry });
    }
    return evicted;
  }
}

let sharedRegistry: SerialPortRegistry | null = null;

export function getSharedSerialRegistry(): SerialPortRegistry {
  if (!sharedRegistry) sharedRegistry = new SerialPortRegistry();
  return sharedRegistry;
}

export const MAX_SERIAL_TRANSFER_BYTES = 4 * 1024 * 1024;

export const DEFAULT_SERIAL_READ_TIMEOUT_MS = 1000;

export function deviceToInfo(handle: string, entry: SerialPortEntry): SerialDeviceInfo {
  const info = entry.port.getInfo();
  return {
    handle,
    ...(info.usbVendorId !== undefined ? { usbVendorId: info.usbVendorId } : {}),
    ...(info.usbProductId !== undefined ? { usbProductId: info.usbProductId } : {}),
    opened: entry.opened,
  };
}
