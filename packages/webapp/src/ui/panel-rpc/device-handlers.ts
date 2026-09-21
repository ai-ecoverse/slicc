/**
 * WebUSB / WebHID / Web Serial / esptool panel-RPC handlers.
 * Page-side registries back opaque handles the kernel worker drives.
 */
import { getNavigatorHid, getSharedHidRegistry } from '../../kernel/hid-device-registry.js';
import * as hidOps from '../../kernel/hid-operations.js';
import type { PanelRpcHandlers } from '../../kernel/panel-rpc.js';
import * as serialOps from '../../kernel/serial-operations.js';
import { getNavigatorSerial, getSharedSerialRegistry } from '../../kernel/serial-port-registry.js';
import {
  DEFAULT_USB_OWNER,
  getNavigatorUsb,
  getSharedUsbRegistry,
} from '../../kernel/usb-device-registry.js';
import * as usbOps from '../../kernel/usb-operations.js';
import type { StandalonePanelRpcHandlerOptions } from '../panel-rpc-handlers.js';

/** WebUSB ops over the shared page-side handle registry. */
export function buildUsbHandlers(options: StandalonePanelRpcHandlerOptions) {
  ensureUsbClaimEventRelay(options.emitEvent);
  return {
    'usb-list': async () => ({ devices: await usbOps.usbList(usbRegistry(), requireUsb()) }),

    'usb-request': async ({ filters }) => ({
      device: await usbOps.usbRequest(usbRegistry(), requireUsb(), filters),
    }),

    'usb-device-info': ({ handle }) => ({
      device: usbOps.usbDeviceInfo(usbRegistry(), handle),
    }),

    'usb-open': async ({ handle }) => {
      await usbOps.usbOpen(usbRegistry(), handle);
      return { done: true };
    },

    'usb-close': async ({ handle, owner, force }) => {
      await usbOps.usbClose(usbRegistry(), handle, { owner, force });
      return { done: true };
    },

    'usb-select-configuration': async ({ handle, configurationValue }) => {
      await usbOps.usbSelectConfiguration(usbRegistry(), handle, configurationValue);
      return { done: true };
    },

    'usb-claim-interface': async ({ handle, interfaceNumber, owner, wait }) => {
      await usbOps.usbClaimInterface(usbRegistry(), handle, interfaceNumber, { owner, wait });
      return { done: true };
    },

    'usb-release-interface': async ({ handle, interfaceNumber, owner }) => {
      await usbOps.usbReleaseInterface(usbRegistry(), handle, interfaceNumber, { owner });
      return { done: true };
    },

    'usb-cancel-claim-wait': async ({ handle, interfaceNumber, owner }) => {
      await usbOps.usbCancelClaimWait(
        usbRegistry(),
        handle,
        interfaceNumber,
        owner ?? DEFAULT_USB_OWNER
      );
      return { done: true };
    },

    'usb-drop-owner': async ({ owner }) => {
      await usbOps.usbDropOwner(usbRegistry(), owner);
      return { done: true };
    },

    'usb-control-transfer-in': async ({ handle, setup, length }) =>
      usbOps.usbControlTransferIn(usbRegistry(), handle, setup, length),

    'usb-control-transfer-out': async ({ handle, setup, bytes }) =>
      usbOps.usbControlTransferOut(usbRegistry(), handle, setup, bytes),

    'usb-transfer-in': async ({ handle, endpointNumber, length }) =>
      usbOps.usbTransferIn(usbRegistry(), handle, endpointNumber, length),

    'usb-transfer-out': async ({ handle, endpointNumber, bytes }) =>
      usbOps.usbTransferOut(usbRegistry(), handle, endpointNumber, bytes),

    'usb-reset': async ({ handle, owner, force }) => {
      await usbOps.usbReset(usbRegistry(), handle, { owner, force });
      return { done: true };
    },

    'usb-clear-halt': async ({ handle, direction, endpointNumber }) => {
      await usbOps.usbClearHalt(usbRegistry(), handle, direction, endpointNumber);
      return { done: true };
    },

    // ── WebHID ────────────────────────────────────────────────────────
    // Mirrors the WebUSB handlers above, keyed by opaque handles backed
    // by the page-side `HidDeviceHandleRegistry`. `hid-request` calls
    // `requestDevice` and therefore only succeeds during a user gesture.
    // `hid-subscribe-input-reports` attaches an `inputreport` listener
    // that fans reports back over the event channel via `emitEvent`.
  } satisfies Partial<PanelRpcHandlers>;
}

/** WebHID ops, including the input-report watch subscriptions. */
export function buildHidHandlers(
  options: StandalonePanelRpcHandlerOptions,
  hidSubscriptions: Map<string, () => void>
) {
  return {
    'hid-list': async () => ({ devices: await hidOps.hidList(hidRegistry(), requireHid()) }),

    'hid-request': async ({ filters }) => ({
      devices: await hidOps.hidRequest(hidRegistry(), requireHid(), filters),
    }),

    'hid-device-info': ({ handle }) => ({
      device: hidOps.hidDeviceInfo(hidRegistry(), handle),
    }),

    'hid-open': async ({ handle }) => {
      await hidOps.hidOpen(hidRegistry(), handle);
      return { done: true };
    },

    'hid-close': async ({ handle }) => {
      await hidOps.hidClose(hidRegistry(), handle);
      return { done: true };
    },

    'hid-send-report': async ({ handle, reportId, bytes }) => {
      await hidOps.hidSendReport(hidRegistry(), handle, reportId, bytes);
      return { done: true };
    },

    'hid-send-feature-report': async ({ handle, reportId, bytes }) => {
      await hidOps.hidSendFeatureReport(hidRegistry(), handle, reportId, bytes);
      return { done: true };
    },

    'hid-receive-feature-report': async ({ handle, reportId }) =>
      hidOps.hidReceiveFeatureReport(hidRegistry(), handle, reportId),

    'hid-subscribe-input-reports': async ({ handle }) => {
      // Replace any existing subscription for this handle so a
      // re-subscribe doesn't leak the previous listener. The subscribe
      // helper auto-opens the device, so this op is async.
      hidSubscriptions.get(handle)?.();
      const unsubscribe = await hidOps.hidSubscribeInputReports(hidRegistry(), handle, (report) => {
        options.emitEvent?.('hid-input-report', {
          handle,
          reportId: report.reportId,
          bytes: report.bytes,
        });
      });
      hidSubscriptions.set(handle, unsubscribe);
      return { done: true };
    },

    'hid-unsubscribe-input-reports': ({ handle }) => {
      hidSubscriptions.get(handle)?.();
      hidSubscriptions.delete(handle);
      return { done: true };
    },

    // ── Web Serial ──────────────────────────────────────────────────────
    // Mirrors the WebUSB handlers above, keyed by opaque handles backed
    // by the page-side `SerialPortRegistry`. `serial-request` calls
    // `requestPort` and therefore only succeeds during a user gesture.
  } satisfies Partial<PanelRpcHandlers>;
}

/** Web Serial ops over the shared page-side handle registry. */
export function buildSerialHandlers() {
  return {
    'serial-list': async () => ({
      devices: await serialOps.serialList(serialRegistry(), requireSerial()),
    }),

    'serial-request': async ({ filters }) => ({
      device: await serialOps.serialRequest(serialRegistry(), requireSerial(), filters),
    }),

    'serial-device-info': ({ handle }) => ({
      device: serialOps.serialDeviceInfo(serialRegistry(), handle),
    }),

    'serial-open': async ({ handle, options }) => {
      await serialOps.serialOpen(serialRegistry(), handle, options);
      return { done: true };
    },

    'serial-close': async ({ handle }) => {
      await serialOps.serialClose(serialRegistry(), handle);
      return { done: true };
    },

    'serial-read': async ({ handle, maxBytes, until, timeoutMs }) => {
      const bytes = await serialOps.serialRead(serialRegistry(), handle, {
        maxBytes,
        until: until ? new Uint8Array(until) : undefined,
        timeoutMs,
      });
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      return { bytes: buffer };
    },

    'serial-write': async ({ handle, bytes }) => ({
      bytesWritten: await serialOps.serialWrite(serialRegistry(), handle, new Uint8Array(bytes)),
    }),

    'serial-get-signals': async ({ handle }) => ({
      signals: await serialOps.serialGetSignals(serialRegistry(), handle),
    }),

    'serial-set-signals': async ({ handle, signals }) => {
      await serialOps.serialSetSignals(serialRegistry(), handle, signals);
      return { done: true };
    },

    // ── esptool ──────────────────────────────────────────────────────
    // High-level ESP flasher ops for the worker-side `esptool` command.
    // esptool-js is heavy (pako + per-chip firmware stubs), so the
    // wrapper is dynamically imported on first use to keep it out of the
    // eager page bundle. Each esptool terminal line is fanned back to the
    // worker on the `esptool-progress` channel so flash progress streams.
  } satisfies Partial<PanelRpcHandlers>;
}

/** esptool flashing ops (progress streamed via emitEvent). */
export function buildEsptoolHandlers(options: StandalonePanelRpcHandlerOptions) {
  return {
    'esptool-chip-info': async ({ handle, baudRate }) => {
      const esptool = await import('../../kernel/esptool-operations.js');
      return esptool.esptoolChipInfo(serialRegistry(), handle, baudRate, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
    },

    'esptool-read-mac': async ({ handle, baudRate }) => {
      const esptool = await import('../../kernel/esptool-operations.js');
      return esptool.esptoolReadMac(serialRegistry(), handle, baudRate, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
    },

    'esptool-erase-flash': async ({ handle, baudRate }) => {
      const esptool = await import('../../kernel/esptool-operations.js');
      await esptool.esptoolEraseFlash(serialRegistry(), handle, baudRate, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
      return { done: true };
    },

    'esptool-flash': async ({ handle, baudRate, eraseAll, segments }) => {
      const esptool = await import('../../kernel/esptool-operations.js');
      await esptool.esptoolFlash(
        serialRegistry(),
        handle,
        baudRate,
        eraseAll,
        segments.map((s) => ({ address: s.address, data: new Uint8Array(s.bytes) })),
        (line) => options.emitEvent?.('esptool-progress', { handle, line })
      );
      return { done: true };
    },

    'esptool-read-flash': async ({ handle, baudRate, address, size }) => {
      const esptool = await import('../../kernel/esptool-operations.js');
      const bytes = await esptool.esptoolReadFlash(
        serialRegistry(),
        handle,
        baudRate,
        address,
        size,
        (line) => options.emitEvent?.('esptool-progress', { handle, line })
      );
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      return { bytes: buffer };
    },

    'esptool-read-reg': async ({ handle, baudRate, address }) => {
      const esptool = await import('../../kernel/esptool-operations.js');
      return esptool.esptoolReadReg(serialRegistry(), handle, baudRate, address, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
    },

    'esptool-flash-id': async ({ handle, baudRate }) => {
      const esptool = await import('../../kernel/esptool-operations.js');
      return esptool.esptoolFlashId(serialRegistry(), handle, baudRate, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
    },

    'esptool-erase-region': async ({ handle, baudRate, address, size }) => {
      const esptool = await import('../../kernel/esptool-operations.js');
      await esptool.esptoolEraseRegion(serialRegistry(), handle, baudRate, address, size, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
      return { done: true };
    },

    'esptool-run': async ({ handle, baudRate }) => {
      const esptool = await import('../../kernel/esptool-operations.js');
      await esptool.esptoolRun(serialRegistry(), handle, baudRate, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
      return { done: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

/** Shared page-side WebUSB registry (lazy singleton). */
export function usbRegistry() {
  return getSharedUsbRegistry();
}

let usbClaimRelay: (() => void) | null = null;
let usbClaimEmit: ((channel: string, payload: unknown) => void) | undefined;

/**
 * One page-side subscription so worker-side shell/realm consumers hear
 * `claim-lost`/`disconnect` over the panel-RPC event channel. Rebinding
 * `emitEvent` (tests constructing handlers more than once) does not
 * stack listeners on the shared registry.
 */
function ensureUsbClaimEventRelay(emitEvent?: (channel: string, payload: unknown) => void): void {
  usbClaimEmit = emitEvent;
  if (usbClaimRelay || !emitEvent) return;
  void import('../../kernel/usb-claim-broker.js').then((m) => {
    if (usbClaimRelay) return;
    usbClaimRelay = m.addClaimListener(usbRegistry(), (event) => {
      usbClaimEmit?.('usb-claim-event', event);
    });
  });
}

/** Resolve `navigator.usb` or throw a clear error for the worker side. */
function requireUsb() {
  const usb = getNavigatorUsb();
  if (!usb) throw new Error('WebUSB is unavailable in this browser');
  return usb;
}

/** Shared page-side WebHID registry (lazy singleton). */
export function hidRegistry() {
  return getSharedHidRegistry();
}

/** Resolve `navigator.hid` or throw a clear error for the worker side. */
function requireHid() {
  const hid = getNavigatorHid();
  if (!hid) throw new Error('WebHID is unavailable in this browser');
  return hid;
}

/** Shared page-side Web Serial registry (lazy singleton). */
export function serialRegistry() {
  return getSharedSerialRegistry();
}

/** Resolve `navigator.serial` or throw a clear error for the worker side. */
function requireSerial() {
  const serial = getNavigatorSerial();
  if (!serial) throw new Error('Web Serial is unavailable in this browser');
  return serial;
}
