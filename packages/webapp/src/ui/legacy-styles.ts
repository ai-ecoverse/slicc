export async function loadLegacyStyles(): Promise<void> {
  await import('./styles/tokens.css');
  await import('./styles/base.css');
  await import('./styles/dialog.css');
}

export async function loadLegacyDialogStyles(): Promise<void> {
  await import('./styles/tokens.css');
  await import('./styles/dialog.css');
}

export async function loadDipStyles(): Promise<void> {
  await import('./styles/tokens.css');
  await import('./styles/dips.css');
}

export async function loadSprinkleStyles(): Promise<void> {
  await import('./styles/tokens.css');
  await import('./styles/sprinkle-components.css');
}
