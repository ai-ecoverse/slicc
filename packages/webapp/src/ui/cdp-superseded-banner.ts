/**
 * `cdp-superseded-banner.ts` — page-realm banner shown when this standalone
 * tab loses the single CDP proxy slot to another SLICC tab/window on the same
 * instance (close code `CDP_SUPERSEDED_CLOSE_CODE`). Without the reconnect
 * guard the two tabs evict each other over `ws://<host>/cdp` forever; with it,
 * the losing tab goes quiet — so this banner tells the user why browser
 * automation stopped working here and how to recover.
 *
 * Standalone-only: the extension float drives CDP via `chrome.debugger`, which
 * has no proxy and never supersedes.
 */

const BANNER_ID = 'slicc-cdp-superseded-banner';

/**
 * Inject the "another tab took control" banner. Idempotent — a second call is
 * a no-op while the banner is already present. Pure DOM; the document is
 * passed in so the helper stays testable and never reaches for a global.
 */
export function showCdpSupersededBanner(doc: Document): void {
  if (doc.getElementById(BANNER_ID)) return;
  const banner = doc.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'alert');
  banner.textContent =
    'Another SLICC tab or window has taken control of this browser instance. ' +
    'Only one tab can drive the browser per instance — close the other tabs, ' +
    'then reload this page to resume.';
  // Inline styles so the banner needs no stylesheet wiring and survives any
  // CSS reset. Pinned to the top, above app chrome.
  banner.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    'z-index:2147483647',
    'padding:10px 16px',
    'background:#b3261e',
    'color:#fff',
    'font:13px/1.4 system-ui,sans-serif',
    'text-align:center',
    'box-shadow:0 1px 4px rgba(0,0,0,0.3)',
  ].join(';');
  doc.body.appendChild(banner);
}
