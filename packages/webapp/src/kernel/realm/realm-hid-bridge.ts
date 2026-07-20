/**
 * `realm-hid-bridge.ts` — the realm `hid` global mirroring WebHID, including
 * per-device input-report / disconnect event subscription bookkeeping.
 * Extracted from `js-realm-shared.ts`; no behavior change.
 */
import type { HidDeviceFilter, HidDeviceInfo } from '../hid-device-registry.js';
import {
  asFilterArray,
  bytesToDataView,
  type DeviceRpc,
  toRealmBytes,
} from './realm-device-shared.js';

/** Event payload delivered to `device.addEventListener('inputreport', cb)`. */
export interface RealmHidInputReportEvent {
  reportId: number;
  data: DataView;
}

/** Event payload delivered to `device.addEventListener('disconnect', cb)`. */
export interface RealmHidDisconnectEvent {
  handle: string;
}

export type RealmHidEventType = 'inputreport' | 'disconnect';
export type RealmHidInputReportListener = (event: RealmHidInputReportEvent) => void;
export type RealmHidDisconnectListener = (event: RealmHidDisconnectEvent) => void;
export type RealmHidEventListener = RealmHidInputReportListener | RealmHidDisconnectListener;

/**
 * A realm-facing WebHID device. Methods carry the opaque handle. Event
 * methods mirror `EventTarget` semantics so VIA-style request/response
 * (`addEventListener('inputreport', cb)` → `sendReport()` → cb fires)
 * runs as one script in `node -e` / `.jsh`. The first `'inputreport'`
 * listener lazily kicks the host into subscribing to backend reports;
 * the last `removeEventListener` (or realm teardown via `rpc.dispose()`)
 * unsubscribes so no leaked listeners survive. `'disconnect'` registers
 * but stays inert today — the backend has no navigator-level disconnect
 * relay yet (sibling task).
 */
export interface RealmHidDevice extends HidDeviceInfo {
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: ArrayBuffer | ArrayBufferView): Promise<void>;
  sendFeatureReport(reportId: number, data: ArrayBuffer | ArrayBufferView): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener(type: 'inputreport', listener: RealmHidInputReportListener): void;
  addEventListener(type: 'disconnect', listener: RealmHidDisconnectListener): void;
  addEventListener(type: RealmHidEventType, listener: RealmHidEventListener): void;
  removeEventListener(type: 'inputreport', listener: RealmHidInputReportListener): void;
  removeEventListener(type: 'disconnect', listener: RealmHidDisconnectListener): void;
  removeEventListener(type: RealmHidEventType, listener: RealmHidEventListener): void;
  /** Alias for `addEventListener('inputreport', cb)`. */
  onInputReport(listener: RealmHidInputReportListener): void;
}

export interface RealmHidApi {
  list(): Promise<RealmHidDevice[]>;
  request(filters?: HidDeviceFilter | HidDeviceFilter[]): Promise<RealmHidDevice>;
}

interface HidEventPayload {
  handle: string;
  reportId: number;
  bytes: Uint8Array;
}

function makeHidDevice(rpc: DeviceRpc, info: HidDeviceInfo): RealmHidDevice {
  const h = info.handle;
  const inputListeners = new Set<RealmHidInputReportListener>();
  const disconnectListeners = new Set<RealmHidDisconnectListener>();
  // `inputSubscribed` toggles synchronously with the first/last listener
  // so concurrent `addEventListener` calls don't race the subscribe RPC.
  // A failed subscribe rolls the flag back so the next add retries.
  let inputSubscribed = false;
  let offRpcEvent: (() => void) | null = null;

  const dispatchInput = (payload: unknown): void => {
    const p = payload as HidEventPayload | null | undefined;
    if (!p || p.handle !== h) return;
    const event: RealmHidInputReportEvent = {
      reportId: p.reportId,
      data: bytesToDataView(p.bytes),
    };
    for (const cb of [...inputListeners]) {
      try {
        cb(event);
      } catch {
        // Listener faults are swallowed — mirrors the event-fan-out
        // pattern in `RealmRpcClient.onEvent` / `panel-rpc.ts`. The
        // realm host process keeps streaming reports to peers.
      }
    }
  };

  const ensureInputSubscription = (): void => {
    if (inputSubscribed) return;
    inputSubscribed = true;
    offRpcEvent = rpc.onEvent ? rpc.onEvent('hid-input-report', dispatchInput) : null;
    void rpc.call<void>('hid', 'subscribeInputReports', [h]).catch(() => {
      // Backend subscribe failed (e.g. device closed in another realm).
      // Roll back so a fresh listener add can retry; detach the local
      // RPC subscriber to avoid leaking the fan-out callback.
      inputSubscribed = false;
      offRpcEvent?.();
      offRpcEvent = null;
    });
  };

  const maybeUnsubscribeInput = (): void => {
    if (!inputSubscribed || inputListeners.size > 0) return;
    inputSubscribed = false;
    offRpcEvent?.();
    offRpcEvent = null;
    void rpc.call<void>('hid', 'unsubscribeInputReports', [h]).catch(() => {
      // Best-effort teardown — the realm-host disposer drains stragglers.
    });
  };

  return {
    ...info,
    open: () => rpc.call<void>('hid', 'open', [h]),
    close: () => rpc.call<void>('hid', 'close', [h]),
    sendReport: (reportId, data) =>
      rpc.call<void>('hid', 'sendReport', [h, reportId, toRealmBytes(data)]),
    sendFeatureReport: (reportId, data) =>
      rpc.call<void>('hid', 'sendFeatureReport', [h, reportId, toRealmBytes(data)]),
    receiveFeatureReport: async (reportId) => {
      const r = await rpc.call<{ reportId: number; bytes: Uint8Array }>(
        'hid',
        'receiveFeatureReport',
        [h, reportId]
      );
      return bytesToDataView(r.bytes);
    },
    addEventListener(type: RealmHidEventType, listener: RealmHidEventListener): void {
      if (type === 'inputreport') {
        inputListeners.add(listener as RealmHidInputReportListener);
        ensureInputSubscription();
      } else if (type === 'disconnect') {
        disconnectListeners.add(listener as RealmHidDisconnectListener);
      } else {
        throw new TypeError(`hid device: unknown event type '${String(type)}'`);
      }
    },
    removeEventListener(type: RealmHidEventType, listener: RealmHidEventListener): void {
      if (type === 'inputreport') {
        inputListeners.delete(listener as RealmHidInputReportListener);
        maybeUnsubscribeInput();
      } else if (type === 'disconnect') {
        disconnectListeners.delete(listener as RealmHidDisconnectListener);
      }
    },
    onInputReport(listener: RealmHidInputReportListener): void {
      inputListeners.add(listener);
      ensureInputSubscription();
    },
  };
}

/** Build the realm `hid` global. Exported for parity / unit tests. */
export function createHidBridge(rpc: DeviceRpc): RealmHidApi {
  return {
    list: async () =>
      (await rpc.call<HidDeviceInfo[]>('hid', 'list', [])).map((i) => makeHidDevice(rpc, i)),
    request: async (filters) => {
      // The backend grants every interface of a multi-interface device
      // (e.g. VIA/QMK keyboards) and returns the full list; the realm
      // surface keeps a single-device shape and exposes the first
      // granted interface. Realm code that needs a specific interface
      // can fall back to `hid.list()` for siblings.
      const granted = await rpc.call<HidDeviceInfo[]>('hid', 'request', [asFilterArray(filters)]);
      const info = granted[0];
      if (!info) throw new Error('No device selected.');
      return makeHidDevice(rpc, info);
    },
  };
}
