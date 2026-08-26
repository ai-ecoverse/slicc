/**
 * Re-export preset themes from `base/` so existing `ui/` imports keep working.
 * The data lives in the base layer so `theme` (shell) can read it without a
 * shell → ui layer back-edge (#2255 boy-scout).
 */
export { PRESETS } from '../base/theme-presets.js';
