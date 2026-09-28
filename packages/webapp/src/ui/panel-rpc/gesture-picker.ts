import type { PermissionGrant, SliccPermissions } from '@slicc/webcomponents';
import type { HidApi, HidDevice } from '../../kernel/hid-device-registry.js';
import type { SerialApi, SerialPort } from '../../kernel/serial-port-registry.js';
import type { UsbApi, UsbDevice } from '../../kernel/usb-device-registry.js';

export type PermissionsSurface = () => SliccPermissions | null;

export function hasUserGesture(): boolean {
  const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;

  return activation?.isActive ?? true;
}

const WHAT: Record<'usb' | 'hid' | 'serial', string> = {
  usb: 'a USB device',
  hid: 'a HID device',
  serial: 'a serial port',
};

async function grantThroughPrompt<K extends 'usb' | 'hid' | 'serial'>(
  surface: PermissionsSurface,
  kind: K,
  filters: unknown[]
): Promise<Extract<PermissionGrant, { kind: K }>> {
  const prompt = surface();
  if (!prompt) {
    throw new Error(`${kind} request: the chooser needs a click, and no permission prompt is open`);
  }
  const result = await prompt.prompt({
    kinds: [kind],
    description: `A command in the terminal asks to use ${WHAT[kind]}.`,
    requestOptions: { [kind]: { filters } },
  });
  const grant =
    result.status === 'granted' ? result.grants.find((g) => g.kind === kind) : undefined;
  if (!grant) {
    const detail = result.message ? `: ${result.message}` : '';
    throw new Error(`${kind} request: ${result.reason ?? result.status}${detail}`);
  }
  return grant as Extract<PermissionGrant, { kind: K }>;
}

export function gestureUsb(usb: UsbApi, surface: PermissionsSurface): UsbApi {
  if (hasUserGesture()) return usb;
  return {
    getDevices: () => usb.getDevices(),
    requestDevice: async ({ filters }) =>
      (await grantThroughPrompt(surface, 'usb', filters)).device as UsbDevice,
  };
}

export function gestureHid(hid: HidApi, surface: PermissionsSurface): HidApi {
  if (hasUserGesture()) return hid;
  return {
    getDevices: () => hid.getDevices(),
    requestDevice: async ({ filters }) =>
      (await grantThroughPrompt(surface, 'hid', filters)).devices as HidDevice[],
  };
}

export function gestureSerial(serial: SerialApi, surface: PermissionsSurface): SerialApi {
  if (hasUserGesture()) return serial;
  return {
    getPorts: () => serial.getPorts(),
    requestPort: async (options) =>
      (await grantThroughPrompt(surface, 'serial', options?.filters ?? [])).port as SerialPort,
  };
}
