const BANNER_ID = 'slicc-cdp-superseded-banner';
const BRIDGE_REJECTED_BANNER_ID = 'slicc-cdp-bridge-rejected-banner';

const BANNER_STYLE = [
  'position:fixed',
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

export function showCdpSupersededBanner(doc: Document): void {
  if (doc.getElementById(BANNER_ID)) return;
  const banner = doc.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'alert');
  banner.textContent =
    'Another SLICC tab or window has taken control of this browser instance. ' +
    'Only one tab can drive the browser per instance — close the other tabs, ' +
    'then reload this page to resume.';

  banner.style.cssText = `top:0;${BANNER_STYLE}`;
  doc.body.appendChild(banner);
}

export function showCdpBridgeRejectedBanner(doc: Document): void {
  if (doc.getElementById(BRIDGE_REJECTED_BANNER_ID)) return;
  const banner = doc.createElement('div');
  banner.id = BRIDGE_REJECTED_BANNER_ID;
  banner.setAttribute('role', 'alert');
  banner.textContent =
    'The bridge token for this tab was rejected by the local SLICC server. ' +
    'Open SLICC again from Sliccstart so the tab picks up a fresh token.';
  const belowSuperseded = doc.getElementById(BANNER_ID) ? 'top:44px;' : 'top:0;';
  banner.style.cssText = `${belowSuperseded}${BANNER_STYLE}`;
  doc.body.appendChild(banner);
}
