/**
 * `realm-serial-bridge.ts` — the realm `serial` global mirroring Web Serial.
 * Extracted from `js-realm-shared.ts`; no behavior change.
 */
import type {
  SerialDeviceInfo,
  SerialFilter,
  SerialInputSignals,
  SerialOpenOptions,
  SerialOutputSignals,
} from '../serial-port-registry.js';
import { asFilterArray, type DeviceRpc, toRealmBytes } from './realm-device-shared.js';

/** Params accepted by `port.read()`. `bytes` is an alias for `maxBytes`. */
export interface RealmSerialReadParams {
  bytes?: number;
  maxBytes?: number;
  until?: ArrayBuffer | ArrayBufferView;
  timeoutMs?: number;
}

/** A realm-facing Web Serial port. Methods carry the opaque handle. */
export interface RealmSerialPort extends SerialDeviceInfo {
  open(options: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  read(params?: RealmSerialReadParams): Promise<Uint8Array>;
  write(data: ArrayBuffer | ArrayBufferView): Promise<number>;
  getSignals(): Promise<SerialInputSignals>;
  setSignals(signals: SerialOutputSignals): Promise<void>;
}

export interface RealmSerialApi {
  list(): Promise<RealmSerialPort[]>;
  request(filters?: SerialFilter | SerialFilter[]): Promise<RealmSerialPort>;
}

function makeSerialPort(rpc: DeviceRpc, info: SerialDeviceInfo): RealmSerialPort {
  const h = info.handle;
  return {
    ...info,
    open: (options) => rpc.call<void>('serial', 'open', [h, options]),
    close: () => rpc.call<void>('serial', 'close', [h]),
    read: (params = {}) =>
      rpc.call<Uint8Array>('serial', 'read', [
        h,
        {
          maxBytes: params.maxBytes ?? params.bytes,
          until: params.until ? toRealmBytes(params.until) : undefined,
          timeoutMs: params.timeoutMs,
        },
      ]),
    write: (data) => rpc.call<number>('serial', 'write', [h, toRealmBytes(data)]),
    getSignals: () => rpc.call<SerialInputSignals>('serial', 'getSignals', [h]),
    setSignals: (signals) => rpc.call<void>('serial', 'setSignals', [h, signals]),
  };
}

/** Build the realm `serial` global. Exported for parity / unit tests. */
export function createSerialBridge(rpc: DeviceRpc): RealmSerialApi {
  return {
    list: async () =>
      (await rpc.call<SerialDeviceInfo[]>('serial', 'list', [])).map((i) => makeSerialPort(rpc, i)),
    request: async (filters) =>
      makeSerialPort(
        rpc,
        await rpc.call<SerialDeviceInfo>('serial', 'request', [asFilterArray(filters)])
      ),
  };
}
