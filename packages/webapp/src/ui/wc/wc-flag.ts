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
