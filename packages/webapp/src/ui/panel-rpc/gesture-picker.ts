import type {
  PermissionGrant,
  PermissionRequestOptions,
  SliccPermissions,
} from '@slicc/webcomponents';
import type { HidApi, HidDevice } from '../../kernel/hid-device-registry.js';
import type { SerialApi, SerialPort } from '../../kernel/serial-port-registry.js';
import type { UsbApi, UsbDevice } from '../../kernel/usb-device-registry.js';
import type { GetDisplayMedia } from '../../shell/supplemental-commands/screencapture-media.js';

export type PermissionsSurface = () => SliccPermissions | null;

export function hasUserGesture(): boolean {
  const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;

  return activation?.isActive ?? true;
}

type PromptedKind = 'usb' | 'hid' | 'serial' | 'screenshare';

const WHAT: Record<PromptedKind, string> = {
  usb: 'use a USB device',
  hid: 'use a HID device',
  serial: 'use a serial port',
  screenshare: 'share a screen',
};

async function grantThroughPrompt<K extends PromptedKind>(
  surface: PermissionsSurface,
  kind: K,
  requestOptions: PermissionRequestOptions
): Promise<Extract<PermissionGrant, { kind: K }>> {
  const prompt = surface();
  if (!prompt) {
    throw new Error(`${kind} request: the chooser needs a click, and no permission prompt is open`);
  }
  const result = await prompt.prompt({
    kinds: [kind],
    description: `A command in the terminal asks to ${WHAT[kind]}.`,
    requestOptions: { [kind]: requestOptions },
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
      (await grantThroughPrompt(surface, 'usb', { filters })).device as UsbDevice,
  };
}

export function gestureHid(hid: HidApi, surface: PermissionsSurface): HidApi {
  if (hasUserGesture()) return hid;
  return {
    getDevices: () => hid.getDevices(),
    requestDevice: async ({ filters }) =>
      (await grantThroughPrompt(surface, 'hid', { filters })).devices as HidDevice[],
  };
}

export function gestureSerial(serial: SerialApi, surface: PermissionsSurface): SerialApi {
  if (hasUserGesture()) return serial;
  return {
    getPorts: () => serial.getPorts(),
    requestPort: async (options) =>
      (await grantThroughPrompt(surface, 'serial', { filters: options?.filters ?? [] }))
        .port as SerialPort,
  };
}

export function gestureDisplayMedia(surface: PermissionsSurface): GetDisplayMedia {
  if (hasUserGesture()) return (constraints) => navigator.mediaDevices.getDisplayMedia(constraints);
  return async (constraints) =>
    (await grantThroughPrompt(surface, 'screenshare', { constraints })).stream;
}
