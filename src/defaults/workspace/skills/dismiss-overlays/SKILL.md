---
name: dismiss-overlays
description: Dismiss cookie banners, GDPR consent, chat widgets, and other overlays blocking page content. Run before extracting content or taking screenshots.
allowed-tools: browser
---

# Dismiss Page Overlays

Detect and dismiss overlays (cookie banners, GDPR consent, chat widgets,
popups) that block page content. Use before taking screenshots or
extracting content from a page.

## When to Use

- Before screenshotting a page for visual comparison
- Before extracting content from a source page
- When you see overlays blocking content in a screenshot
- When navigating to a new page that may have consent banners

## How It Works

Run this JavaScript via `browser evaluate` on the target page:

```json
{ "action": "evaluate", "expression": "<the script below>" }
```

### Dismissal Script

```javascript
(async () => {
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
  var results = [];
  var KNOWN_SELECTORS = {
    onetrust: {
      banner: '#onetrust-consent-sdk, .onetrust-pc-dark-filter',
      dismiss: '#onetrust-accept-btn-handler, .onetrust-close-btn-handler'
    },
    cookiebot: {
      banner: '#CybotCookiebotDialog',
      dismiss: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll'
    },
    cookieconsent: {
      banner: '.cc-window, .cc-banner',
      dismiss: '.cc-btn.cc-dismiss, .cc-allow'
    },
    intercom: {
      banner: '#intercom-container, .intercom-lightweight-app',
      dismiss: '.intercom-launcher'
    },
    zendesk: {
      banner: '#launcher, [data-testid="launcher"]',
      dismiss: '[data-testid="launcher"]'
    },
    drift: {
      banner: '#drift-widget, .drift-frame-controller',
      dismiss: '.drift-widget-close-icon'
    },
    generic: {
      banner: '[class*="cookie"], [class*="consent"], [class*="gdpr"], [id*="cookie"], [id*="consent"]',
      dismiss: '[class*="accept"], [class*="allow"], [class*="agree"], [aria-label*="close"], [aria-label*="Close"]'
    }
  };
  var vendors = Object.keys(KNOWN_SELECTORS);
  for (var v = 0; v < vendors.length; v++) {
    var vendor = vendors[v];
    var selectors = KNOWN_SELECTORS[vendor];
    try {
      var bannerEl = document.querySelector(selectors.banner);
      if (!bannerEl) continue;
      var isVisible = bannerEl.offsetParent !== null || window.getComputedStyle(bannerEl).display !== 'none';
      if (!isVisible) continue;
      var dismissed = false;
      var dismissSelectors = selectors.dismiss.split(',');
      for (var d = 0; d < dismissSelectors.length; d++) {
        try {
          var btn = document.querySelector(dismissSelectors[d].trim());
          if (btn) { btn.click(); dismissed = true; results.push({ vendor: vendor, action: 'click' }); await sleep(200); break; }
        } catch (e) {}
      }
      if (!dismissed) {
        var bannerSelectors = selectors.banner.split(',');
        for (var b = 0; b < bannerSelectors.length; b++) {
          try { document.querySelectorAll(bannerSelectors[b].trim()).forEach(function(el) { el.remove(); }); results.push({ vendor: vendor, action: 'remove' }); } catch (e) {}
        }
      }
    } catch (e) {}
  }
  var vH = window.innerHeight, vW = window.innerWidth, vA = vH * vW;
  document.querySelectorAll('*').forEach(function(el) {
    var s = window.getComputedStyle(el);
    if ((s.position === 'fixed' || s.position === 'sticky') && (parseInt(s.zIndex) || 0) > 100) {
      var r = el.getBoundingClientRect();
      if ((r.width * r.height / vA) > 0.2) { el.remove(); results.push({ vendor: 'fixed-overlay', action: 'remove' }); }
    }
  });
  await sleep(300);
  return JSON.stringify({ dismissed: results.length, results: results });
})()
```

## Important Notes

- **Cookies persist across tabs.** If you dismiss a cookie banner on one
  tab, the consent cookie is set and the banner won't appear on other tabs
  to the same domain in the same browser session.
- **The migrate_page tool runs this automatically** during extraction. If
  you're working in a scoop and navigating to the same source page, the
  banner should already be dismissed. Only use this skill if you see
  overlays in your screenshots.
- **Best-effort.** The script handles errors gracefully. If a vendor's
  selectors don't match, it moves on. If no overlays are found, it returns
  `{ dismissed: 0 }`.

## Supported Vendors

| Vendor | Banner Selector | Dismiss Action |
|--------|----------------|----------------|
| OneTrust | `#onetrust-consent-sdk` | Click `#onetrust-accept-btn-handler` |
| Cookiebot | `#CybotCookiebotDialog` | Click `#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll` |
| CookieConsent | `.cc-window` | Click `.cc-btn.cc-dismiss` |
| Intercom | `#intercom-container` | Click `.intercom-launcher` |
| Zendesk | `#launcher` | Click `[data-testid="launcher"]` |
| Drift | `#drift-widget` | Click `.drift-widget-close-icon` |
| Generic | `[class*="cookie"]`, `[id*="consent"]` | Click `[class*="accept"]`, `[aria-label*="close"]` |
| Fixed overlays | z-index > 100, >20% viewport | Remove from DOM |
