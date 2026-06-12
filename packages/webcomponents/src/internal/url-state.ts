/**
 * Tiny URL-state seam for components that persist their own UI state in the
 * page URL (workspace expansion, active context, scroll position). Each
 * component owns exactly its params — there is deliberately NO central state
 * manager; the URL is the store and `popstate` is the change feed.
 *
 * All functions fail soft outside a browsing context (jsdom without history,
 * sandboxed iframes that throw on pushState).
 */

/** Read one UI-state param from the current URL. */
export function readUrlState(key: string): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

/**
 * Write (or clear, with `null`) one UI-state param. `push: true` records a
 * history entry (user-meaningful navigations — context switches); the default
 * replaces in place (scroll positions, transient toggles). A write that would
 * not change the URL is skipped, so apply-from-URL paths never re-push.
 */
export function writeUrlState(
  key: string,
  value: string | null,
  opts: { push?: boolean } = {}
): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    const current = url.searchParams.get(key);
    if (current === value || (current === null && (value === null || value === ''))) return;
    if (value == null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    if (opts.push) window.history.pushState(window.history.state, '', url);
    else window.history.replaceState(window.history.state, '', url);
  } catch {
    // Sandboxed/about:blank contexts may refuse history writes — state is
    // then simply not persisted.
  }
}
