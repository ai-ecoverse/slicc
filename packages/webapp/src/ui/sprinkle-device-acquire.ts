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
    description: `A sprinkle asks to ${WHAT[kind]}.`,
    requestOptions: { [kind]: { filters } },
  });
  const grant =
    result.status === 'granted' ? result.grants.find((g) => g.kind === kind) : undefined;
  if (!grant) {
    throw new Error(grantFailureMessage(kind, result));
  }
  return grant as Extract<PermissionGrant, { kind: K }>;
}

export async function acquireSprinkleUsbDevice(
  usb: UsbApi,
  filters: UsbDeviceFilter[]
): Promise<UsbDevice> {
  const grant = await grantThroughSprinklePrompt('usb', filters);
  if (grant) return grant.device as UsbDevice;
  return usb.requestDevice({ filters });
}

export async function acquireSprinkleHidDevices(
  hid: HidApi,
  filters: HidDeviceFilter[]
): Promise<HidDevice[]> {
  const grant = await grantThroughSprinklePrompt('hid', filters);
  if (grant) return grant.devices as HidDevice[];
  return hid.requestDevice({ filters });
}

export async function acquireSprinkleSerialPort(
  serial: SerialApi,
  filters: SerialFilter[]
): Promise<SerialPort> {
  const grant = await grantThroughSprinklePrompt('serial', filters);
  if (grant) return grant.port as SerialPort;
  return serial.requestPort(filters.length ? { filters } : {});
}

export function sprinkleGestureUsb(usb: UsbApi): UsbApi {
  return {
    getDevices: () => usb.getDevices(),
    requestDevice: ({ filters }) => acquireSprinkleUsbDevice(usb, filters),
  };
}

export function sprinkleGestureHid(hid: HidApi): HidApi {
  return {
    getDevices: () => hid.getDevices(),
    requestDevice: ({ filters }) => acquireSprinkleHidDevices(hid, filters),
  };
}

export function sprinkleGestureSerial(serial: SerialApi): SerialApi {
  return {
    getPorts: () => serial.getPorts(),
    requestPort: (options) => acquireSprinkleSerialPort(serial, options?.filters ?? []),
  };
}
