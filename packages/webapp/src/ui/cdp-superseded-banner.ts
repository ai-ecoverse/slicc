const BANNER_ID = 'slicc-cdp-superseded-banner';

export function showCdpSupersededBanner(doc: Document): void {
  if (doc.getElementById(BANNER_ID)) return;
  const banner = doc.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'alert');
  banner.textContent =
    'Another SLICC tab or window has taken control of this browser instance. ' +
    'Only one tab can drive the browser per instance — close the other tabs, ' +
    'then reload this page to resume.';

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
