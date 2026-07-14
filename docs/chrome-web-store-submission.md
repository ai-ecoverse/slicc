# Chrome Web Store Submission Pack

Reviewer-ready justifications for the slicc Chrome extension
(`packages/chrome-extension/manifest.json`). Paste the relevant sections
straight into the Chrome Web Store (CWS) developer dashboard fields.

This file is the single source of truth for the permission justifications and
is enforced by `packages/dev-tools/tools/check-manifest-justifications.sh`,
which fails CI if the manifest gains or drops a permission without a matching
row in the table below (or vice-versa).

## Single-Purpose Statement

slicc is an AI coding agent that runs in a pinned hosted leader tab
(`https://www.sliccy.ai/?slicc=leader`) which the extension pins on install.
It automates the tabs the user directs it to, edits files in a browser-local
virtual filesystem, and runs shell commands for web development — all from a
single hosted-tab surface. The extension itself is a thin CDP bridge: a service
worker that pass-through-proxies `chrome.debugger` to the hosted leader tab. On
the user's toolbar-icon click, the extension also displays a Chrome side-panel
cockpit that hosts the agent interface alongside the user's tabs. Every
permission below exists to serve that one purpose.

## Permission Justifications

Every entry in `manifest.json`'s `permissions` array plus the single
`host_permissions` entry is justified here. The table is the machine-checked
contract: keep one row per manifest entry.

<!-- manifest-justifications:begin -->

| Permission                            | Reviewer justification                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debugger`                            | Drives the user's tabs over the Chrome DevTools Protocol (navigate, click, screenshot, evaluate) so the agent can perform the browser automation the user requests. This is the core capability of the product.                                          |
| `tabs`                                | Reads tab metadata (URL/title) and creates/activates tabs so the agent can target the correct page for automation and surface results to the user.                                                                                                       |
| `tabGroups`                           | Collects the tabs the agent opens into a single labeled Chrome tab group so the user can visually distinguish agent-controlled tabs from their own browsing.                                                                                             |
| `identity`                            | Runs `chrome.identity.launchWebAuthFlow` for user-initiated OAuth sign-in (e.g. GitHub, AI providers) so the agent can act on services the user asks it to use. Only the resulting token is stored, locally.                                             |
| `storage`                             | Persists user settings, user-entered secrets/credentials, OAuth tokens, and session state in `chrome.storage`. All data stays on the user's device.                                                                                                      |
| `webRequest`                          | Observes main-frame response headers in the service worker to detect RFC 8288 `Link` headers that advertise a slicc handoff, and to support the secret-aware fetch-proxy lifecycle. Observation only; no off-device transmission.                        |
| `declarativeNetRequestWithHostAccess` | Installs short-lived, session-scoped declarative rules that re-inject request headers the browser otherwise forbids, so the secret-aware fetch proxy can authenticate user-specified requests. Response bodies are never read by these rules.            |
| `notifications`                       | Shows a notification when a slicc handoff arrives (or a long-running agent task needs attention) while the hosted leader tab is not in the foreground, so the user can refocus it. Clicking the notification focuses the leader tab.                     |
| `sidePanel`                           | Opens the Chrome side panel to display a hosted ui-only follower interface on the user's toolbar-icon click, providing a persistent agent cockpit alongside the user's browsing without taking up tab space.                                             |
| `<all_urls>`                          | The agent automates and reads whichever pages the user directs it to, and the secret-aware fetch proxy targets user-specified endpoints. The target host is chosen by the user at runtime and is not known in advance, so broad host access is required. |

<!-- manifest-justifications:end -->

## Remote-Hosted Code Declaration

All executable JavaScript ships inside the extension package. There is **no
remote-hosted code**. The thin extension bundles only the service worker, the
side-panel host, the secrets options page, the preview service worker, and the
picker/capture popups — no WASM and no vendored JS glue.

- The agent's WASM tooling (Pyodide, ImageMagick, ffmpeg) and JS realms do
  **not** run inside the extension. They run in the hosted leader tab
  (`https://www.sliccy.ai`), which loads its own standalone webapp build; the
  extension is a CDP pass-through bridge and executes none of that code. The
  fat extension's bundled `ffmpeg-core.js` Emscripten glue under
  `dist/extension/vendor/` (added in PR #818, "Bundle ffmpeg-core.js and mask
  CDN URL literals for MV3 Web Store compliance", tracking original rejection
  Routing ID FZSL / Blue Argon) was removed with the thin-bridge strip.
- The extension streams no remote assets and fetches no WASM binaries; that is
  handled entirely by the hosted tab.
- Any CDN host references in shared webapp code are still composed at runtime
  from token arrays
  (`packages/webapp/src/shell/supplemental-commands/cdn-url-builder.ts`) so no
  full third-party CDN URL literal survives in built output.

A dedicated CI guard
(`packages/dev-tools/tools/check-extension-rhc.sh`) string-matches the built
`dist/extension/` for forbidden CDN URL literals and fails the build if any
reappear — defense-in-depth, even though the thin bridge no longer bundles the
WASM tooling that originally motivated it.

## Data Usage Disclosures

- **No personal or browsing data is collected or transmitted off-device by the
  extension.** Settings, secrets, OAuth tokens, and session state live in
  `chrome.storage`/IndexedDB on the user's machine.
- **Camera, microphone, and screen capture are never accessed automatically.**
  They are invoked **only** in response to an explicit user shell command (the
  macOS-style `screencapture` helper and the media-capture commands). The
  captured media is written to the browser-local virtual filesystem for the
  user and is **never transmitted off-device by the extension**.
- OAuth tokens entered/obtained by the user are sent only to the corresponding
  provider the user authenticated with, at the user's request.
- Authenticated/agent-initiated HTTP requests go to the endpoints the user or
  their agent task specifies; the extension does not add any analytics or
  tracking transmission of user content.

## Historical note: removed permissions

The extension previously declared `sidePanel` and `offscreen` permissions for
the bundled side-panel UI and offscreen agent engine. Both were removed in the
thin-bridge release — the UI and agent engine now load from the hosted leader
tab (`https://www.sliccy.ai/?slicc=leader`) and the extension is a CDP
pass-through bridge only. Neither permission appears in the current
`manifest.json` and neither is requested.
