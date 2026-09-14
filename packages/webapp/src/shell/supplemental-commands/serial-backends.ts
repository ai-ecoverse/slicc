import type { PanelRpcClient } from '../../kernel/panel-rpc.js';
import * as serialOps from '../../kernel/serial-operations.js';
import {
  deviceToInfo,
  getNavigatorSerial,
  getSharedSerialRegistry,
  type SerialDeviceInfo,
  type SerialFilter,
  type SerialInputSignals,
  type SerialOpenOptions,
  type SerialOutputSignals,
  type SerialPort,
  type SerialPortRegistry,
} from '../../kernel/serial-port-registry.js';
import { canOpenSerialPickerPopup, openSerialPickerPopup } from './serial-picker.js';

export interface SerialReadParams {
  maxBytes?: number;
  until?: Uint8Array;
  timeoutMs?: number;
}

export interface SerialBackend {
  list(): Promise<SerialDeviceInfo[]>;
  request(filters: SerialFilter[]): Promise<SerialDeviceInfo>;
  info(handle: string): Promise<SerialDeviceInfo>;
  open(handle: string, options: SerialOpenOptions): Promise<void>;
  close(handle: string): Promise<void>;
  read(handle: string, params: SerialReadParams): Promise<Uint8Array>;
  write(handle: string, bytes: Uint8Array): Promise<number>;
  getSignals(handle: string): Promise<SerialInputSignals>;
  setSignals(handle: string, signals: SerialOutputSignals): Promise<void>;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

class LocalSerialBackend implements SerialBackend {
  constructor(private registry: SerialPortRegistry) {}
  private serial() {
    const serial = getNavigatorSerial();
    if (!serial) throw new Error('Web Serial is unavailable in this browser');
    return serial;
  }
  list() {
    return serialOps.serialList(this.registry, this.serial());
  }
  async request(filters: SerialFilter[]): Promise<SerialDeviceInfo> {
    if (canOpenSerialPickerPopup()) {
      const res = await openSerialPickerPopup(filters);
      if ('cancelled' in res) throw new Error('user cancelled the serial picker');
      if ('error' in res) throw new Error(res.error);
      const port = await this.reacquire(res.info);
      if (!port) throw new Error('granted port could not be re-acquired');
      const handle = this.registry.register(port);
      return deviceToInfo(handle, this.registry.get(handle)!);
    }
    return serialOps.serialRequest(this.registry, this.serial(), filters);
  }
  private async reacquire(ids: {
    usbVendorId?: number;
    usbProductId?: number;
  }): Promise<SerialPort | null> {
    const ports = await this.serial().getPorts();
    const matches = ports.filter((p) => {
      const info = p.getInfo();
      if (ids.usbVendorId !== undefined && info.usbVendorId !== ids.usbVendorId) return false;
      if (ids.usbProductId !== undefined && info.usbProductId !== ids.usbProductId) return false;
      return true;
    });
    const candidates = matches.length ? matches : ports;
    const registered = this.registry.list().map((e) => e.entry.port);
    const fresh = candidates.find((p) => !registered.includes(p));
    return fresh ?? candidates[0] ?? null;
  }
  info(handle: string) {
    return Promise.resolve(serialOps.serialDeviceInfo(this.registry, handle));
  }
  open(handle: string, options: SerialOpenOptions) {
    return serialOps.serialOpen(this.registry, handle, options);
  }
  close(handle: string) {
    return serialOps.serialClose(this.registry, handle);
  }
  read(handle: string, params: SerialReadParams) {
    return serialOps.serialRead(this.registry, handle, params);
  }
  write(handle: string, bytes: Uint8Array) {
    return serialOps.serialWrite(this.registry, handle, bytes);
  }
  getSignals(handle: string) {
    return serialOps.serialGetSignals(this.registry, handle);
  }
  setSignals(handle: string, signals: SerialOutputSignals) {
    return serialOps.serialSetSignals(this.registry, handle, signals);
  }
}

class BridgedSerialBackend implements SerialBackend {
  constructor(private rpc: PanelRpcClient) {}

  private static REQUEST_TIMEOUT_MS = 5 * 60_000;

  private static READ_MARGIN_MS = 30_000;

  async list() {
    return (await this.rpc.call('serial-list', undefined)).devices;
  }
  async request(filters: SerialFilter[]) {
    return (
      await this.rpc.call(
        'serial-request',
        { filters },
        { timeoutMs: BridgedSerialBackend.REQUEST_TIMEOUT_MS }
      )
    ).device;
  }
  async info(handle: string) {
    return (await this.rpc.call('serial-device-info', { handle })).device;
  }
  async open(handle: string, options: SerialOpenOptions) {
    await this.rpc.call('serial-open', { handle, options });
  }
  async close(handle: string) {
    await this.rpc.call('serial-close', { handle });
  }
  async read(handle: string, params: SerialReadParams) {
    const timeoutMs = (params.timeoutMs ?? 1000) + BridgedSerialBackend.READ_MARGIN_MS;
    const r = await this.rpc.call(
      'serial-read',
      {
        handle,
        maxBytes: params.maxBytes,
        until: params.until ? toArrayBuffer(params.until) : undefined,
        timeoutMs: params.timeoutMs,
      },
      { timeoutMs }
    );
    return new Uint8Array(r.bytes);
  }
  async write(handle: string, bytes: Uint8Array) {
    return (await this.rpc.call('serial-write', { handle, bytes: toArrayBuffer(bytes) }))
      .bytesWritten;
  }
  async getSignals(handle: string) {
    return (await this.rpc.call('serial-get-signals', { handle })).signals;
  }
  async setSignals(handle: string, signals: SerialOutputSignals) {
    await this.rpc.call('serial-set-signals', { handle, signals });
  }
}

export function resolveSerialBackend(
  hasLocalDom: boolean,
  panelRpc: PanelRpcClient | null
): SerialBackend | null {
  if (hasLocalDom && getNavigatorSerial()) {
    return new LocalSerialBackend(getSharedSerialRegistry());
  }
  if (panelRpc) {
    return new BridgedSerialBackend(panelRpc);
  }
  return null;
}
