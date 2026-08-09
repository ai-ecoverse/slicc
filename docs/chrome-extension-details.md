# Chrome Extension Details

Deep-dive companion to [`packages/chrome-extension/CLAUDE.md`](../packages/chrome-extension/CLAUDE.md).
The bridge Port protocol, toast attribution/dedup, side-panel six-step flow,
dev-watch loop, QA recipe, and smoke-test knobs live in
[`extension-thin-bridge.md`](extension-thin-bridge.md); this file collects the
per-surface implementation rationale that doesn't fit either page.

## Responsibilities

- **Service worker** (`src/service-worker.ts`): pins the leader tab,
  opens/focuses the side panel on action-click (`chrome.sidePanel.open`,
  `setPanelBehavior`), accepts the leader's bridge Port via
  `externally_connectable`, pass-through proxies `chrome.debugger` through
  `bridge-sw.ts`, hosts the secret-aware fetch proxy and the S3/DA mount
  sign-and-forward backends, and surfaces SLICC handoff notifications observed
  via `webRequest` — payload-naming toast with origin attribution,
  control-character sanitization, and per-fingerprint session dedup (see
  `extension-thin-bridge.md` "Handoff Toast").
- **Side-panel cockpit** (`sidepanel.html` + `src/sidepanel-entry.ts`):
  on-demand `chrome.sidePanel` surface that iframes the hosted ui-only cherry
  follower (`?cherry=1&ui-only=1`) and runs the tri-state
  (booting → ready → disconnected) controller over a `cherry-panel` Port to
  the service worker. It relays the follower avatar menu's "Bring leader to
  front" (`slicc.focus-leader-tab`) as `focus-leader` with
  `openSettings: false` — the follower iframe has no `chrome.tabs` access, and
  the pinned leader lives in one window only.
- **Secrets options page** (`secrets.html` + `src/secrets-entry.ts`): user-
  facing CRUD over `chrome.storage.local` credentials consumed by the SW's
  fetch-proxy and sign-and-forward backends.

## Leader-Tab Lifecycle

The service worker keeps one pinned tab at the hosted leader URL but does
**not** create it on browser startup — Chrome restores the sticky pinned tab.
`reconcileLeaderTabOnBoot()` runs at top-level (SW-wake hygiene) to clear a
stale stored id. `ensureLeaderTab()` (adopt-or-create + dedup) runs **on
demand** when the icon is clicked or a `cherry-panel` Port connects. After
restart, the restored leader re-pins itself via **self-adopt**: when no leader
id is stored, a top-frame connection from an allowlisted origin carrying
`?slicc=leader` is accepted and persisted. Adoption reloads a
discarded/unloaded leader tab (memory saver, lazy session restore) — it runs
no JS and could never deliver `leader.join-url` to the side panel otherwise.
See `extension-thin-bridge.md` "Leader-Tab Lifecycle" for the extended
sequence and edge cases.

## `bridge-sw.ts` CDP Ownership

`bridge-sw.ts` is the `externally_connectable` Port handler that
pass-through-proxies CDP to `chrome.debugger`.

- `cdpGetTargets` marks the `lastFocusedWindow` active tab so
  `playwright list-tabs` shows `(active)` and cherry prompts can resolve
  'this page'.
- The webapp's `CDPRouter` alone owns temporary follower-preview focus and
  restoration; the bridge applies every `Page.bringToFront` by activating the
  target tab and forwarding the command, without trying to classify its
  origin.
- Synthetic sessions keep the `sessionId === targetId` convention and
  ref-count duplicate tab attachments; disconnect and target close
  force-release them.
- Debugger ownership is shared symmetrically with the legacy compatibility
  path: whichever consumer performs `chrome.debugger.attach` owns the
  matching detach, while the borrowing consumer's detach is a no-op.
- External detach clears every live bridge Port's tab, session, and
  ref-count state and emits `Target.detachedFromTarget` so the hosted leader
  invalidates its cached session before reattaching; target close also
  clears ownership.

## Device / Directory Picker Popups

Directory results carry an opaque `{ handleInIdb, idbKey, dirName }` — the
popup stashes the non-postable `FileSystemDirectoryHandle` in the shared
`slicc-pending-mount` IDB store. Device results carry identifiers
(`vendorId/productId/serialNumber`) the caller re-acquires via
`navigator.{usb,serial,hid}.getDevices()` in its own realm. Both
`picker-popup.html` and `picker-popup.js` must stay in the `closeBundle`
static-asset copy list in `packages/chrome-extension/vite.config.ts` or all
four picker windows 404.

## Mount Secrets Options Page

`secrets.html` is the manifest's `options_ui` page. Users reach it via
right-click the toolbar icon → Options, `chrome://extensions` → SLICC →
Extension options, or the in-app `secret edit` terminal command (which opens
the page over `chrome-extension://<id>/secrets.html`). The page reads/writes
`chrome.storage.local` directly (full chrome.\* API access, not sandboxed) and
is the extension-mode equivalent of editing `~/.slicc/secrets.env` in CLI
mode. Pure logic lives in `src/secrets-storage.ts` (tested by
`tests/secrets-storage.test.ts`); the DOM entrypoint `src/secrets-entry.ts`
is bundled to `dist/extension/secrets.js` via the `build-secrets-page`
esbuild plugin in `vite.config.ts`.

## MV3 Remote Hosted Code Guard — Debugging

`packages/dev-tools/tools/check-extension-rhc.sh` scans `dist/extension/`
(recursively, across `.js`/`.html`/`.json`/`.css`, excluding `.map` files)
and exits non-zero if a full third-party CDN URL literal appears — even one
the runtime overrides is enough to fail Chrome Web Store review (violation
reference Blue Argon). Forbidden patterns:

- `https://unpkg.com/<path>` (scoped or non-scoped)
- `https://esm.sh/<path>`
- `https://cdn.jsdelivr.net/npm/<path>`

Bare hostnames and the host-only form (no path) are allowed. The script
prints `file:line:URL` for every match. Open the cited file, find the call
site that constructed the URL, and migrate it to
`packages/webapp/src/shell/supplemental-commands/cdn-url-builder.ts` so only
the bare host appears as a string literal and the path is composed at
runtime via `new URL(path, ...)`.
