# Extension Thin-Bridge: Deep Reference

Detailed protocol, implementation, and QA reference for the Chrome
extension thin-bridge. For the architecture overview and ASCII diagram see
`docs/architecture.md` "Extension Thin-Bridge Architecture"; for the module
map and build commands see `packages/chrome-extension/CLAUDE.md`.

## Bridge Port Control Messages

The leader tab communicates with the service worker over a long-lived
`chrome.runtime.connect` Port (`name: 'slicc.cdp-bridge'`). The Port is
pinned at connect by a three-factor check in `bridge-sw.ts`: origin
allowlist + `sender.tab.id === storedLeaderTabId` + `sender.frameId === 0`
(top-frame only). Post-handshake the Port carries:

- **CDP pass-through**: `cdp.request` / `cdp.response` / `cdp.event` envelopes
  proxying `chrome.debugger` calls.
- **Handoff licks** (SW → leader): `extension.lick` envelopes forward SLICC
  handoff `Link` headers observed via `chrome.webRequest`.
- **Open Settings** (SW → leader): `extension.open-settings` envelopes tell the
  leader tab to open its provider Settings dialog. Posted by
  `postOpenSettingsToWelcomedLeaderPorts()` when the side-panel follower hands a
  sign-in off (`cherry-panel` `focus-leader` message); the leader's bridge
  transport (`onOpenSettings`) re-broadcasts a `slicc:open-settings-from-panel`
  window event that `wc-nav.ts` routes to the Settings dialog. Carries no
  payload — a pure command. `channelId`-gated post-handshake.
- **Tray joinUrl** (leader → SW): `leader.join-url` envelopes deliver the leader's
  tray session joinUrl (`/join/<trayId>.<secret>`) to the SW so the side-panel
  follower can connect. The leader sends this on `onLeaderReady` and
  `onReconnected`, and sends `null` on `onReconnectGaveUp` so the SW clears its
  cache.

Wire-protocol message types live in
`packages/webapp/src/kernel/messages.ts`; the extension imports them from
there.

The kernel bridge and its proxies now live entirely in the webapp package
(`packages/webapp/src/kernel/facade.ts`,
`packages/webapp/src/scoops/sprinkle-manager-proxy.ts`, and
`packages/webapp/src/scoops/lick-manager-proxy.ts`); no code in this package
is consumed by the webapp's kernel-worker or its crontask / webhook commands.

## Leader-Tab Lifecycle (Why No Startup Create)

`chrome.storage.session` is wiped on browser restart, and the startup
trigger fires **before** Chrome's "Continue where you left off" finishes
restoring the pinned leader tab. The original code created a leader tab on
`onStartup`/`onInstalled`; that query found nothing (the tab hadn't restored
yet) and spawned a **second** pinned tab. Because created leader tabs are
pinned, each duplicate is itself restored next launch → **one extra leader
tab per restart**. A `setTimeout` poll is not a fix: an MV3 SW can be
evicted mid-poll.

**The fix: do not create on startup at all.** Chrome restores the sticky
pinned tab. Re-identification after restart happens via the tab's own bridge
connection:

- `chrome.storage.session` no longer holds the id across restarts, so
  `validateBridgePin` (`bridge-sw.ts`) **self-adopts**: when no leader is pinned
  yet, a top-frame connection from an allowlisted origin whose URL carries
  `?slicc=leader` is accepted and its tab id persisted
  (`writeStoredLeaderTabId`).
- **Creation + dedup** happen on the **icon click** (`ensureLeaderTab` →
  keep-one/close-extras, or create if none). `ensureLeaderTab` is serialized
  by `leaderTabLock` and shared by the cherry-panel connect and
  cherry-recovery. This also heals any pre-fix pile: the next icon click
  collapses it to one.

Net: a restart can never duplicate the tab (nothing creates on startup), and
the restored tab stays fully functional (self-adopt re-pins its bridge).

## Handoff Toast: Attribution, Sanitization, and Deduplication

When `chrome.webRequest` observes a SLICC handoff `Link` header on a main-
frame navigation:

1. **Toast naming** — the notification body names the payload: upskill repo +
   skill path, or the handoff instruction text.
2. **Attribution** — the toast attributes the payload to the advertising
   page's origin, not to the extension, so the user knows who sent it.
3. **Sanitization** — control characters in the attacker-supplied instruction
   are collapsed so the prose can't pose as extension speech.
4. **Deduplication** — the toast is deduped per fingerprint in
   `chrome.storage.session` (capped at 100, oldest dropped; the write-back is
   skipped when the read failed). This prevents a site-wide `Link` rel from
   re-toasting after MV3 evicts and respawns the worker. The lick forward to
   the leader is **never** gated by the dedup.
5. **Notification click** — notification ids carry a sequence suffix so
   same-millisecond toasts don't collide (`slicc-handoff-<seq>`). A click
   landing after an eviction still clears the badge and focuses the leader
   tab.

## Picker Popup User-Gesture Contract

Chrome's picker APIs (`showDirectoryPicker`, `navigator.usb.requestDevice`,
`navigator.serial.requestPort`, `navigator.hid.requestDevice`) require a real
user gesture on a visible surface — this is _why_ the popup architecture
exists. MV3 service workers and the hosted leader tab running under TCC cannot
host these pickers reliably.

The popup runs the chooser on its own button-click gesture (satisfying
Chrome's user-gesture rule), then posts
`{ source: 'picker-popup', kind, requestId, … }` back via
`chrome.runtime` messaging. The page-side launcher is
`openPickerPopup(kind, filters, requestId)` in
`packages/webapp/src/shell/supplemental-commands/picker-popup.ts`; thin
typed adapters (`openMountPickerPopup`, `openUsbPickerPopup`,
`openSerialPickerPopup`, `openHidPickerPopup`) wrap it for the existing
call sites.

The cone (agent) path for `usb request` / `serial request` / `hid request`
mirrors `mount`'s approval flow: the command surfaces a `showToolUI`
approval card in the hosted leader tab's chat (built by `picker-approval.ts`);
the user click drives the chooser via dip (`handleDipPickerAction` in
`dip.ts`) in standalone or via the unified popup transparent-swap in
`tool-ui-renderer.ts` in extension.

## On-Demand Cherry Side Panel: Full Flow

The side panel is opened on demand by the toolbar icon. Full flow:

1. **Icon click** → `chrome.action.onClicked` receives the clicked tab.
2. **Panel toggle**: `chrome.sidePanel.open({ windowId })` opens the panel in
   the tab's window (Chrome-native toggle — reopening the same panel is a
   no-op; the user closes it via Chrome's UI).
3. **Panel behavior**: `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`
   wired on SW boot so the icon click always triggers the panel.
4. **Panel content**: `sidepanel.html` iframes the hosted `?cherry=1&ui-only=1`
   follower (loaded from `https://www.sliccy.ai` in production or
   `http://localhost:8787` in dev).
5. **Join URL delivery**: the panel opens a `cherry-panel` Port to the SW; the
   SW tracks per-window `cherry-panel` Ports (a Map) and broadcasts
   `{ kind:'join-url', joinUrl }` (cached from the leader tab's `leader.join-url`
   bridge message) to all hello'd ports so the follower can connect to the tray.
   The SW sends `null` when the leader disconnects, and the panel shows a
   "Disconnected" state.
6. **Login hand-off**: provider login can't complete in the cross-origin panel
   iframe (OAuth / device-code / provider-settings run on the leader). The
   follower detects the side panel by its ancestor origin
   (`chrome-extension://…`, via `location.ancestorOrigins`) and, **only there**,
   shortcuts onboarding: it replaces the welcome / connect-llm dips with a
   "Set up SLICC in the main tab" hand-off card (`buildWelcomeHandoffCard`),
   and routes login-dip actions + cone-error card CTAs to a "Sign in from the
   SLICC tab" card (`showSignInRedirect`). A general cherry embed in a
   third-party page keeps its own onboarding untouched. In both card cases the
   follower emits `slicc.open-leader-tab`; `sidepanel-entry`'s `onSliccEvent`
   hook relays it to the SW as a `cherry-panel` `focus-leader` message, and
   `cherry-panel-sw` both `focusLeaderTab()`s (focus/create the leader tab)
   and `postOpenSettingsToWelcomedLeaderPorts()`s (bridge
   `extension.open-settings` → leader opens its Settings dialog) so the user
   lands on the login UI, not a bare focused tab.

**Tri-state panel UI:**

- **Loading**: shown while waiting for the first join-url message from the SW.
- **Connected**: the cherry iframe is mounted with the tray joinUrl.
- **Disconnected**: shown when the leader sends `null` (leader
  reconnect-gave-up or closed).

**Framing:** The cloudflare worker sets a `Content-Security-Policy` response
header with `frame-ancestors` explicitly naming the extension origin
(`chrome-extension://<id>`) so the browser allows the `?cherry=1` follower to
load inside the panel's iframe. A bare `*` does not authorize
`chrome-extension://` ancestors; the header must name the scheme + origin.
There is no `declarativeNetRequest` framing rule.

## Secret-Aware Fetch Proxy: Full Handler Reference

The webapp's `createProxiedFetch()` extension branch uses the Port handler
instead of direct fetch, providing full secret injection equivalent to CLI mode.

The service worker handles `fetch-proxy.fetch` Port connections for
secret-aware HTTP proxying. The Port `onMessage` listener attaches
**synchronously** in `onConnect` (via `handleFetchProxyConnectionAsync` — the
pipeline is awaited INSIDE the listener). The previous
"await build → then add listener" pattern silently dropped the page's
immediate `request` message, making `curl` hang. See `docs/pitfalls.md`
"Chrome Port: onMessage Listener Must Attach Synchronously".

The SW also exposes message handlers:

- `secrets.list-masked-entries` — used by the page's `fetchSecretEnvVars()` to
  populate the agent shell env with masked values.
- `secrets.mask-oauth-token` — round-trip mask for an OAuth provider after
  `saveOAuthAccount`.
- `secrets.list` / `secrets.set` / `secrets.delete` — management ops for the
  `secret` shell command. Pages other than the extension's own origin can't
  reach `chrome.storage`, so the hosted leader proxies the storage call through
  the SW.
- `secrets.session.set` / `secrets.session.list` — in-memory **session-only**
  secrets held in a module-level `SessionSecretStore` (never written to
  `chrome.storage`; vanish when the SW is evicted). Layered into every
  `buildSecretsPipeline()` so the fetch proxy unmasks them like persisted ones.
  The agent sets these with `secret set <name> <value>` (no sudo prompt).
- `secrets.peek` — returns a redacted preview (first/last chars, middle elided)
  of a session or persisted value; the full value never leaves the SW.
- `secrets.set-domains` — scope edit (the sudo-gated `secret scope` op);
  updates a session secret's domains or rewrites a persisted secret's
  `_DOMAINS` while preserving its value.

### OAuth-token extra allowed domains

Each provider's hardcoded `oauthTokenDomains` is the immutable default
safelist. Users can layer additional allowed domains per-provider via:

- the panel-terminal `oauth-domain` shell command
- the **OAuth domains** tab on the options page (`secrets.html`)
- direct `localStorage` edit of `slicc_oauth_extra_domains` at the extension
  origin

The extras are read by `saveOAuthAccount` in `provider-settings.ts` and merged
with provider defaults (deduped case-insensitively), then sent in the
`secrets.mask-oauth-token` SW message — the service worker writes
`oauth.<id>.token` + `oauth.<id>.token_DOMAINS` to `chrome.storage.local`.
Page-side `oauth-bootstrap` re-pushes the merged list on every leader-tab
load, so newly-added extras apply on next leader reload.

## Dev Watch + Auto-Reload

Run `npm run dev:extension -w @slicc/chrome-extension` alongside the Local QA
Chrome. The script runs `vite build --watch` with `SLICC_EXT_DEV=1
SLICC_EXT_DEV_WATCH=1` so:

1. **Rebuild on edit** — Rollup re-runs every `closeBundle` hook (the
   esbuild-managed entries for `service-worker`, `sidepanel-entry`,
   `secrets-entry`, `preview-sw`, plus the copied static assets) on any change
   under `packages/chrome-extension/src/`. The `dev-reload` plugin registers
   those paths via `this.addWatchFile` from `buildStart` because Rollup's
   `build.watch.include` is filter-only and never picks up esbuild inputs
   outside the Rollup module graph.
2. **Sync to the Chrome path** — `closeBundle` overlay-copies `dist/extension/`
   into `$SLICC_EXT_PATH` (default `/tmp/slicc-ext-build`). Overlay (not
   `rmSync` then `cpSync`) is deliberate: wiping the destination would briefly
   remove the manifest under a loaded extension and trigger Chrome to evict the
   SW; the CDP reload that immediately follows would race.
3. **CDP-reload the extension** — connects to Chrome on `$SLICC_CDP_PORT`
   (default `9333`), finds the unique `*/service-worker.js` target (falls back
   to any `chrome-extension` origin page if the SW is idle / evicted — MV3 SWs
   die after 30s without events and `/json/list` does NOT wake them), and runs
   a single `chrome.runtime.reload()`. We deliberately do **not** also iterate
   `chrome.tabs` + `chrome.tabs.reload` from the SW: a tab-reload landing
   concurrently with the extension restart can leave Chrome with the extension
   disabled. Reopen the side panel by hand to pick up new panel code.

The wire stack uses `localhost` (not `127.0.0.1`) for CDP HTTP — Chrome for
Testing on macOS binds the listener to IPv6 (`::1`), and forcing IPv4 misses
it. Let Node's DNS resolve `localhost` per-platform order.

Failure modes log warnings but never fail the build: if Chrome isn't running,
the watcher keeps the build green and the next rebuild attaches automatically
once Chrome is up.

Source: `packages/chrome-extension/vite-plugins/dev-reload.ts` (pure helpers
tested in `tests/dev-reload.test.ts`). Env overrides: `SLICC_EXT_PATH` (sync
destination), `SLICC_CDP_PORT` (Chrome's `--remote-debugging-port`).

## Local QA: Dedicated Profile Pre-installed with the Extension

Use this when you want a clean Chrome instance running only the unpacked
extension. `npm run dev:extension:fresh`
(`packages/dev-tools/tools/dev-extension-fresh.sh`) builds the extension,
self-builds the leader UI (`npm run build -w @slicc/webapp`) when
`dist/ui/index.html` is missing, and reuses-or-starts wrangler on `:8787` to
serve it — so the pinned `http://localhost:8787/?slicc=leader` tab no longer
404s when `dist/ui` was never built. No manual prerequisite build of the
webapp is required.

**Same-origin local tray:** The harness runs wrangler in `--env staging` mode
(with `routes: []` making `url.origin = localhost:8787`) instead of forcing a
cross-origin `TRAY_WORKER_BASE_URL_OVERRIDE` to deployed staging. This is
critical for the cherry panel follower: a cross-origin tray fetch is
intercepted by `llm-proxy-sw` and routed to `/api/fetch-proxy` (absent on a
worker-served app), so the follower never connects. The same-origin local tray
fixes that and enables the on-demand cherry sidebar QA flows. The harness also
fail-fast validates reused wrangler instances to catch stale cross-origin tray
configs from another worktree.

### Manual recipe

1. **Build with `SLICC_EXT_DEV=1`** so the manifest key is stripped:

   ```bash
   SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension
   ```

2. **Use Chrome for Testing**, not your day-driver Chrome. Chrome release builds
   (>=137) silently drop `--load-extension` unless developer mode is already
   toggled on in the profile. Chrome for Testing accepts the flag without that
   ceremony. The repo's `findChromeExecutable` helper already prefers
   `~/.cache/puppeteer/chrome/mac_arm-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.

3. **Copy `dist/extension/` to a stable scratch path** so multiple runs reuse
   the same path-derived extension ID:

   ```bash
   rm -rf /tmp/slicc-ext-build && cp -r dist/extension /tmp/slicc-ext-build
   ```

4. **Launch Chrome for Testing** with an isolated profile and the extension
   preloaded. `--remote-debugging-port=0` lets Chrome pick a free port,
   discovered via `<userDataDir>/DevToolsActivePort`:

   ```bash
   CFT="$HOME/.cache/puppeteer/chrome/mac_arm-146.0.7680.153/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
   EXT="/tmp/slicc-ext-build"
   PROFILE="/tmp/slicc-ext-profile"
   rm -rf "$PROFILE" && mkdir -p "$PROFILE"
   GOOGLE_CRASHPAD_DISABLE=1 "$CFT" \
     --user-data-dir="$PROFILE" \
     --remote-debugging-port=0 \
     --no-first-run \
     --no-default-browser-check \
     --disable-crash-reporter \
     --disable-extensions-except="$EXT" \
     --load-extension="$EXT" \
     "chrome://extensions" &
   ```

5. **Find the extension ID** from CDP — it's path-derived from the
   `--load-extension` argument, so a fixed `EXT` path produces a fixed ID
   across runs:

   ```bash
   CDP=$(cat "$PROFILE/DevToolsActivePort" | head -1)
   curl -sS "http://localhost:$CDP/json/list" \
     | python3 -c 'import json,sys; [print(t["url"]) for t in json.load(sys.stdin) if "service-worker.js" in (t.get("url") or "")]'
   # → chrome-extension://<id>/service-worker.js
   ```

6. **Open the hosted leader tab** — the thin extension's UI lives at
   `https://www.sliccy.ai/?slicc=leader` (or `http://localhost:8787/?slicc=leader`
   when `SLICC_EXT_DEV=1`). The service worker pins it on install, but you can
   drive it directly via CDP:

   ```bash
   curl -sS -X PUT "http://localhost:$CDP/json/new?https://www.sliccy.ai/?slicc=leader"
   ```

**Tear down:**

```bash
pkill -f "Google Chrome.*slicc-ext-profile"
```

The same `EXT` and `PROFILE` paths can be reused on the next run, but
re-running steps 1 + 3 is the safest way to pick up code changes.

### QA scenarios

Build with `SLICC_EXT_DEV=1` and launch Chrome for Testing with the recipe.
Then verify each scenario:

1. **Leader tab boots on install.** After Chrome launches with the extension
   loaded, a pinned tab at `https://www.sliccy.ai/?slicc=leader` (or the
   localhost variant in dev) opens automatically. The webapp UI inside that tab
   is the agent surface.

2. **Toolbar icon focuses the leader.** Click the toolbar icon from any tab →
   the pinned leader tab becomes active in its window. If the leader window is
   in the background, it foregrounds too.

3. **Closing the leader recreates it.** Close the leader tab. Click the toolbar
   icon → a fresh pinned leader tab is created at the leader URL.

4. **Bridge keeps CDP working after panel close.** With the leader running,
   drive a `playwright-cli screenshot ...` against any tab. Verify
   `chrome.debugger` attach/detach traffic flows through the SW's `bridge-sw.ts`
   Port.

5. **On-demand cherry side panel.** Click the toolbar icon → Chrome opens the
   side panel (`sidepanel.html`) in the current window. Confirm the panel
   iframes the hosted `?cherry=1&ui-only=1` follower and it connects to the
   leader over the tray (tri-state resolves to the live follower UI, not a
   stuck "Starting" or "Disconnected" overlay). There is no per-page overlay
   injection.

## MV3 Remote Hosted Code Guard: Background

The `check-extension-rhc.sh` CDN-literal scan was originally introduced because
`https://unpkg.com/@ffmpeg/core@.../ffmpeg-core.js` was baked literally into
`@ffmpeg/ffmpeg`'s worker source, which the fat extension bundled. The thin
extension no longer bundles that code (ffmpeg runs in the hosted leader tab), so
the guard is now defense-in-depth against any full CDN literal reaching
`dist/extension/`. Without this history, a future developer triggering the guard
on a new CDN literal has no written record of why the guard exists.

## Automated CDP Smoke Test (Historical)

`packages/dev-tools/tools/extension-smoke-test.ts` is the end-to-end
verification that the rebuilt extension works in a real Chrome without
remote-code-hosting violations. The npm script `test:extension-smoke` runs it
after a fresh extension build:

```bash
npm run build -w @slicc/chrome-extension
npm run test:extension-smoke -w @slicc/chrome-extension
```

> **Status.** The script was written against the legacy fat-extension
> (offscreen + side-panel) architecture and was retired with the thin-bridge
> strip. CI runs it with `continue-on-error: true` while the thin-extension
> replacement — drive the pinned hosted leader tab via the SW's CDP bridge and
> assert that `ffmpeg -version` / `node -e` still run in the hosted leader
> tab's kernel worker (WASM/realms load from `dist/ui`, not from any bundled
> vendor JS in the extension) — is in flight. Treat the recipe below as
> historical context until the replacement lands.

What the script does:

1. Verifies `dist/extension/` exists.
2. Launches Chrome for Testing (via `findChromeExecutable`) with a disposable
   user-data-dir and `--load-extension=dist/extension`.
   `--remote-debugging-port=0` lets Chrome pick a free port, discovered via
   `<userDataDir>/DevToolsActivePort`.
3. Resolves the extension ID dynamically from `/json/list` (matches the
   `chrome-extension://<id>/service-worker.js` target).
4. Opens `chrome-extension://<id>/index.html?detached=1` as a regular tab so
   the legacy fat-UI bootstraps in a CDP-reachable target. (This step no longer
   applies in thin-bridge mode — the replacement will drive the pinned hosted
   leader tab instead.)
5. Installs a tiny in-page bridge via `Runtime.evaluate` that synthesizes
   `TerminalControlMsg` envelopes through `chrome.runtime.sendMessage` (the
   legacy wire format the old `TerminalSessionClient` used). The bridge opens
   one terminal session and exposes `window.__sliccSmokeExec(command)`.
6. Runs two scenarios with `Network.requestWillBeSent` capture:
   - **`ffmpeg -version`** — asserts exit 0, output contains `ffmpeg version`,
     no remote `.js` fetches from forbidden hosts (`unpkg.com`, `esm.sh`,
     `cdn.jsdelivr.net`), and `ffmpeg-core.js` was loaded from
     `chrome-extension://<id>/`.
   - **`node -e "..."`** with a `require('lodash')` — asserts exit 0 and
     non-empty stdout (validates the `esm.sh` JS-loader path).
7. Tears down Chrome and the tmp profile.

On failure the script prints a per-assertion diagnostic and writes a full
transcript to a temporary file (`smoke artifacts: <path>` is the last line on
stderr). Chrome stderr is captured next to it.

Local debugging knobs:

- `CHROME_PATH=<bin>` — override the resolved Chrome executable.
- `SLICC_SMOKE_KEEP_PROFILE=1` — skip teardown of the tmp profile.
- `SLICC_SMOKE_TIMEOUT_MS=180000` — extend the per-scenario budget.

CI runs the smoke test on Linux under `xvfb-run` (MV3 extensions and the
hosted leader tab both need headed Chrome; `--headless=new` is incompatible
with extension loading in production Chrome). The CI step is
`continue-on-error: true` while the thin-bridge replacement lands — the
artifact stays visible so regressions are obvious without blocking merges
during the rollout.
