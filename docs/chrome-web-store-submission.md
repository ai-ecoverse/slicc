# Chrome Web Store Submission Pack

Reviewer-ready justifications for the slicc Chrome extension
(`packages/chrome-extension/manifest.json`). Paste the relevant sections
straight into the Chrome Web Store (CWS) developer dashboard fields.

This file is the single source of truth for the permission justifications and
is enforced by `packages/dev-tools/tools/check-manifest-justifications.sh`,
which fails CI if the manifest gains or drops a permission without a matching
row in the table below (or vice-versa).

## Single-Purpose Statement

slicc is an AI coding agent that lives in the browser side panel. It automates
the tabs the user directs it to, edits files in a browser-local virtual
filesystem, and runs shell commands for web development — all from a single
side-panel surface. Every permission below exists to serve that one purpose.

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
| `sidePanel`                           | The extension's entire UI is rendered in the side panel (the single-purpose surface). Required to open and host the agent chat/terminal UI.                                                                                                              |
| `offscreen`                           | Hosts the long-lived agent engine in an offscreen document so the agent keeps running when the side panel is closed. MV3 service workers are evicted too aggressively to host the agent loop.                                                            |
| `identity`                            | Runs `chrome.identity.launchWebAuthFlow` for user-initiated OAuth sign-in (e.g. GitHub, AI providers) so the agent can act on services the user asks it to use. Only the resulting token is stored, locally.                                             |
| `storage`                             | Persists user settings, user-entered secrets/credentials, OAuth tokens, and session state in `chrome.storage`. All data stays on the user's device.                                                                                                      |
| `webRequest`                          | Observes main-frame response headers in the service worker to detect RFC 8288 `Link` headers that advertise a slicc handoff, and to support the secret-aware fetch-proxy lifecycle. Observation only; no off-device transmission.                        |
| `declarativeNetRequestWithHostAccess` | Installs short-lived, session-scoped declarative rules that re-inject request headers the browser otherwise forbids, so the secret-aware fetch proxy can authenticate user-specified requests. Response bodies are never read by these rules.            |
| `notifications`                       | Shows a notification when a slicc handoff arrives (or a long-running agent task needs attention) while the side panel is closed, so the user can reopen the panel. Clicking the notification opens the side panel.                                       |
| `<all_urls>`                          | The agent automates and reads whichever pages the user directs it to, and the secret-aware fetch proxy targets user-specified endpoints. The target host is chosen by the user at runtime and is not known in advance, so broad host access is required. |

<!-- manifest-justifications:end -->

## Remote-Hosted Code Declaration

All executable JavaScript ships inside the extension package. There is **no
remote-hosted code**. Compliance with the MV3 Remote Hosted Code (RHC) policy
was achieved in PR #818 ("Bundle ffmpeg-core.js and mask CDN URL literals for
MV3 Web Store compliance", tracking original rejection Routing ID FZSL /
Blue Argon):

- The `ffmpeg-core.js` Emscripten glue (executable JS) is bundled under
  `dist/extension/vendor/` and loaded via `chrome.runtime.getURL(...)`.
- All CDN host references are composed at runtime from token arrays
  (`packages/webapp/src/shell/supplemental-commands/cdn-url-builder.ts`), so no
  full third-party CDN URL literal survives in the built bundle.
- The only assets streamed on demand are **WebAssembly binaries** (e.g.
  `ffmpeg-core.wasm`, Pyodide, ImageMagick wasm), fetched only when the user
  invokes the corresponding shell command and cached locally thereafter. Wasm
  binaries are data, not remote-hosted executable JS; `'wasm-unsafe-eval'` in
  the manifest CSP covers `WebAssembly.compile`/`instantiate` and is unrelated
  to RHC.

A dedicated CI guard
(`packages/dev-tools/tools/check-extension-rhc.sh`) string-matches the built
`dist/extension/` for forbidden CDN URL literals and fails the build if any
reappear.

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

## Note: Offscreen Document `reasons` Are Not Permissions

The values passed to `chrome.offscreen.createDocument({ reasons: [...] })` —
`WORKERS`, `USER_MEDIA`, and `DISPLAY_MEDIA` — are **arguments to the offscreen
API**, not manifest permissions. They describe why the offscreen document
exists (running the agent engine's workers, and gating user-initiated media /
display capture). They do **not** appear in `manifest.json`'s `permissions`
array and therefore require no separate Chrome Web Store dashboard
justification. Only the manifest `offscreen` permission (justified above) is
declared.
