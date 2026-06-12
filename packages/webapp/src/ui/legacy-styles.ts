/**
 * Scoped stylesheet bundles surviving from the legacy UI. The legacy app
 * shell's sheets were deleted with it (PR #961); what remains styles the
 * surfaces the WC shell still borrows. Loaded lazily so the WC shell's
 * default path carries only the component library's own styles (the
 * library reuses prototype class names that broader sheets collided with).
 */

/** Connect surface (`?connect=1`): tokens + base typography + dialogs. */
export async function loadLegacyStyles(): Promise<void> {
  await import('./styles/tokens.css');
  await import('./styles/base.css');
  await import('./styles/dialog.css');
}

/** Provider-settings + sync dialogs opened from the WC avatar menu. */
export async function loadLegacyDialogStyles(): Promise<void> {
  await import('./styles/tokens.css');
  await import('./styles/dialog.css');
}

/** Dip iframe chrome (`dip.ts` containers + streaming placeholder). */
export async function loadDipStyles(): Promise<void> {
  await import('./styles/tokens.css');
  await import('./styles/dips.css');
}

/** Sprinkle panel chrome (`sprinkle-renderer.ts` containers + editor/diff). */
export async function loadSprinkleStyles(): Promise<void> {
  await import('./styles/tokens.css');
  await import('./styles/sprinkle-components.css');
}
