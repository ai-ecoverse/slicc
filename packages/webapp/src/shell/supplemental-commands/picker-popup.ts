/**
 * Re-export of the unified picker popup launcher.
 *
 * Implementation lives in `fs/picker-popup.ts` (bottom of the layer stack)
 * so mount helpers can call it without importing up into `shell/`. This
 * module keeps the historical import path for device pickers and tests.
 */

export {
  canOpenPickerPopup,
  type DevicePickerInfo,
  type DevicePickerResult,
  type DirectoryPickerResult,
  type OpenPickerPopupOptions,
  openPickerPopup,
  type PickerKind,
  type PickerPopupResult,
} from '../../fs/picker-popup.js';
