/**
 * Re-export theme types from `base/` so existing `ui/` imports keep working.
 * The definitions live in the base layer so shell commands can list/apply
 * presets without a shell → ui layer back-edge (#2255 boy-scout).
 */
export type {
  SimplifiedSlots,
  SliccTheme,
  ThemeComponent,
  ThemeComponents,
} from '../base/theme-types.js';
export { TOKEN_GROUPS } from '../base/theme-types.js';
