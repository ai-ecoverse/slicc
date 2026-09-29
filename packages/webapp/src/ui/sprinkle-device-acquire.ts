/**
 * Gesture-gated USB / HID / serial acquisition for sprinkle and trusted-dip
 * `request()`.
 *
 * A sprinkle or trusted-dip iframe's call arrives across an async
 * `postMessage` hop that drops transient activation, so a raw
 * `requestDevice` / `requestPort` on the leader rejects with a SecurityError.
 * Prefer the leader `<slicc-permissions>` surface via `prompt()` (not
 * `request()`): the Grant Allow click re-supplies the gesture that opens the
 * OS chooser — same path as `acquireSprinkleCaptureStream` / #3604 / #3574 /
 * #3609 / #3631. Fall back to the bare navigator picker only when no surface
 * is mounted (cherry follower / headless harness).
 */
import type { PermissionGrant } from '@slicc/webcomponents';
import type { HidApi, HidDevice, HidDeviceFilter } from '../kernel/hid-device-registry.js';
import type { SerialApi, SerialFilter, SerialPort } from '../kernel/serial-port-registry.js';
import type { UsbApi, UsbDevice, UsbDeviceFilter } from '../kernel/usb-device-registry.js';
import { getLeaderPermissionsSurface } from './wc/wc-permissions-registry.js';

type PromptedKind = 'usb' | 'hid' | 'serial';

const WHAT: Record<PromptedKind, string> = {
  usb: 'use a USB device',
  hid: 'use a HID device',
  serial: 'use a serial port',
};

function grantFailureMessage(
  kind: PromptedKind,
  result: { status: string; reason?: string; message?: string }
): string {
  const detail = result.message ? `: ${result.message}` : '';
  const reason = result.reason ?? result.status;
  if (reason === 'cancelled' || result.status === 'cancelled') {
    return `${kind} request cancelled`;
  }
  return `${kind} request ${reason}${detail}`;
}

async function grantThroughSprinklePrompt<K extends PromptedKind>(
  kind: K,
  filters: unknown[]
): Promise<Extract<PermissionGrant, { kind: K }> | null> {
  const surface = getLeaderPermissionsSurface();
  if (!surface) return null;
  const result = await surface.prompt({
    kinds: [kind],
    description: `A sprinkle or dip asks to ${WHAT[kind]}.`,
    requestOptions: { [kind]: { filters } },
  });
  const grant =
    result.status === 'granted' ? result.grants.find((g) => g.kind === kind) : undefined;
  if (!grant) {
    throw new Error(grantFailureMessage(kind, result));
  }
  return grant as Extract<PermissionGrant, { kind: K }>;
}

/** Acquire a USB device for sprinkle `slicc.usb.request()`. */
export async function acquireSprinkleUsbDevice(
  usb: UsbApi,
  filters: UsbDeviceFilter[]
): Promise<UsbDevice> {
  const grant = await grantThroughSprinklePrompt('usb', filters);
  if (grant) return grant.device as UsbDevice;
  return usb.requestDevice({ filters });
}

/** Acquire HID device(s) for sprinkle `slicc.hid.request()`. */
export async function acquireSprinkleHidDevices(
  hid: HidApi,
  filters: HidDeviceFilter[]
): Promise<HidDevice[]> {
  const grant = await grantThroughSprinklePrompt('hid', filters);
  if (grant) return grant.devices as HidDevice[];
  return hid.requestDevice({ filters });
}

/** Acquire a serial port for sprinkle `slicc.serial.request()`. */
export async function acquireSprinkleSerialPort(
  serial: SerialApi,
  filters: SerialFilter[]
): Promise<SerialPort> {
  const grant = await grantThroughSprinklePrompt('serial', filters);
  if (grant) return grant.port as SerialPort;
  return serial.requestPort(filters.length ? { filters } : {});
}

/**
 * WebUSB API whose chooser goes through the Grant prompt when the leader
 * permissions surface is mounted. Drop-in for `usbOps.usbRequest`.
 */
export function sprinkleGestureUsb(usb: UsbApi): UsbApi {
  return {
    getDevices: () => usb.getDevices(),
    requestDevice: ({ filters }) => acquireSprinkleUsbDevice(usb, filters),
  };
}

/** WebHID, likewise. */
export function sprinkleGestureHid(hid: HidApi): HidApi {
  return {
    getDevices: () => hid.getDevices(),
    requestDevice: ({ filters }) => acquireSprinkleHidDevices(hid, filters),
  };
}

/** Web Serial, likewise. */
export function sprinkleGestureSerial(serial: SerialApi): SerialApi {
  return {
    getPorts: () => serial.getPorts(),
    requestPort: (options) => acquireSprinkleSerialPort(serial, options?.filters ?? []),
  };
}
