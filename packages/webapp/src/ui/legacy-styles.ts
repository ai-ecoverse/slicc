/**
 * The legacy UI's stylesheet bundle, loaded lazily by the legacy boot paths
 * (standalone layout, extension side panel, connect surface). The WC shell
 * (`?ui=wc`) must NOT load these: the component library reuses prototype
 * class names (e.g. `.msg`) that these dark-theme sheets also style, so
 * loading both corrupts the WC rendering. Import order matters for
 * specificity — keep it identical to the original `main.ts` list.
 */
export async function loadLegacyStyles(): Promise<void> {
  await import('./styles/tokens.css');
  await import('./styles/base.css');
  await import('./styles/layout.css');
  await import('./styles/header.css');
  await import('./styles/chat.css');
  await import('./styles/tools.css');
  await import('./styles/markdown.css');
  await import('./styles/panels.css');
  await import('./styles/tabs.css');
  await import('./styles/dialog.css');
  await import('./styles/sprinkle-components.css');
  await import('./styles/feedback.css');
  await import('./styles/image-preview.css');
}

/**
 * The subset the WC shell borrows while it still reuses legacy surfaces:
 * the provider-settings dialog (tokens + dialog chrome). Scoped class
 * names only — safe alongside the component library's styles.
 */
export async function loadLegacyDialogStyles(): Promise<void> {
  await import('./styles/tokens.css');
  await import('./styles/dialog.css');
}
