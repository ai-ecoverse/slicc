# CLAUDE.md

Native macOS server in `packages/swift-server/`.

## Scope

A Hummingbird standalone server: launches Chrome/Electron, proxies CDP, exposes the lick WebSocket/event surface, and owns the `/api` bridge (fetch-proxy, sign-and-forward, OAuth callback, secrets). Serves **no** UI in any mode (thin-bridge everywhere, like node-server): no `--dev`, `dist/ui`, `StaticFileMiddleware`, or `--static-root`.

## Thin-bridge parity

Swift-server and `packages/node-server/` are byte-for-byte compatible bridges. Chrome/Electron pages load the hosted webapp (`https://www.sliccy.ai`, or `http://localhost:8787` in wrangler dev) with local bridge via `?bridge=ws://localhost:<cdpPort>/cdp&bridgeToken=<token>` (Electron: `/electron?...&role=leader|follower`); `CDPProxy.swift` echoes `slicc.bridge.v1.<token>` per RFC 6455. [`docs/architecture.md`](../../docs/architecture.md#thin-bridge-architecture).

Both launchers (`ChromeLauncher.buildLaunchArgs` here, node-server's `chrome-launch.ts` — byte-identical) disable Chromium local-network-access checks and every background-throttling feature, so a backgrounded leader is never frozen. Flags/rationale: [`docs/swift-server-details.md`](../../docs/swift-server-details.md#chrome-launch-flags), [`docs/pitfalls.md`](../../docs/pitfalls.md).

The Electron overlay (`ElectronLauncher.swift`) is **thin-bridge only**. Bootstrap `window.__SLICC_ELECTRON_OVERLAY__.inject()` embeds `dist/ui/electron-overlay-entry.js`, built by `@ai-ecoverse/spoon` (`node packages/spoon/build.mjs`); node-server reads the same file. Internals: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

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

`.swiftlint.yml` inherits repo-root via `parent_config` and excludes `.build`; only `error` fails CI. Formatting is `swift format` (Swift 6+) against repo-root `.swift-format` — no per-package copy. Version-sensitive config keys + the multi-line-interpolation footgun: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## Package Layout

- `Sources/Browser/` — Chrome/Electron launchers, console forwarding; `ElectronLauncher.swift` owns launch + `ElectronOverlayInjector`, per-target CDP worker in `OverlayTargetSession.swift`.
- `Sources/CLI/` — `ServerCommand.swift`: entry/bootstrap; mirrors Node runtime flags, launches/attaches to a browser. Root mounts only `ThinBridgeCorsMiddleware`; `--serve-only`/`--electron` mount none (gate `isThinBridgeMode = !serveOnly && !electron`).
- `Sources/Follower/` — headless CDP-over-CDP follower for egress-blocked Electron apps.
- `Sources/Server/` — HTTP routes, thin-bridge CORS, logging, shutdown. `Sources/Signing/` — `SigV4Signer` (mirrors JS signers vs AWS vectors).
- `Sources/WebSocket/` — `CDPProxy.swift` (one browser WebSocket, ordered bounded pump) + `LickSystem.swift` (actor: tracks clients + pending requests; `LickWebSocketRoute` exposes `/licks-ws`; browser messages resolve pending requests or broadcast events). Both install separately from `/api`.

## Electron `--join` — egress decides the attach route

Two routes, chosen by whether the app allows renderer egress:

- **Egress allowed**: the LEADER-role overlay URL carries `tray=<join url>` (the Chrome join path's `?tray=` contract), so the pinned first tab boots as a tray follower. In-app auto-follow tabs carry an explicitly EMPTY `tray=`, blocking the webapp's stored-join-URL fallback at the shared sliccy.ai origin — one app, one follower.
- **Egress blocked** (Signal-class): the app denies all renderer egress at the main process (`net::ERR_ACCESS_DENIED`), so the overlay can never load. `ElectronOverlayEgress.swift` detects it via `Network.loadingFailed` and shows a status-only overlay (mirrors `electron-controller.ts`); with a `--join` tray URL, swift-server instead exposes the app's CDP to the leader via a headless WebRTC tray follower in `Sources/Follower/` (mirrors `electron-tray-follower.ts`/`electron-federated-cdp.ts`).

Full route + follower internals: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## API Routes

`Sources/Server/APIRoutes.swift` — main registry. Handlers mirror `packages/node-server/`; full contracts: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

- `GET /api/status` — `service: "slicc-server"` labels the floatbar `sliccstart` (vs `npx` for Node CLI). `GET /api/agent-activity` — non-OPTIONS `/api/fetch-proxy` within 60 s.
- `GET /api/runtime-config`, `/api/tray-status`, `/auth/callback`, `GET|POST /api/oauth-result`, `GET|POST|DELETE /api/webhooks...` / `/api/crontasks...`. `POST /api/handoff` (`Handoff.swift`) validates payload, broadcasts `navigate_event`.
- Secrets (see Secrets Architecture): `GET|POST /api/secrets`, `GET|POST /api/secrets/session`, `/api/secrets/masked`, `/api/secrets/peek`, `POST /api/secrets/scope`, session-first `DELETE /api/secrets/:name`, `POST /api/secrets/scrub`.
- `POST /api/s3-sign-and-forward`, `/api/da-sign-and-forward` (`SignAndForward.swift`) — S3 creds from Keychain, transient IMS bearer for DA. DA `origin` allow-list `admin.da.live` (default) + `api.aem.live` (Helix 6); keep in lockstep with `@slicc/shared-ts` `DA_ALLOWED_ORIGINS`.
- `POST /api/sudo-approve` (`SudoApprove.swift`) — native `osascript` via `Process`; loopback-only; fail-closed `deny`.
- `ALL /api/fetch-proxy` — HTTP verbs plus WebDAV/CalDAV verbs (`PROPFIND`, `MKCOL`, `REPORT`, `COPY`, `MOVE`, `LOCK`, …); unknown → AsyncHTTPClient via `HTTPMethod.RAW(value:)`.

## Tab Session Restore

Chrome reopens previous session tabs minus the SLICC tab (dead token; `clearChromeSessionRestore` prevents `/cdp` eviction wars). URL-only snapshot in `TabSessionStore.swift` — sanitized on save **and** load (each entry is a Chrome argv slot) — fed by `TabSessionRecorder.swift`, replayed via `ChromeLaunchConfig.restoreUrls`. Not wired for `--serve-only`/`--electron`; no node-server twin. Details: [`docs/sliccstart-browser.md`](../../docs/sliccstart-browser.md).

## Mount table (`--mount`)

Repeatable `--mount <os-path>:<slicc-path>` (`ServerCommand.mount` → `ServerConfig.mounts` via `parseMountMapping`; parity with node-server's `parseMountTableMapping`). `HostFSRoutes.swift` serves mapped folders over `/api/hostfs`, mirroring `hostfs.ts` byte-for-byte. Advertised as `autoMounts` on `GET /api/runtime-config`; the webapp auto-mounts at boot, no picker/permission. Sliccstart feeds the flags from Settings → Mounts (`MountTablePreference`). Route internals (dispatcher, `Range`/cache validators, preflight caps, `HostFSWatch` invalidation): [`docs/swift-server-details.md`](../../docs/swift-server-details.md); setup: [`docs/mounts.md`](../../docs/mounts.md).

## Secrets Architecture

`OAuthSecretStore.swift` handles OAuth replicas (`/api/secrets/oauth-update`, `/api/secrets/oauth/:providerId`); `SessionSecretStore.swift` owns process-memory session records for the session/list/peek/scope/delete APIs. Pipeline `SecretInjector.swift` layers sessions after persisted/env/OAuth data so persisted/OAuth keep masking precedence on name collisions. `PersistedSecretAPIRoutes` (in `APIRoutes.swift`) owns `GET|POST /api/secrets`; the Keychain-backed write mirrors node-server byte-for-byte and refuses an empty `domains` fail-closed. Masks match `@slicc/shared-ts` byte-for-byte (`Tests/CrossImplementationTests.swift`). `SecretStore.swift` reads `ai.sliccy.slicc / __envfile__` at startup via `SecItemCopyMatching`.

Fetch-proxy body handling (`ContentType.swift`, `FormBodyUnmask.swift`) is byte-mirrored from `@slicc/shared-ts`; do **not** re-derive the content-type lists inline. Details + failure modes: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

**Trust model (why the prompt recurs).** The default ACL trusts only the creating binary's cdhash; ad-hoc signatures get a new cdhash every `swift build`, re-raising the "allow access" dialog. Durable fix: `packages/dev-tools/tools/setup-dev-cert.sh` installs a stable, **trusted** code-signing identity (`security add-trusted-cert -p codeSign`, not just imported) so one **"Always Allow"** survives rebuilds. `SLICC_KEYCHAIN_NONINTERACTIVE=1` (dev harness) is an **anti-hang guard only** — headless launches fail fast, continuing **without** Keychain secrets, never silent success. Why + failure modes: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## Graceful Shutdown and Detach

`GracefulShutdown.swift` handles `SIGINT`/`SIGTERM` (full shutdown, `closeBrowser: true`) and `SIGUSR1` (`detach()`, `closeBrowser: false` — HTTP + CDP stop, browser open). Sliccstart uses `detach()` for binary swaps without killing the user's session (`packages/swift-launcher/CLAUDE.md`). A second signal after `detach()` no-ops via `shuttingDown`.

## Related Guides

`packages/node-server/CLAUDE.md` (parallel Node runtime) · `packages/shared-ts/CLAUDE.md` (masking) · `docs/development.md` (run/debug) · `docs/transcript-export.md` (export; swift-server transparent) · [`docs/swift-server-details.md`](../../docs/swift-server-details.md) (extended internals).
