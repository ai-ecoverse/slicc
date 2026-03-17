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

The script is shipped at `/workspace/skills/migrate-page/scripts/overlay-dismiss.js`.
You can read it and pass the content to `browser evaluate`:

```
read_file({ "path": "/workspace/skills/migrate-page/scripts/overlay-dismiss.js" })
```

```json
{ "action": "evaluate", "expression": "<content of overlay-dismiss.js>" }
```

The script waits 1500ms for async consent banners to render, retries dismiss
button clicks up to 4 times with 500ms gaps (handles OneTrust's async rendering),
falls back to DOM removal if clicking fails, and removes high-z-index fixed
overlays covering >20% of the viewport.

## Important Notes

- **Cookies persist across tabs.** If you dismiss a cookie banner on one
  tab, the consent cookie is set and the banner won't appear on other tabs
  to the same domain in the same browser session.
- **Phase 1 of the migrate-page skill runs this automatically** during extraction. If
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
