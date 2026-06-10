/**
 * Runtime flag for the next-generation `@slicc/webcomponents` UI.
 *
 * `?ui=wc` mounts the web-components shell instead of the legacy layout.
 * The flag is URL-only on purpose: the migration is in progress and the
 * legacy UI stays the default until the new shell reaches feature parity.
 * Extension floats never pass the flag — `main.ts` guards on `isExtension`
 * before consulting it.
 */
export function isWcUiEnabled(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return url.searchParams.get('ui') === 'wc';
}
