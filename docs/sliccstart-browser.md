# Sliccstart as a Browser

Two behaviors let the macOS launcher (`packages/swift-launcher/`) stand in for a
web browser: it can hold the **default web browser** role, and a launched Chrome
**reopens the previous session's tabs**. The first lives in the launcher, the
second in `packages/swift-server/`.

## Default Browser Role

Sliccstart renders no web content. Holding the http/https handler role means
links from other apps arrive in the launcher and are opened as tabs in the SLICC
leader browser, starting that browser first when it is not running yet. The role
is therefore offered next to "launch browser at startup" — without a leader
waiting there would be nothing to hand links to.

### Registration

`Models/DefaultBrowserRegistration.swift`:

- `isDefault()` asks LaunchServices who handles `probeURL` and compares against
  `Bundle.main.bundleURL` on **resolved paths** (`matches`). The answer is
  canonicalized and may differ by a trailing slash or a `.`-component, so
  comparing `URL` values directly reports a false negative.
- `makeDefault()` claims both `handledSchemes` (`http`, `https`) through
  `NSWorkspace.setDefaultApplication(at:toOpenURLsWithScheme:)` and then
  **re-reads** the role instead of trusting the absence of an error: macOS raises
  its own confirmation panel, and a user who declines leaves the handler
  unchanged with no error reported.
- `isRegistrable` is `SliccBootstrapper.isBundled`. A `swift run` binary has no
  `.app` bundle for LaunchServices to record, so the Settings control is disabled
  rather than raising a prompt that cannot stick.

`assemble-app.mjs` declares the matching Info.plist keys:

- `CFBundleURLTypes` with `http` + `https` — what macOS reads to populate the
  "Default web browser" list, and the precondition for a handler change to be
  accepted at all. Keep in step with `handledSchemes`.
- `CFBundleDocumentTypes` viewer entry for `public.html` / `public.xhtml` at
  `LSHandlerRank: Alternate` — the document-side obligation, ranked below real
  browsers so Sliccstart does not take over HTML files it was not asked about.

Contract test: `packages/swift-launcher/macos-permissions.test.mjs`.

### Routing an incoming link

`Models/IncomingURLRouter.swift`, driven by
`SliccstartAppDelegate.application(_:open:)`:

1. `openableSchemes` keeps `http`, `https`, and `file` (the HTML documents the
   bundle claims) and drops everything else — `javascript:`, `data:`, and app
   schemes are never forwarded into the leader.
2. With a leader running, each link becomes a tab through
   `PUT /json/new?<percent-encoded url>`. Chrome reads the **whole query string**
   as the target URL — a `?url=<url>` spelling silently opens `about:blank` — and
   rejects GET on that endpoint since Chrome 111.
3. `/json/new` creates the tab in the **background**, so the router follows up
   with `/json/activate/<targetId>` (id read from the `/json/new` response) and
   activates the browser application. The app brought forward is the one that
   owns the CDP port just written to (`LeaderBrowserEndpoint.appPath`), **not**
   `topBrowser()`: the user can start any browser by hand, so the leader is not
   necessarily the head of the Browsers list, and re-deriving the pick here
   would foreground the wrong app and leave the link hidden.
4. With no leader, the router starts the top ordered browser
   (`AppOrdering.topBrowser(in:savedOrder:)` — the same pick startup auto-launch
   uses) and waits up to ~45s for `SliccProcess.leaderBrowserEndpoint`,
   re-attempting the launch every ~10s. A single attempt is not enough: it can
   lose the race against startup's own auto-launch, or run while the app is
   still bootstrapping. Links that never find a leader are reported through
   `LauncherErrorReport.report(.openIncomingUrl, …)`.

`leaderBrowserEndpoint` pairs the CDP port with the launch record's key (the
browser's bundle path) so callers cannot address one browser while activating
another. It gates on a listening CDP port only: unlike `isLeaderReady()` it does
not wait for a tray join URL, because opening a plain tab does not need one.

`NSWorkspace.open(_:withApplicationAt:)` is deliberately **not** used for
delivery: the SLICC browser runs on its own `--user-data-dir`, so when the user
also has the same browser open on their normal profile, LaunchServices picks
between the two instances non-deterministically. The CDP port only ever answers
for the leader.

Tests: `DefaultBrowserRegistrationTests`, `IncomingURLRouterTests`. The mutating
`makeDefault()` is not unit-tested — it rewrites the real LaunchServices database
and raises a modal system panel.

## Tab Session Restore

A launched Chrome reopens the tabs from the previous session, minus the SLICC
tab: its bridge token is dead by the next launch, and a second leader tab
restarts the `/cdp` eviction war that `ChromeLauncher.clearChromeSessionRestore`
exists to prevent. Chrome's own session restore therefore stays wiped and
swift-server keeps its own snapshot.

- `Sources/Browser/TabSessionStore.swift` — one JSON file per profile at
  `~/Library/Application Support/Slicc/sessions/<profile-dir>-tabs.json`, keyed
  off the user-data-dir's last path component so each profile (and therefore each
  serve port) keeps its own tab set. `sanitize` runs on **both** save and load:
  absolute `http(s)` URLs with a host only, minus SLICC surfaces (an origin in
  `hostedOrigins`, or a `bridge`/`bridgeToken` query parameter), deduplicated in
  first-seen order, capped at `maxRestoredTabs` (50). The file is user-writable
  and every surviving entry becomes a Chrome argv slot, so a `--flag`-shaped or
  `file://` entry must never survive — `buildLaunchArgs` re-sanitizes as well.
- `Sources/Browser/TabSessionRecorder.swift` — actor polling `/json/list` every
  5s. Polling rather than subscribing to `Target.targetInfoChanged` keeps this off
  the `/cdp` socket the webapp owns, so it cannot evict the leader's CDP session.
  A failed or non-2xx poll is dropped rather than persisted, so a quitting browser
  never erases the last good snapshot.
- `ChromeLaunchConfig.restoreUrls` → `buildLaunchArgs` appends them **after**
  `launchUrl`, because Chromium activates the first URL on the command line: the
  SLICC tab stays leftmost and focused (verified against Chrome 147).
- `ServerCommand` loads the snapshot before launch and starts the recorder once
  the server is up. `ShutdownContext.tabRecorder` takes the final snapshot in
  `runShutdownSequence` while CDP is still reachable — including the detach path,
  where the browser survives and the next full launch consumes the snapshot.
- Restored order follows `/json/list`, which is roughly most-recently-used rather
  than left-to-right tab order, so tab positions are not preserved. Pinned tabs,
  tab groups, window layout, scroll positions, and per-tab back/forward history
  are lost as well — the snapshot is URLs only.

Not wired for `--serve-only` (it attaches to a browser it did not launch, so it
knows neither the profile directory nor the SLICC origin set) or for
`--electron`. **node-server has no equivalent**: this is intentionally
swift-server-only, so `packages/node-server/src/chrome-launch.ts` keeps the plain
session wipe.

Tests: `TabSessionStoreTests`, `TabSessionRecorderTests`, plus the restore-arg
cases in `ChromeLauncherTests` and the snapshot ordering case in
`GracefulShutdownHandlerTests`.
