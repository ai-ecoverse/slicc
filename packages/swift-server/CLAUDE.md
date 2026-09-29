# CLAUDE.md

Native macOS server (`packages/swift-server/`).

## Scope

Hummingbird standalone server: launches Chrome/Electron, proxies CDP, exposes the lick WebSocket/event surface, owns the `/api` bridge (fetch-proxy, sign-and-forward, OAuth callback, secrets). Serves **no** UI in any mode (thin-bridge everywhere, like node-server): no `--dev`, `dist/ui`, or `--static-root`.

## Thin-bridge parity

Swift-server and `packages/node-server/` are byte-for-byte compatible bridges. Chrome/Electron pages load the hosted webapp (`https://www.sliccy.ai`, or `http://localhost:8787` in wrangler dev) with local bridge via `?bridge=ws://localhost:<cdpPort>/cdp&bridgeToken=<token>` (Electron: `/electron?...&role=leader|follower`); `CDPProxy.swift` echoes `slicc.bridge.v1.<token>` per RFC 6455. [Architecture](../../docs/architecture.md#thin-bridge-architecture).

Both launchers (`ChromeLauncher.buildLaunchArgs` here, node-server's `chrome-launch.ts` — byte-identical) disable Chromium local-network-access checks and every background-throttling feature, so a backgrounded leader is never frozen. Flags/rationale: [details](../../docs/swift-server-details.md#chrome-launch-flags), [pitfalls](../../docs/pitfalls.md). The Electron overlay (`ElectronLauncher.swift`) is **thin-bridge only**: `window.__SLICC_ELECTRON_OVERLAY__.inject()` embeds `dist/ui/electron-overlay-entry.js`, built by `@ai-ecoverse/spoon`.

## Build, Test, Lint

```bash
cd packages/swift-server
swift build && swift test
swift run slicc-server --help
npm run lint -w @slicc/swift-server           # SwiftLint
npm run lint:fix -w @slicc/swift-server       # swiftlint --fix
npm run lint:format -w @slicc/swift-server    # swift format lint --strict (CI gate)
npm run format -w @slicc/swift-server         # swift format --in-place
```

`.swiftlint.yml` inherits repo-root via `parent_config`, excludes `.build`; only `error` fails CI. Formatting is `swift format` (Swift 6+) against repo-root `.swift-format` — no per-package copy. Version-sensitive keys + multi-line-interpolation footgun: [details](../../docs/swift-server-details.md).

## Package Layout

- `Sources/Browser/` — Chrome/Electron launchers, console forwarding; `ElectronLauncher.swift` owns launch + `ElectronOverlayInjector`; per-target CDP worker `OverlayTargetSession.swift`.
- `Sources/CLI/` — `ServerCommand.swift`: entry/bootstrap; mirrors Node runtime flags, launches/attaches a browser. Root mounts only `ThinBridgeCorsMiddleware`; `--serve-only`/`--electron` mount none (`isThinBridgeMode`).
- `Sources/Follower/` — headless CDP-over-CDP follower for egress-blocked Electron apps. `Sources/Signing/` — `SigV4Signer` (mirrors JS signers vs AWS vectors). `Sources/Server/` — HTTP routes, CORS, logging, shutdown.
- `Sources/WebSocket/` — `CDPProxy.swift` (one browser WebSocket, ordered bounded pump) + `LickSystem.swift` (actor tracking clients + pending requests; `LickWebSocketRoute` exposes `/licks-ws`; browser messages resolve pending or broadcast events). Both install apart from `/api`.

**`/cdp` close codes** (mirror node-server; webapp `cdp-client.ts` latches both). `4001` = superseded (newer client took the single slot; evicted tab stops re-dialing). `4002 upstream-reset` = the Chrome leg dropped and discarded every CDP session; the proxy closes the client **after** the reconnect loop has the leg back, resetting ONLY the client that held the slot when it dropped. `upstreamResetFailureThreshold`, `messageBuffer` generations, drop reasons: [details](../../docs/swift-server-details.md).

## Electron `--join` — egress decides the attach route

Two routes, chosen by whether the app allows renderer egress:

- **Egress allowed**: the LEADER-role overlay URL carries `tray=<join url>` (the Chrome join path's `?tray=` contract), so the pinned first tab boots as a tray follower. In-app auto-follow tabs carry an explicitly EMPTY `tray=`, blocking the webapp's stored-join-URL fallback at the shared sliccy.ai origin — one app, one follower.
- **Egress blocked** (Signal-class): the app denies renderer egress at the main process (`net::ERR_ACCESS_DENIED`), so the overlay never loads. `ElectronOverlayEgress.swift` detects it via `Network.loadingFailed`, shows a status-only overlay (mirrors `electron-controller.ts`); with a `--join` tray URL, swift-server instead exposes the app's CDP to the leader via a headless WebRTC tray follower in `Sources/Follower/` (mirrors `electron-tray-follower.ts`/`electron-federated-cdp.ts`). Internals: [details](../../docs/swift-server-details.md).

## API Routes

`Sources/Server/APIRoutes.swift` — registry; handlers mirror `packages/node-server/`; contracts: [details](../../docs/swift-server-details.md).

- `GET /api/status` — `service: "slicc-server"` labels the floatbar `sliccstart` (vs `npx` for Node CLI). `GET /api/agent-activity` — non-OPTIONS `/api/fetch-proxy` within 60 s. Plus `/api/runtime-config`, `/api/tray-status`, `/auth/callback`, `GET|POST /api/oauth-result`, `GET|POST|DELETE /api/{webhooks,crontasks}...`; `POST /api/handoff` (`Handoff.swift`) validates + broadcasts `navigate_event`.
- Secrets (see Secrets Architecture): `GET|POST /api/secrets{,/session}`, `/api/secrets/{masked,peek}`, `POST /api/secrets/{scope,scrub}`, session-first `DELETE /api/secrets/:name`.
- `POST /api/{s3,da}-sign-and-forward` (`SignAndForward.swift`) — S3 creds from Keychain, transient IMS bearer for DA; DA `origin` allow-list in lockstep with `@slicc/shared-ts` `DA_ALLOWED_ORIGINS`. `POST /api/sudo-approve` (`SudoApprove.swift`) — native `osascript` via `Process`; loopback-only, fail-closed `deny`.
- `ALL /api/fetch-proxy` — HTTP + WebDAV/CalDAV verbs (`PROPFIND`, `MKCOL`, `REPORT`, `COPY`, `MOVE`, `LOCK`, …); unknown → AsyncHTTPClient via `HTTPMethod.RAW(value:)`. Does **not** force `accept-encoding: identity`; `FetchProxyGzip.swift` sniffs gzip magic + inflates undeclared gzip. Raw mode (#3571, `RawFetchProxy.swift` + `RawFetchProtocol.swift`) answers `X-Slicc-Raw-Probe` and `X-Slicc-Raw-Request` POSTs ahead of the default handler, on its own no-redirect `HTTPClient` (`RawFetchProxy.makeHTTPClient()`); contract rules are pinned against shared-ts in `CrossImplementationTests`, and header/body/HMAC secret handling is shared with the default route (`FetchProxySecrets.swift`). [Details](../../docs/webapp-details.md#raw-mode-3571).

## Tab Session Restore

Chrome reopens previous session tabs minus the SLICC tab (dead token; `clearChromeSessionRestore` prevents `/cdp` eviction wars). URL-only snapshot in `TabSessionStore.swift` — sanitized on save **and** load (each entry is a Chrome argv slot) — fed by `TabSessionRecorder.swift`, replayed via `ChromeLaunchConfig.restoreUrls`. Not wired for `--serve-only`/`--electron`; no node twin. [sliccstart-browser](../../docs/sliccstart-browser.md).

## Mount table (`--mount`)

Repeatable `--mount <os-path>:<slicc-path>` (`ServerCommand.mount` → `ServerConfig.mounts` via `parseMountMapping`; parity with node-server's `parseMountTableMapping`). `HostFSRoutes.swift` serves mapped folders over `/api/hostfs`, mirroring `hostfs.ts`. Advertised as `autoMounts` on `GET /api/runtime-config`; the webapp auto-mounts at boot, no picker/permission. Sliccstart feeds the flags from Settings → Mounts. Route internals (`Range`/cache validators, preflight caps, `HostFSWatch`): [details](../../docs/swift-server-details.md); setup: [mounts](../../docs/mounts.md).

## Secrets Architecture

Stores: `OAuthSecretStore.swift` (OAuth replicas); `SessionSecretStore.swift` (process-memory session records); `SecretStore.swift` (reads `ai.sliccy.slicc / __envfile__` at startup via `SecItemCopyMatching`). `SecretInjector.swift` layers sessions after persisted/env/OAuth so persisted/OAuth keep masking precedence on name collisions. `PersistedSecretAPIRoutes` owns `GET|POST /api/secrets`; the Keychain write mirrors node-server, refuses empty `domains` fail-closed. Masks + fetch-proxy body handling (`ContentType.swift`, `FormBodyUnmask.swift`) are byte-mirrored from `@slicc/shared-ts` (`Tests/CrossImplementationTests.swift`) — don't re-derive content-type lists inline.

**Trust model (why the prompt recurs).** The default ACL trusts only the creating binary's cdhash, which changes every ad-hoc `swift build`, re-raising the "allow access" prompt. Durable fix: `packages/dev-tools/tools/setup-dev-cert.sh` installs a stable, **trusted** signing identity (`security add-trusted-cert -p codeSign`) so one **"Always Allow"** survives rebuilds. Request-path store calls go through `BoundedStoreCall` (5 s deadline → `503`, never an empty list). `SLICC_KEYCHAIN_NONINTERACTIVE=1` (dev harness) is an anti-hang guard — headless launches fail fast without Keychain secrets, never silent success. [Full rationale](../../docs/swift-server-details.md). **Tests never touch the real item:** any test class reaching `SecretStore` (directly, via `SecretInjector`'s default `.keychain` store, or `SignAndForward.defaultSecretLookup`) calls `InMemoryKeychain.install()` in `setUp` — `xctest` is off the ACL, so a real read raises the dialog and a write edits real secrets.

## Graceful Shutdown / Detach

`GracefulShutdown.swift` handles `SIGINT`/`SIGTERM` (full shutdown, `closeBrowser: true`) and `SIGUSR1` (`detach()`, `closeBrowser: false` — HTTP + CDP stop, browser open). Sliccstart uses `detach()` for binary swaps without killing the user's session (`packages/swift-launcher/CLAUDE.md`); a second signal after it no-ops. `SIGPIPE` is ignored first thing in `run()` (`BrokenPipeSignal`): Sliccstart owns our pipes, so an orphaned server's next log line must fail with `EPIPE`, not kill it. Node ignores `SIGPIPE` by default, so node-server needs no twin.

## Related Guides

`packages/node-server/CLAUDE.md` (parallel Node runtime) · `packages/shared-ts/CLAUDE.md` (masking) · `docs/development.md` · `docs/transcript-export.md` · [extended internals](../../docs/swift-server-details.md).
