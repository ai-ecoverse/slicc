# CLAUDE.md

Native macOS server in `packages/swift-server/`.

## Scope

`packages/swift-server/` is a Hummingbird standalone server: launches Chrome/Electron, proxies CDP, exposes the lick WebSocket/event surface, and owns the `/api` bridge (fetch-proxy, sign-and-forward, OAuth callback, secrets). Serves **no** UI in any mode (matching node-server). No `--dev` flag, no bundled `dist/ui`.

## Thin-bridge parity

Swift-server and `packages/node-server/` are byte-for-byte compatible bridges. Chrome/Electron pages load the hosted webapp (`https://www.sliccy.ai` or `http://localhost:8787` in wrangler dev) with local bridge via `?bridge=ws://localhost:<cdpPort>/cdp&bridgeToken=<token>` (Electron: `/electron?...&role=leader|follower`). `CDPProxy.swift` echoes `slicc.bridge.v1.<token>` per RFC 6455. See [`docs/architecture.md`](../../docs/architecture.md#thin-bridge-architecture).

Both launchers disable Local Network Access checks: `ChromeLauncher.buildLaunchArgs` (`Sources/Browser/ChromeLauncher.swift`) appends `--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets`. Chromium 142+ gates the hop behind an "Apps on device" prompt; Deny silently breaks CDP + `/api/*`. See [`docs/pitfalls.md`](../../docs/pitfalls.md).

The Electron overlay (`Sources/Browser/ElectronLauncher.swift`) is **thin-bridge only**; the legacy `http://localhost:<servePort>/electron` (Path A) bundled overlay was retired. Bootstrap `window.__SLICC_ELECTRON_OVERLAY__.inject()` is embedded from `dist/ui/electron-overlay-entry.js` (in `Contents/Resources/slicc/`), built by `@ai-ecoverse/spoon` (`node packages/spoon/build.mjs`); node-server reads the same file. Internals: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## Build and Test Commands

```bash
cd packages/swift-server
swift build
swift test
swift run slicc-server --help
npm run lint -w @slicc/swift-server   # SwiftLint
```

## Linting & Formatting

`.swiftlint.yml` inherits repo-root via `parent_config`, excludes `.build`. Only `error` fails CI. Auto-correct: `npm run lint:fix -w @slicc/swift-server`.

Formatting is `swift format` (Swift 6+) against repo-root `.swift-format` (swift-format walks up from each input file — no per-package copy).

```bash
npm run lint:format -w @slicc/swift-server   # swift format lint --strict (CI gate)
npm run format -w @slicc/swift-server        # swift format --in-place
```

Version-sensitive keys and the multi-line-interpolation footgun: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## Main Package Layout

- `Sources/Browser/` — Chrome/Electron launchers, console forwarding. `ElectronLauncher.swift` owns launch + `ElectronOverlayInjector`; per-target CDP worker: `OverlayTargetSession.swift`.
- `Sources/CLI/` — `ServerCommand` arg parsing / runtime bootstrap.
- `Sources/Follower/` — headless CDP-over-CDP follower for egress-blocked Electron apps.
- `Sources/Server/` — HTTP routes, thin-bridge CORS, logging, shutdown.
- `Sources/Signing/` — `SigV4Signer` (mirrors JS signers byte-for-byte against AWS canonical vectors).
- `Sources/WebSocket/` — CDP proxy and lick WebSocket system.
- `Tests/` — package tests.

## Electron `--join` — egress decides the attach route

Egress-ALLOWED apps attach via the overlay itself: the LEADER-role overlay URL
carries `tray=<join url>` (the Chrome join path's `?tray=` contract), so the
pinned first tab boots as a tray follower instead of minting its own tray.
In-app auto-follow tabs never carry it — one app, one follower. See
[`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## Egress-blocked Electron apps (Signal) — CDP over CDP

Signal-class Electron apps deny **all** renderer egress at the main process (`net::ERR_ACCESS_DENIED`), beneath `Page.setBypassCSP` / CDP Fetch. `ElectronOverlayEgress.swift` detects this via `Network.loadingFailed` on the overlay iframe and shows a **status-only** overlay (mirrors node-server's `electron-controller.ts`).

When blocked AND `--join` tray URL is given, swift-server exposes the app's CDP to the leader via a headless WebRTC tray follower (`Sources/Follower/`): `ElectronTrayFollower.swift` routes `tray-control`; `FederatedCDPServicer.swift` speaks raw browser CDP (`/json/version`) with `sendCDPResponse`-compatible 64 KB/32 KB chunking. Mirrors node-server's `electron-tray-follower.ts` / `electron-federated-cdp.ts`; Swift uses `stasel/WebRTC` via `packages/swift-trayfollower`. See [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## Server Overview

- `CLI/ServerCommand.swift` — entry; mirrors Node runtime flags; launches/attaches to a browser. Root mounts only `ThinBridgeCorsMiddleware` (`shouldMountThinBridgeCors`); `--serve-only` / `--electron` mount none. Gate: `isThinBridgeMode = !serveOnly && !electron`.
- `WebSocket/CDPProxy.swift` — CDP proxy; one browser WebSocket, ordered bounded async pump.
- `WebSocket/LickSystem.swift` — tracks clients, sends request/response, broadcasts lick events.

## API Routes

`Sources/Server/APIRoutes.swift` — main registry. Handlers mirror `packages/node-server/`; full contract details: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

- `GET /api/status` — `service: "slicc-server"` labels the floatbar `sliccstart` (vs `npx` for Node CLI).
- `GET /api/agent-activity` — non-OPTIONS `/api/fetch-proxy` within the 60-second window.
- `GET /api/runtime-config`, `/api/tray-status`, `/auth/callback`, `GET|POST /api/oauth-result`.
- `GET|POST|DELETE /api/webhooks...`, `/api/crontasks...`.
- `POST /api/handoff` (`Sources/Server/Handoff.swift`) — validates payload, broadcasts `navigate_event` on lick WebSocket.
- `GET /api/secrets`, `/api/secrets/masked`, `POST /api/secrets/scrub` (via `SecretInjector.scrub(text:)`).
- `POST /api/s3-sign-and-forward`, `/api/da-sign-and-forward` (`Sources/Server/SignAndForward.swift`) — S3 creds from Keychain, transient IMS bearer for DA.
- `POST /api/sudo-approve` (`Sources/Server/SudoApprove.swift`) — native `osascript` via `Process`; loopback-only; fail-closed to `{ decision: "deny" }`.
- `ALL /api/fetch-proxy` — HTTP verbs plus WebDAV/CalDAV `PROPFIND`, `PROPPATCH`, `MKCOL`, `MKCALENDAR`, `REPORT`, `COPY`, `MOVE`, `LOCK`, `UNLOCK`. Unknown → AsyncHTTPClient via `HTTPMethod.RAW(value:)`.

WebSocket routes install separately for CDP and lick.

## UI Serving (none)

**swift-server serves no static UI in any mode** — Chrome loads the hosted webapp from `https://www.sliccy.ai` (or `http://localhost:8787` in wrangler dev). `StaticFileMiddleware` / `--static-root` removed. Matches node-server (thin-bridge in **every** mode).

## Tab Session Restore

Chrome reopens previous session tabs minus the SLICC tab (dead token; `clearChromeSessionRestore` prevents `/cdp` eviction wars). URL-only snapshot in `Sources/Browser/TabSessionStore.swift` (sanitized on save **and** load — each entry is a Chrome argv slot), fed by `TabSessionRecorder.swift` (polls `/json/list`), replayed via `ChromeLaunchConfig.restoreUrls`. Not wired for `--serve-only` / `--electron`; node-server has no equivalent. See [`docs/sliccstart-browser.md`](../../docs/sliccstart-browser.md).

## Lick / WebSocket System

`LickSystem` (actor) tracks clients + pending requests; `LickWebSocketRoute` exposes `/licks-ws`. Browser-originated messages resolve pending requests or broadcast events into the runtime.

## Secrets Architecture

`OAuthSecretStore.swift` handles OAuth replicas via `POST /api/secrets/oauth-update` and `DELETE /api/secrets/oauth/:providerId`. Pipeline: `Sources/Keychain/SecretInjector.swift`. Masks match `@slicc/shared-ts` byte-for-byte via `Tests/CrossImplementationTests.swift` (pinned to `packages/shared-ts/tests/cross-impl-vectors.test.ts`). `SecretStore.swift` reads `ai.sliccy.slicc / __envfile__` at startup via `SecItemCopyMatching`.

**Trust model (why the prompt recurs).** The default ACL trusts only the creating binary's cdhash; ad-hoc signatures get a new cdhash every `swift build`, re-raising the "allow access" dialog. Durable fix: `packages/dev-tools/tools/setup-dev-cert.sh` installs a stable code-signing identity so one **"Always Allow"** survives rebuilds. Identity must be **trusted** via `security add-trusted-cert -p codeSign`, not just imported. Deep-dive: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

`SLICC_KEYCHAIN_NONINTERACTIVE=1` (dev harness) is an **anti-hang guard only**: `readBlob` passes `kSecUseAuthenticationUIFail`, so headless launches fail fast with `errSecInteractionNotAllowed` instead of hanging. Already-granted items read; otherwise continues **without** Keychain secrets. Never silent success.

## Graceful Shutdown and Detach

`Sources/Server/GracefulShutdown.swift` handles `SIGINT`/`SIGTERM` (full shutdown, `closeBrowser: true`) and `SIGUSR1` (`detach()`, `closeBrowser: false` — HTTP + CDP stop, browser stays open). Sliccstart uses `detach()` for binary swaps without killing the user's session (see `packages/swift-launcher/CLAUDE.md` "Smooth-Update Modules"). Second signal after `detach()` no-ops via `GracefulShutdownHandler.shuttingDown`.

## Related Guides

- `packages/node-server/CLAUDE.md` — parallel Node runtime
- `packages/shared-ts/CLAUDE.md` — masking primitives
- `docs/development.md` — run/debug workflow
- `docs/transcript-export.md` — transcript export (webapp; swift-server transparent)
- [`docs/swift-server-details.md`](../../docs/swift-server-details.md) — extended internals
