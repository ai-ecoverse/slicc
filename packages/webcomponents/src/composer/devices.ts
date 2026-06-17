/**
 * Shared, DOM-light helpers for the composer's device pickers.
 *
 * Both `<slicc-composer-capture>` (camera + mic `<option>` lists) and
 * `<slicc-composer>`'s push-to-talk mic menu need the same two rules:
 *
 * 1. **Label fallback** — when a `MediaDeviceInfo` has no usable `label`
 *    (no permission yet, or the platform never exposed one), substitute a
 *    stable positional placeholder: `Camera 1`, `Microphone 2`, …
 * 2. **Visibility** — surface the picker only when there is a real choice
 *    to make: ≥ 2 devices.
 *
 * Keeping these rules here (no DOM dependencies) means both consumers stay
 * in lockstep without growing a runtime coupling — each renders its own
 * widget (a `<select>` for capture, a custom menu for PTT) but the data
 * shape and the "should we even show it" decision are identical.
 */

/** The kinds of device the composer surfaces a picker for. */
export type DeviceKind = 'camera' | 'microphone';

/**
 * The minimal option/row shape both pickers consume. Compatible with the
 * existing {@link import('./speech.js').MicrophoneInfo} (same fields), so
 * speech.ts results flow straight into the PTT menu without remapping.
 */
export interface DeviceOption {
  deviceId: string;
  label: string;
}

/** The label-fallback word for each device kind. */
const KIND_LABEL: Record<DeviceKind, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
};

/**
 * Resolve the user-facing label for one device, falling back to a stable
 * positional placeholder (`Camera N` / `Microphone N`, 1-indexed) when the
 * platform did not give us one. The placeholder mirrors the index passed
 * by the caller so list order is preserved.
 */
export function deviceLabel(
  label: string | null | undefined,
  index: number,
  kind: DeviceKind
): string {
  const trimmed = (label ?? '').trim();
  return trimmed || `${KIND_LABEL[kind]} ${index + 1}`;
}

/**
 * Normalize a raw device list (typically `MediaDeviceInfo[]` filtered to the
 * matching `kind`, or anything carrying `{ deviceId, label? }`) into the
 * picker-ready {@link DeviceOption} shape, applying {@link deviceLabel} per
 * row. Input order is preserved.
 */
export function labelDevices(
  items: ReadonlyArray<{ deviceId: string; label?: string | null }>,
  kind: DeviceKind
): DeviceOption[] {
  return items.map((item, index) => ({
    deviceId: item.deviceId,
    label: deviceLabel(item.label, index, kind),
  }));
}

/**
 * The shared visibility rule: only surface the picker when there is more
 * than one device. A single (or zero) input means no real choice — hiding
 * it keeps both the capture bar and the PTT overlay free of dead chrome.
 */
export function shouldShowDevicePicker(items: ArrayLike<unknown>): boolean {
  return items.length >= 2;
}
