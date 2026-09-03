# swift-server extended internals

Deep-dive material moved out of `packages/swift-server/CLAUDE.md` for headroom. The package guide remains the entry point; consult it first.

## Thin-bridge internals

The Electron overlay bootstrap bundle (`window.__SLICC_ELECTRON_OVERLAY__.inject()`) is embedded at build time by `loadOverlayBundleSource()`, which reads `dist/ui/electron-overlay-entry.js` from the packaged `Contents/Resources/slicc/` and falls back to a minimal inline stub if absent. That single artifact is produced by the `@ai-ecoverse/spoon` package (`node packages/spoon/build.mjs`), a fast webapp-free esbuild — **not** the webapp. `swift-launcher`'s `assemble-app.mjs` (`copy-overlay-entry.mjs`) copies it into the `.app`, and CI builds only spoon before assembly. Consequences:

- A `packages/spoon/**` change re-triggers the macOS `swift-launcher` job.
- A general webapp UI change does not — the overlay entry is decoupled.
- `node-server` reads the same `dist/ui/electron-overlay-entry.js` from disk via `getElectronOverlayEntryDistPath`, so both bridges stay byte-for-byte compatible on the overlay too.

`ElectronOverlayInjector`'s production initializer requires a `ThinBridgeConfig`. The hosted-leader origin defaults to production via `resolveHostedLeaderOrigin`, so the only unresolvable case is a missing per-process bridge token; `ServerCommand` then logs a clear error and skips the injector (fail fast) instead of ever serving a bundled overlay.

## Formatting quirks (swift-format)

The shared `.swift-format` config parses on swift-format 6.1 and newer. Two version-sensitive keys:

- `reflowMultilineStringLiterals` must stay in the object enum form (`{ "never": {} }`). 6.1 rejects the plain-string spelling; 6.2+ accepts both.
- `orderedImports` is only honoured from 6.3 on; older toolchains ignore it silently.

CI runs whatever `macos-latest` ships (6.3 today).

Avoid multi-line string interpolations inside a multi-line string literal: swift-format re-indents the two independently and can emit non-compiling Swift. Hoist the interpolated expression into a local instead.

## `--join` on the Electron path — two attach routes

An Electron app launched with `--join` attaches to the running leader by one of
two routes, decided by whether the app allows renderer egress:

- **Egress allowed** (most apps): the overlay injector's LEADER-role bootstrap
  URL carries `tray=<normalized join url>` (the same `?tray=` contract the
  Chrome `--join` path emits via `buildCanonicalTrayLaunchURL`, matched by the
  webapp's `resolveFollowerJoinUrl`), so the pinned first tab boots as a tray
  FOLLOWER. Omitting the param was the bug that made egress-allowed apps mint
  their own tray as a second leader. Every injector URL carries EXPLICIT tray
  intent: in-app auto-follow tabs (role=follower) — and a no-join leader — get
  an explicitly EMPTY `tray=`, because the leader tab persists the join URL
  into the shared sliccy.ai localStorage and `resolveFollowerJoinUrl`'s
  storage fallback would otherwise boot every extra window as ANOTHER tray
  follower. One app registers exactly one tray follower.
- **Egress blocked** (Signal-class): the overlay can never load, so
  `onEgressBlocked` starts the headless CDP-over-CDP WebRTC follower below.

## CDP-over-CDP follower

`ElectronTrayFollower.swift` joins the tray, answers the leader's WebRTC offer, opens the `tray-control` channel, sends `hello` + `targets.advertise`, and routes inbound messages (ping→pong, `cdp.request`→servicer). The signalling + WebRTC + supersede-redirect transport is the shared `TrayFollowerConnector` from the `packages/swift-trayfollower` package's `SliccTrayFollower` product, also used by the iOS app — the WebRTC framework is not double-shipped.

`FederatedCDPServicer.swift` connects to the app's raw browser-level CDP (`/json/version`) and translates the leader's tray-sync CDP messages to/from it (`targets.advertise`, `cdp.request`→`cdp.response` with `sendCDPResponse`-compatible 64 KB-threshold / 32 KB chunking, `cdp.event`). Its `CDPWebSocketTransport` (shared with `CDPBrowserSession`) is injectable so the frame pump is unit-tested without a live browser.

`ElectronOverlayInjector.onEgressBlocked` fires once on first detection; `ServerCommand` starts the follower on that signal and stops it on shutdown. Mirrors node-server's `electron-tray-follower.ts` / `electron-federated-cdp.ts` (which use `werift`); the Swift path uses in-process `stasel/WebRTC`.

## Chrome launch flags

Both launchers (`ChromeLauncher.buildLaunchArgs` here, node-server's
`chrome-launch.ts` — kept byte-identical) append
`--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets,IntensiveWakeUpThrottling,HighEfficiencyModeAvailable,InfiniteTabsFreezing,InfiniteTabsFreezingOnMemoryPressure,CPUMeasurementInFreezingPolicy,MemoryMeasurementInFreezingPolicy,AllowDevtoolsConnectedDiscard`
plus `--disable-background-timer-throttling`,
`--disable-backgrounding-occluded-windows`, and
`--disable-renderer-backgrounding`. Both also seed the profile's
`Default/Preferences` with the version-stable freeze/discard opt-outs before
every spawn (`seedProfilePreferences` here, `seedChromeProfilePreferences` in
node) — Chrome 151 renamed the freezing features once already
(see [`docs/pitfalls.md`](pitfalls.md)).

The LNA pair: Chromium 142+ gates the local hop behind an "Apps on device"
prompt, and Deny silently breaks CDP + `/api/*`. The rest keep the leader tab
alive in the background — Memory Saver freezing a backgrounded leader suspends
its event loop, leaving the tray unreachable and turns stuck on a working turn
— so the launched Chrome deliberately opts out of background power savings, at
a real battery cost on portables. See [`docs/pitfalls.md`](pitfalls.md).

## Keychain trust model — why the prompt recurs

`SecretStore.swift` reads the single `ai.sliccy.slicc / __envfile__` Keychain blob synchronously at startup via one `SecItemCopyMatching` in `readBlob()`. That item was created with the default trusted-application ACL, which trusts ONLY the creating binary identified by its code-signing cdhash. An ad-hoc signature gets a NEW cdhash on every `swift build`, so each rebuilt `slicc-server` is a different, untrusted binary and macOS re-raises the "allow access" ACL dialog.

The durable fix is a stable code-signing identity (`packages/dev-tools/tools/setup-dev-cert.sh`): a constant Designated Requirement means a single interactive **"Always Allow"** grant survives every rebuild. Notes:

- The `unsigned:` partition-list token is **not** a reliable grant for per-rebuild ad-hoc binaries — do not rely on it.
- The identity must be TRUSTED, not just imported. A self-signed cert imports as `CSSMERR_TP_NOT_TRUSTED`, so `security find-identity -v -p codesigning` (the valid-only form both `setup-dev-cert.sh` and `dev-swift-fresh.sh` use to detect it) lists nothing, and the harness silently falls back to ad-hoc signing — leaving `/api/secrets/masked` empty.
- `setup-dev-cert.sh` therefore runs `security add-trusted-cert -p codeSign` in the user trust domain (no `sudo`/`-d`, applied non-interactively) after import, and de-duplicates any pre-existing copies by SHA-1 hash first (a CN is "ambiguous" once stacked) so exactly one valid identity remains.

`SLICC_KEYCHAIN_NONINTERACTIVE=1` (set by the dev fresh-bridge harness) is only an anti-hang guard, not a fix for the prompt: it makes `readBlob` pass `kSecUseAuthenticationUIFail` so a headless launch that would otherwise block on the unanswerable dialog fails fast with `errSecInteractionNotAllowed` instead of hanging. An already-granted item still reads fine; otherwise the read path logs an actionable hint and the server continues without Keychain secrets. It never produces silent success.

## API route contracts

Full validation semantics for handlers whose contract is byte-mirrored from `packages/node-server/`:

- `POST /api/handoff` (`Sources/Server/Handoff.swift`) — mirrors `packages/node-server/src/routes/handoff.ts`: validates the structured `{ verb, target, instruction?, url?, title?, branch?, path? }` payload; invalid → 400 with node-server's exact error string. Exception: a non-object JSON body returns this server's generic `Invalid JSON payload` (vs express's body-parser error). Broadcasts a `navigate_event` on the lick WebSocket.
- `GET|POST /api/secrets/session` — lists redacted `{ name, domains }` records and creates/replaces process-memory-only session secrets. Mutations reload `SecretInjector` immediately; persisted/env/OAuth sources retain masking precedence when names collide.
- `GET /api/secrets/peek`, `POST /api/secrets/scope`, `DELETE /api/secrets/:name` — preview, scope, and delete check session records first, then use the injected persisted store. Responses never contain a complete secret value.
- `GET|POST /api/secrets` — lists redacted `{ name, domains }` records and creates/replaces Keychain-backed persisted secrets. Mirrors `registerSecretRoutes` in `packages/node-server/src/routes/secrets.ts`: a missing/non-array `domains`, a missing `name`/`value`, or a malformed body is a 400; success is `{ ok: true }` followed by a `SecretInjector.reload()` so masking picks the secret up without a restart. An explicitly **empty** `domains` array is refused fail-closed — a secret with no declared domains is scoped to nothing, not to everything — as node-server's 500 with the same `Secret "NAME" must have at least one authorized domain` message. Reached only by an explicit `scope: "persisted"`; the agent's intrinsic sudo prompt gates the request before it is sent (`#2806`).
- `POST /api/secrets/scrub` — mirrors node-server's `routes/secrets.ts`: 400 on non-string `text`, else `{ text: scrubbed }` via `SecretInjector.scrub(text:)`. Real→masked scrub (defense-in-depth).
- `POST /api/s3-sign-and-forward`, `POST /api/da-sign-and-forward` (`Sources/Server/SignAndForward.swift`) — mirror `packages/node-server/src/secrets/sign-and-forward.ts`. S3 creds resolved from the Keychain (`SecretStore`); DA accepts a transient IMS bearer. DA envelopes may set `origin` to `https://admin.da.live` (default, Helix 5) or `https://api.aem.live` (Helix 6 Source Bus); anything else is `invalid_request` without fetching, matching `executeDaSignAndForward` (`#2811`).
- `POST /api/sudo-approve` (`Sources/Server/SudoApprove.swift`) — mirrors `packages/node-server/src/sudo/` (`endpoint.ts` + `dialog-backends.ts`): validates the `{ kind, detail, suggestedPattern? }` envelope (invalid → 400) and raises the same native `osascript` dialog by shelling out via `Process`. Loopback-only by construction; fail-closed to `{ decision: "deny" }` on any error.
- `ALL /api/fetch-proxy` — accepts standard HTTP verbs (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`) plus the WebDAV (RFC 4918) and CalDAV (RFC 4791) verbs `PROPFIND`, `PROPPATCH`, `MKCOL`, `MKCALENDAR`, `REPORT`, `COPY`, `MOVE`, `LOCK`, `UNLOCK`. Unknown verbs are forwarded to AsyncHTTPClient via `HTTPMethod.RAW(value:)`.
