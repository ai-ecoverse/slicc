/**
 * Execution backends for the `hid` shell command.
 *
 * `LocalHidBackend` runs in a DOM realm (standalone panel terminal,
 * extension side-panel/offscreen shell) and talks to `navigator.hid`
 * directly via the shared `hid-operations` helpers. `BridgedHidBackend`
 * runs in the kernel worker (no DOM) and forwards every op to the page
 * over panel-RPC. Both expose the same handle-keyed surface returning
 * `Uint8Array` payloads so the command body is backend-agnostic.
 *
 * Input-report subscriptions stream over the bridge: the local backend
 * attaches an `inputreport` listener directly; the bridged backend
 * registers a `hid-input-report` event subscriber on the panel-RPC
 * client and drives the page-side listener via subscribe/unsubscribe
 * ops. Mirrors `usb-backends.ts`.
 */

import {
  getNavigatorHid,
  getSharedHidRegistry,
  type HidDeviceFilter,
  type HidDeviceHandleRegistry,
  type HidDeviceInfo,
  hidDeviceToInfo,
} from '../../kernel/hid-device-registry.js';
import * as hidOps from '../../kernel/hid-operations.js';
import type { HidInputReportEventPayload, PanelRpcClient } from '../../kernel/panel-rpc.js';
import { canOpenHidPickerPopup, openHidPickerPopup } from './hid-picker.js';

export interface HidInputReport {
  reportId: number;
  bytes: Uint8Array;
}

export interface HidBackend {
  list(): Promise<HidDeviceInfo[]>;
  request(filters: HidDeviceFilter[]): Promise<HidDeviceInfo>;
  info(handle: string): Promise<HidDeviceInfo>;
  open(handle: string): Promise<void>;
  close(handle: string): Promise<void>;
  sendReport(handle: string, reportId: number, bytes: Uint8Array): Promise<void>;
  sendFeatureReport(handle: string, reportId: number, bytes: Uint8Array): Promise<void>;
  receiveFeatureReport(handle: string, reportId: number): Promise<HidInputReport>;
  subscribeInputReports(
    handle: string,
    onReport: (report: HidInputReport) => void
  ): Promise<() => void | Promise<void>>;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

class LocalHidBackend implements HidBackend {
  constructor(private registry: HidDeviceHandleRegistry) {}
  private hid() {
    const hid = getNavigatorHid();
    if (!hid) throw new Error('WebHID is unavailable in this browser');
    return hid;
  }
  list() {
    return hidOps.hidList(this.registry, this.hid());
  }
  async request(filters: HidDeviceFilter[]): Promise<HidDeviceInfo> {
    // Extension realms must route the chooser through a popup window;
    // the side panel cannot host `requestDevice` reliably.
    if (canOpenHidPickerPopup()) {
      const res = await openHidPickerPopup(filters);
      if ('cancelled' in res) throw new Error('user cancelled the HID picker');
      if ('error' in res) throw new Error(res.error);
      const device = await this.reacquire(res.info);
      if (!device) throw new Error('granted device could not be re-acquired');
      return hidDeviceToInfo(this.registry.register(device), device);
    }
    return hidOps.hidRequest(this.registry, this.hid(), filters);
  }
  private async reacquire(info: { vendorId: number; productId: number }) {
    const devices = await this.hid().getDevices();
    return devices.find((d) => d.vendorId === info.vendorId && d.productId === info.productId);
  }
  info(handle: string) {
    return Promise.resolve(hidOps.hidDeviceInfo(this.registry, handle));
  }
  open(handle: string) {
    return hidOps.hidOpen(this.registry, handle);
  }
  close(handle: string) {
    return hidOps.hidClose(this.registry, handle);
  }
  sendReport(handle: string, reportId: number, bytes: Uint8Array) {
    return hidOps.hidSendReport(this.registry, handle, reportId, toArrayBuffer(bytes));
  }
  sendFeatureReport(handle: string, reportId: number, bytes: Uint8Array) {
    return hidOps.hidSendFeatureReport(this.registry, handle, reportId, toArrayBuffer(bytes));
  }
  async receiveFeatureReport(handle: string, reportId: number) {
    const r = await hidOps.hidReceiveFeatureReport(this.registry, handle, reportId);
    return { reportId: r.reportId, bytes: new Uint8Array(r.bytes) };
  }
  async subscribeInputReports(handle: string, onReport: (report: HidInputReport) => void) {
    return hidOps.hidSubscribeInputReports(this.registry, handle, (r) =>
      onReport({ reportId: r.reportId, bytes: new Uint8Array(r.bytes) })
    );
  }
}

class BridgedHidBackend implements HidBackend {
  constructor(private rpc: PanelRpcClient) {}
  // The picker can take many seconds while the user chooses a device.
  private static REQUEST_TIMEOUT_MS = 5 * 60_000;

  async list() {
    return (await this.rpc.call('hid-list', undefined)).devices;
  }
  async request(filters: HidDeviceFilter[]) {
    return (
      await this.rpc.call(
        'hid-request',
        { filters },
        { timeoutMs: BridgedHidBackend.REQUEST_TIMEOUT_MS }
      )
    ).device;
  }
  async info(handle: string) {
    return (await this.rpc.call('hid-device-info', { handle })).device;
  }
  async open(handle: string) {
    await this.rpc.call('hid-open', { handle });
  }
  async close(handle: string) {
    await this.rpc.call('hid-close', { handle });
  }
  async sendReport(handle: string, reportId: number, bytes: Uint8Array) {
    await this.rpc.call('hid-send-report', { handle, reportId, bytes: toArrayBuffer(bytes) });
  }
  async sendFeatureReport(handle: string, reportId: number, bytes: Uint8Array) {
    await this.rpc.call('hid-send-feature-report', {
      handle,
      reportId,
      bytes: toArrayBuffer(bytes),
    });
  }
  async receiveFeatureReport(handle: string, reportId: number) {
    const r = await this.rpc.call('hid-receive-feature-report', { handle, reportId });
    return { reportId: r.reportId, bytes: new Uint8Array(r.bytes) };
  }
  async subscribeInputReports(handle: string, onReport: (report: HidInputReport) => void) {
    const off = this.rpc.onEvent('hid-input-report', (payload) => {
      const p = payload as HidInputReportEventPayload;
      if (!p || p.handle !== handle) return;
      onReport({ reportId: p.reportId, bytes: new Uint8Array(p.bytes) });
    });
    await this.rpc.call('hid-subscribe-input-reports', { handle });
    return async () => {
      off();
      try {
        await this.rpc.call('hid-unsubscribe-input-reports', { handle });
      } catch {
        /* best-effort teardown */
      }
    };
  }
}

/**
 * Pick the backend for the current realm: the local `navigator.hid`
 * path when a DOM is present, otherwise the panel-RPC bridge. Returns
 * `null` when neither is available (e.g. a worker with no bridge).
 */
export function resolveHidBackend(
  hasLocalDom: boolean,
  panelRpc: PanelRpcClient | null
): HidBackend | null {
  if (hasLocalDom && getNavigatorHid()) {
    return new LocalHidBackend(getSharedHidRegistry());
  }
  if (panelRpc) {
    return new BridgedHidBackend(panelRpc);
  }
  return null;
}
