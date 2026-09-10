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

The startup read is not the only one: `GET /api/secrets` (and `peek`, `scope`, `DELETE`) hit the store **per request**, and a request has nobody at a keyboard to answer an ACL dialog. `SecItemCopyMatching` is synchronous and uncancellable, Hummingbird sets no `idleTimeout`, and the webapp's `secret` backend used to `fetch` without a signal — so an ungranted item turned `secret list` into a permanent hang. Every request-path store call now goes through `BoundedStoreCall` (`Sources/Keychain/BoundedStoreCall.swift`): the call runs on a Dispatch queue rather than a cooperative thread, races a 5 s deadline, and a miss answers `503` with `errorCode: "persisted-store-unavailable"` plus the reason and the fix. The deadline sits below the webapp's 10 s control-plane budget so that diagnosis reaches the user instead of a bare client timeout. **The abandoned `SecItem*` call keeps its thread until the dialog resolves** — uncancellable by design, and accepted: an idle background thread beats a wedged route. A miss is never reported as an empty list, which would read as "no saved secrets".

Writes get the same deadline but a different contract, because an abandoned write **can still commit** once the dialog is answered. A timed-out `POST` / `DELETE` / scope-save answers `errorCode: "persisted-store-write-unknown"` and says the outcome is unknown and may yet apply — never that it failed, which would invite a retry that applies a rotation twice — and the route registers a late-completion hook that runs `SecretInjector.reload()` if the write does land, so the masking pipeline cannot keep injecting a superseded credential. `reload()` is bounded too, since it runs on session mutations that must not hang on the Keychain either; on a miss it keeps the previous snapshot rather than replacing it with a partial one, because dropping live secrets would silently stop masking them. `Tests/BoundedSecretStoreRoutesTests.swift` pins this with a store that stalls on demand, and asserts `/api/secrets/masked` (the snapshot route behind `secret get` and `printenv`) stays responsive throughout.

`SLICC_KEYCHAIN_NONINTERACTIVE=1` (set by the dev fresh-bridge harness) is only an anti-hang guard, not a fix for the prompt: a headless launch that would otherwise block on the unanswerable dialog fails fast with `errSecInteractionNotAllowed` instead of hanging. An already-granted item still reads fine; otherwise the read path logs an actionable hint and the server continues without Keychain secrets. It never produces silent success.

Suppressing that dialog takes **two** switches, and only the second one actually works on this item:

- `kSecUseAuthenticationUIFail` (`kSecUseAuthenticationUI`) governs the **data-protection** keychain. `ai.sliccy.slicc / __envfile__` is a **file-based** keychain item, so `SecItemCopyMatching` dispatches to `SecItemCopyMatching_osx` and the flag has no effect on the ACL dialog.
- `SecKeychainSetUserInteractionAllowed(false)` is the process-wide switch that does gate it. `SecretStore.withInteractionSuppressed` wraps every `SecItem*` call in read **and** write paths with it, restoring the previous state afterwards; interactive runs never touch the switch, so the first-run "Always Allow" grant still works.

Without the second switch the guard silently does nothing: a `nohup`-style launch hangs inside `SecItemCopyMatching` forever — **before** Hummingbird binds, so there is no port, no log line, and no Chrome — which reads as "the binary is broken" rather than "the Keychain is waiting". `KeychainSecretStoreTests` asserts the switch is flipped and restored; an assertion that only round-trips an already-granted item cannot catch this, because the test runner needs no dialog.

## API route contracts

Full validation semantics for handlers whose contract is byte-mirrored from `packages/node-server/`:

- `POST /api/handoff` (`Sources/Server/Handoff.swift`) — mirrors `packages/node-server/src/routes/handoff.ts`: validates the structured `{ verb, target, instruction?, url?, title?, branch?, path? }` payload; invalid → 400 with node-server's exact error string. Exception: a non-object JSON body returns this server's generic `Invalid JSON payload` (vs express's body-parser error). Broadcasts a `navigate_event` on the lick WebSocket.
- `GET|POST /api/secrets/session` — lists redacted `{ name, domains }` records and creates/replaces process-memory-only session secrets. Mutations reload `SecretInjector` immediately; persisted/env/OAuth sources retain masking precedence when names collide.
- `GET /api/secrets/peek`, `POST /api/secrets/scope`, `DELETE /api/secrets/:name` — preview, scope, and delete check session records first, then use the injected persisted store. Responses never contain a complete secret value.
- `GET|POST /api/secrets` — lists redacted `{ name, domains }` records and creates/replaces Keychain-backed persisted secrets. Mirrors `registerSecretRoutes` in `packages/node-server/src/routes/secrets.ts`: a missing/non-array `domains`, a missing `name`/`value`, or a malformed body is a 400; success is `{ ok: true }` followed by a `SecretInjector.reload()` so masking picks the secret up without a restart. An explicitly **empty** `domains` array is refused fail-closed — a secret with no declared domains is scoped to nothing, not to everything — as node-server's 500 with the same `Secret "NAME" must have at least one authorized domain` message. Reached only by an explicit `scope: "persisted"`; the agent's intrinsic sudo prompt gates the request before it is sent (`#2806`). **One Swift-only rejection:** a name defined by this server's `--env-file` is refused with a 409. That snapshot is re-applied _over_ the persisted store on every `SecretInjector.reload()`, so the write could never take effect — a 200 would leave the old credential in use, which is the worst possible answer to a rotation. node-server cannot reach this state (`--env-file` there IS the persisted store's backing file, `new EnvSecretStore(RUNTIME_FLAGS.envFile ?? …)`), so the 409 never fires on a request node would have accepted. **Shared rejection:** the canonical `.env` schema (`packages/shared-ts/src/secret-env-schema.ts`) is line-oriented, so a value containing a newline cannot round-trip. Both servers refuse it with a 400 naming the problem rather than persisting it truncated to its first line, and a refused overwrite leaves the previous credential intact (`#2828`). The predicate and its message are pinned across implementations in `Tests/CrossImplementationTests.swift` / `packages/shared-ts/tests/cross-impl-vectors.test.ts` — note Swift must compare unicode scalars, since it treats CRLF as a single `Character` equal to neither `"\n"` nor `"\r"`.
- `POST /api/secrets/scrub` — mirrors node-server's `routes/secrets.ts`: 400 on non-string `text`, else `{ text: scrubbed }` via `SecretInjector.scrub(text:)`. Real→masked scrub (defense-in-depth).
- `POST /api/s3-sign-and-forward`, `POST /api/da-sign-and-forward` (`Sources/Server/SignAndForward.swift`) — mirror `packages/node-server/src/secrets/sign-and-forward.ts`. S3 creds resolved from the Keychain (`SecretStore`); DA accepts a transient IMS bearer. DA envelopes may set `origin` to `https://admin.da.live` (default, Helix 5) or `https://api.aem.live` (Helix 6 Source Bus); anything else is `invalid_request` without fetching, matching `executeDaSignAndForward` (`#2811`).
- `POST /api/sudo-approve` (`Sources/Server/SudoApprove.swift`) — mirrors `packages/node-server/src/sudo/` (`endpoint.ts` + `dialog-backends.ts`): validates the `{ kind, detail, suggestedPattern? }` envelope (invalid → 400) and raises the same native `osascript` dialog by shelling out via `Process`. Loopback-only by construction; fail-closed to `{ decision: "deny" }` on any error.
- `ALL /api/fetch-proxy` — accepts standard HTTP verbs (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`) plus the WebDAV (RFC 4918) and CalDAV (RFC 4791) verbs `PROPFIND`, `PROPPATCH`, `MKCOL`, `MKCALENDAR`, `REPORT`, `COPY`, `MOVE`, `LOCK`, `UNLOCK`. Unknown verbs are forwarded to AsyncHTTPClient via `HTTPMethod.RAW(value:)`. Does not force `Accept-Encoding: identity` (AEM/Fastly then returns cached gzip with no `content-encoding`). `FetchProxyGzip.swift` sniffs gzip magic (`1f 8b`) and inflates; `content-encoding` is stripped because the page-scoped SW synthesizes `new Response()` which does not inflate. Node twin: `packages/node-server/src/fetch-proxy-gzip.ts`.

## CDP fetch-proxy body handling (parity-pinned)

Three Swift files mirror `@slicc/shared-ts` byte-for-byte; parity is pinned in `Tests/OverlayPostBodyTests.swift` and `Tests/CrossImplementationTests.swift` against `packages/shared-ts/tests/content-type-parity.test.ts` and `cross-impl-vectors.test.ts`.

- **`OverlayPostBody.swift`** — POST-body recovery for the CSP-strip Fetch proxy in `OverlayTargetSession.fetchAndStripCSP`. `decodeCdpRequestPostBody` prefers `postDataEntries[].bytes` (base64, byte-exact), accepts an ASCII `postData` string, and returns `.unrecoverable` → `Fetch.failRequest` for everything else. The old `Data(base64Encoded: postData) ?? postData.data(using: .utf8)` either mis-read a latin1 body as base64 or UTF-8-expanded it behind a successful fulfill. Byte-for-byte twin of node-server's `decodeCdpRequestPostBody`.
- **`ContentType.swift`** — Swift twin of shared-ts `content-type.ts`. `isTextContentType` gates the fetch-proxy response scrub in `makeStreamingProxyResponse`; `isTextRequestContentType` layers `urlencoded` on top and gates the REQUEST-body unmask — which bodies take the string `injectBody` path vs the byte-safe `unmaskBodyBytes` fallback (form bodies are text because they carry secrets; an EMPTY content type is not). Do **not** re-derive either list inline: the old local classifier missed `application/xml` / `application/javascript` / `image/svg+xml` (real secrets forwarded to the agent that node-server masked) and treated any `charset=` parameter as text, forcing binary bodies through a lossy `String` round-trip. Keep `urlencoded` OUT of the base predicate — the response hop does not want it.
- **`FormBodyUnmask.swift`** — owns `unmaskFormBody`, the encoding-aware unmask a form body takes instead of `injectBody`: a raw substring splice corrupts the request whenever the real secret carries a form-reserved character (`&`/`=` split a field, `+` decodes upstream as a space; base64 secrets carry `+` `/` `=`). It walks fields, unmasks each value DECODED, and re-encodes only what changed, with `encodeURIComponent`'s allowed set so both floats emit the same bytes. Mirrors `@slicc/shared-ts` `form-body-unmask.ts`.

## Mount table route internals (`/api/hostfs`)

`HostFSRoutes.swift` mirrors `hostfs.ts` byte-for-byte. Beyond the stable `POST /api/hostfs` dispatcher (list/stat/mkdir/rename/remove), errno JSON, traversal/symlink containment, mount-root delete refusal, and 100 MiB body cap:

- `Range` support on `read`: 206 + `Content-Range`, 416 outside the file; the cap applies to the unranged read only. Windows stream through a closure-backed `ResponseBody` in `streamChunkBytes` pieces so `bytes=0-` on a huge file never materializes.
- Strong `ETag`/`Last-Modified` from the stat with `If-None-Match`/`If-Modified-Since`/`If-Range` handling, mirroring `cacheValidator` in `hostfs.ts`.
- `BridgeSecurity.preflightMaxAge` mirrors node-server's: `/api/hostfs*` preflights get Chrome's 7200 s cap, the rest 600 s.
- `HostFSWatch.swift` owns one FSEventStream + debounce timer per configured mount, each retaining its mount/root identity so overlapping host roots broadcast invalidations to the correct cache namespace. It emits batched `hostfs_invalidate` events over `/licks-ws`; the webapp bypasses the opaque HTTP cache, memoizes bodies up to 4 MiB under a stable target + host namespace, and invalidates matching prefixes. Node parity: `hostfs-watch.ts`.
