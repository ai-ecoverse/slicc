/**
 * Runtime flag for the next-generation `@slicc/webcomponents` UI.
 *
 * `?ui=wc` mounts the web-components shell instead of the legacy layout:
 * live mode boots the kernel worker and drives real conversations; adding
 * `?ui-fixture` renders the design-time chat fixture instead (no kernel).
 * The flag is URL-only on purpose: the migration is in progress and the
 * legacy UI stays the default until the new shell reaches feature parity.
 * Extension floats never pass the flag — `main.ts` guards on `isExtension`
 * before consulting it.
 */
export type WcUiMode = 'off' | 'live' | 'fixture';

export function resolveWcUiMode(href: string): WcUiMode {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return 'off';
  }
  if (url.searchParams.get('ui') !== 'wc') return 'off';
  return url.searchParams.has('ui-fixture') ? 'fixture' : 'live';
}

/**
 * The pinned extension side panel has no URL control, so opting it into the
 * WC shell is an explicit localStorage pin, toggled from the WC avatar menu
 * (reachable via the detached popout `?detached=1&ui=wc`).
 */
export const WC_UI_PIN_KEY = 'slicc_ui_wc';

export function isWcUiPinned(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(WC_UI_PIN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setWcUiPinned(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  pinned: boolean
): void {
  if (pinned) storage.setItem(WC_UI_PIN_KEY, '1');
  else storage.removeItem(WC_UI_PIN_KEY);
}
