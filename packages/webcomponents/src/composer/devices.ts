export type DeviceKind = 'camera' | 'microphone';

export interface DeviceOption {
  deviceId: string;
  label: string;
}

const KIND_LABEL: Record<DeviceKind, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
};

export function deviceLabel(
  label: string | null | undefined,
  index: number,
  kind: DeviceKind
): string {
  const trimmed = (label ?? '').trim();
  return trimmed || `${KIND_LABEL[kind]} ${index + 1}`;
}

export function labelDevices(
  items: ReadonlyArray<{ deviceId: string; label?: string | null }>,
  kind: DeviceKind
): DeviceOption[] {
  return items.map((item, index) => ({
    deviceId: item.deviceId,
    label: deviceLabel(item.label, index, kind),
  }));
}

export function shouldShowDevicePicker(items: ArrayLike<unknown>): boolean {
  return items.length >= 2;
}

export function pickDefaultMicId(
  options: ReadonlyArray<{ deviceId: string; label?: string | null }>
): string | null {
  if (options.length === 0) return null;
  const explicit = options.find((o) => o.deviceId === 'default');
  if (explicit) return explicit.deviceId;
  const labeled = options.find((o) => (o.label ?? '').trim().toLowerCase().startsWith('default'));
  if (labeled) return labeled.deviceId;
  return options[0].deviceId;
}
