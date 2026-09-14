/**
 * `realm-usb-bridge.ts` — the realm `usb` global mirroring WebUSB.
 * Extracted from `js-realm-shared.ts`. Devices expose `disconnect` /
 * `claim-lost` so a consumer displaced by another handle user is told
 * rather than left inferring from a failed transfer.
 */
import type {
  UsbClaimEvent,
  UsbControlSetup,
  UsbDeviceFilter,
  UsbDeviceInfo,
} from '../usb-device-registry.js';
import {
  asFilterArray,
  bytesToDataView,
  type DeviceRpc,
  toRealmBytes,
  type WireInResult,
  type WireOutResult,
} from './realm-device-shared.js';

/** Event payload delivered to `device.addEventListener('disconnect', cb)`. */
export type RealmUsbDisconnectEvent = UsbClaimEvent;
/** Event payload delivered to `device.addEventListener('claim-lost', cb)`. */
export type RealmUsbClaimLostEvent = UsbClaimEvent;

export type RealmUsbEventType = 'disconnect' | 'claim-lost';
export type RealmUsbEventListener = (event: UsbClaimEvent) => void;

/** A realm-facing WebUSB device. Methods carry the opaque handle. */
export interface RealmUsbDevice extends UsbDeviceInfo {
  open(): Promise<void>;
  close(opts?: { force?: boolean }): Promise<void>;
  reset(opts?: { force?: boolean }): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(interfaceNumber: number, opts?: { wait?: boolean }): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  controlTransferIn(
    setup: UsbControlSetup,
    length: number
  ): Promise<{ status: string; data: DataView }>;
  controlTransferOut(
    setup: UsbControlSetup,
    data: ArrayBuffer | ArrayBufferView
  ): Promise<WireOutResult>;
  transferIn(endpointNumber: number, length: number): Promise<{ status: string; data: DataView }>;
  transferOut(endpointNumber: number, data: ArrayBuffer | ArrayBufferView): Promise<WireOutResult>;
  clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>;
  addEventListener(type: 'disconnect', listener: RealmUsbEventListener): void;
  addEventListener(type: 'claim-lost', listener: RealmUsbEventListener): void;
  addEventListener(type: RealmUsbEventType, listener: RealmUsbEventListener): void;
  removeEventListener(type: 'disconnect', listener: RealmUsbEventListener): void;
  removeEventListener(type: 'claim-lost', listener: RealmUsbEventListener): void;
  removeEventListener(type: RealmUsbEventType, listener: RealmUsbEventListener): void;
}

export interface RealmUsbApi {
  list(): Promise<RealmUsbDevice[]>;
  request(filters?: UsbDeviceFilter | UsbDeviceFilter[]): Promise<RealmUsbDevice>;
}

function makeUsbDevice(rpc: DeviceRpc, info: UsbDeviceInfo): RealmUsbDevice {
  const h = info.handle;
  const toData = (r: WireInResult) => ({ status: r.status, data: bytesToDataView(r.bytes) });
  const disconnectListeners = new Set<RealmUsbEventListener>();
  const claimLostListeners = new Set<RealmUsbEventListener>();
  let subscribed = false;
  let offRpcEvent: (() => void) | null = null;

  const dispatchClaimEvent = (payload: unknown): void => {
    const event = payload as UsbClaimEvent | null | undefined;
    if (!event || event.handle !== h) return;
    const listeners = event.type === 'disconnect' ? disconnectListeners : claimLostListeners;
    for (const cb of [...listeners]) {
      try {
        cb(event);
      } catch {
        // Listener faults are swallowed — mirrors the HID fan-out.
      }
    }
  };

  const ensureSubscription = (): void => {
    if (subscribed) return;
    subscribed = true;
    offRpcEvent = rpc.onEvent ? rpc.onEvent('usb-claim-event', dispatchClaimEvent) : null;
    void rpc.call<void>('usb', 'subscribeClaimEvents', [h]).catch(() => {
      subscribed = false;
      offRpcEvent?.();
      offRpcEvent = null;
    });
  };

  const maybeUnsubscribe = (): void => {
    if (!subscribed || disconnectListeners.size > 0 || claimLostListeners.size > 0) return;
    subscribed = false;
    offRpcEvent?.();
    offRpcEvent = null;
    void rpc.call<void>('usb', 'unsubscribeClaimEvents', [h]).catch(() => {
      /* best-effort teardown */
    });
  };

  return {
    ...info,
    open: () => rpc.call<void>('usb', 'open', [h]),
    close: (opts) => rpc.call<void>('usb', 'close', opts?.force ? [h, { force: true }] : [h]),
    reset: (opts) => rpc.call<void>('usb', 'reset', opts?.force ? [h, { force: true }] : [h]),
    clearHalt: (direction, endpointNumber) =>
      rpc.call<void>('usb', 'clearHalt', [h, direction, endpointNumber]),
    selectConfiguration: (value) => rpc.call<void>('usb', 'selectConfig', [h, value]),
    claimInterface: (n, opts) =>
      rpc.call<void>('usb', 'claim', opts?.wait ? [h, n, { wait: true }] : [h, n]),
    releaseInterface: (n) => rpc.call<void>('usb', 'release', [h, n]),
    controlTransferIn: async (setup, length) =>
      toData(await rpc.call<WireInResult>('usb', 'controlIn', [h, setup, length])),
    controlTransferOut: (setup, data) =>
      rpc.call<WireOutResult>('usb', 'controlOut', [h, setup, toRealmBytes(data)]),
    transferIn: async (ep, length) =>
      toData(await rpc.call<WireInResult>('usb', 'transferIn', [h, ep, length])),
    transferOut: (ep, data) =>
      rpc.call<WireOutResult>('usb', 'transferOut', [h, ep, toRealmBytes(data)]),
    addEventListener(type: RealmUsbEventType, listener: RealmUsbEventListener): void {
      if (type === 'disconnect') disconnectListeners.add(listener);
      else if (type === 'claim-lost') claimLostListeners.add(listener);
      else throw new TypeError(`usb device: unknown event type '${String(type)}'`);
      ensureSubscription();
    },
    removeEventListener(type: RealmUsbEventType, listener: RealmUsbEventListener): void {
      if (type === 'disconnect') disconnectListeners.delete(listener);
      else if (type === 'claim-lost') claimLostListeners.delete(listener);
      maybeUnsubscribe();
    },
  };
}

/** Build the realm `usb` global. Exported for parity / unit tests. */
export function createUsbBridge(rpc: DeviceRpc): RealmUsbApi {
  return {
    list: async () =>
      (await rpc.call<UsbDeviceInfo[]>('usb', 'list', [])).map((i) => makeUsbDevice(rpc, i)),
    request: async (filters) =>
      makeUsbDevice(rpc, await rpc.call<UsbDeviceInfo>('usb', 'request', [asFilterArray(filters)])),
  };
}
