# CLAUDE.md

Native macOS server in `packages/swift-server/`.

## Scope

A Hummingbird standalone server: launches Chrome/Electron, proxies CDP, exposes the lick WebSocket/event surface, and owns the `/api` bridge (fetch-proxy, sign-and-forward, OAuth callback, secrets). Serves **no** UI in any mode (matching node-server — thin-bridge in **every** mode): no `--dev` flag, no bundled `dist/ui`, no `StaticFileMiddleware` / `--static-root`.

## Thin-bridge parity

Swift-server and `packages/node-server/` are byte-for-byte compatible bridges. Chrome/Electron pages load the hosted webapp (`https://www.sliccy.ai` or `http://localhost:8787` in wrangler dev) with local bridge via `?bridge=ws://localhost:<cdpPort>/cdp&bridgeToken=<token>` (Electron: `/electron?...&role=leader|follower`). `CDPProxy.swift` echoes `slicc.bridge.v1.<token>` per RFC 6455. See [`docs/architecture.md`](../../docs/architecture.md#thin-bridge-architecture).

Both launchers (`ChromeLauncher.buildLaunchArgs` here, node-server's `chrome-launch.ts` — kept byte-identical) disable Chromium local-network-access checks and every background-throttling feature, so a backgrounded leader is never frozen. Flag list and rationale: [`docs/swift-server-details.md`](../../docs/swift-server-details.md#chrome-launch-flags), [`docs/pitfalls.md`](../../docs/pitfalls.md).

The Electron overlay (`Sources/Browser/ElectronLauncher.swift`) is **thin-bridge only** (legacy Path A bundled overlay retired). Bootstrap `window.__SLICC_ELECTRON_OVERLAY__.inject()` embeds from `dist/ui/electron-overlay-entry.js` (in `Contents/Resources/slicc/`), built by `@ai-ecoverse/spoon` (`node packages/spoon/build.mjs`); node-server reads the same file. Internals: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## Build and Test Commands

```bash
cd packages/swift-server
swift build
swift test
swift run slicc-server --help
npm run lint -w @slicc/swift-server   # SwiftLint
```

## Linting & Formatting

`.swiftlint.yml` inherits repo-root via `parent_config` and excludes `.build`; only `error` fails CI. Formatting is `swift format` (Swift 6+) against repo-root `.swift-format` — no per-package copy.

Version-sensitive keys and the multi-line-interpolation footgun: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

```bash
npm run lint:fix -w @slicc/swift-server      # swiftlint --fix
npm run lint:format -w @slicc/swift-server   # swift format lint --strict (CI gate)
npm run format -w @slicc/swift-server        # swift format --in-place
```

## Main Package Layout

- `Sources/Browser/` — Chrome/Electron launchers, console forwarding; `ElectronLauncher.swift` owns launch + `ElectronOverlayInjector`, per-target CDP worker in `OverlayTargetSession.swift`.
- `Sources/CLI/` — `ServerCommand` arg parsing / bootstrap.
- `Sources/Follower/` — headless CDP-over-CDP follower for egress-blocked Electron apps.
- `Sources/Server/` — HTTP routes, thin-bridge CORS, logging, shutdown.
- `Sources/Signing/` — `SigV4Signer` (mirrors JS signers byte-for-byte vs AWS canonical vectors).
- `Sources/WebSocket/` — CDP proxy and lick WebSocket.

## Electron `--join` — egress decides the attach route

Egress-allowed apps: the LEADER-role overlay URL carries `tray=<join url>` (Chrome's `?tray=` contract) so the pinned first tab boots as a tray follower. In-app auto-follow tabs get an empty `tray=`, blocking the stored-join-URL fallback — one app, one follower.

Egress-blocked apps (Signal): renderer egress is denied at the main process (`net::ERR_ACCESS_DENIED`), beneath CSP bypass / CDP Fetch. `ElectronOverlayEgress.swift` detects `Network.loadingFailed` on the overlay iframe and shows a **status-only** overlay (mirrors node-server `electron-controller.ts`). With `--join`, a headless WebRTC tray follower (`Sources/Follower/`) exposes the app's CDP: `ElectronTrayFollower.swift` routes `tray-control`; `FederatedCDPServicer.swift` speaks raw browser CDP. Mirrors `electron-tray-follower.ts` / `electron-federated-cdp.ts`; Swift uses `stasel/WebRTC` via `packages/swift-trayfollower`.

## Server Overview

- `CLI/ServerCommand.swift` — entry; mirrors Node runtime flags; launches/attaches to a browser. Root mounts only `ThinBridgeCorsMiddleware` (`shouldMountThinBridgeCors`); `--serve-only` / `--electron` mount none. Gate: `isThinBridgeMode = !serveOnly && !electron`.
- `WebSocket/CDPProxy.swift` — CDP proxy; one browser WebSocket, ordered bounded async pump.
- `WebSocket/LickSystem.swift` — tracks clients, request/response, lick-event broadcast.

## API Routes

`Sources/Server/APIRoutes.swift` — main registry. Handlers mirror `packages/node-server/`; full contracts: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

- `GET /api/status` — `service: "slicc-server"` labels the floatbar `sliccstart` (vs `npx` for Node CLI).
- `GET /api/agent-activity` — non-OPTIONS `/api/fetch-proxy` within the 60s window.
- `GET /api/runtime-config`, `/api/tray-status`, `/auth/callback`, `GET|POST /api/oauth-result`, `GET|POST|DELETE /api/webhooks...`, `/api/crontasks...`
- `POST /api/handoff` (`Sources/Server/Handoff.swift`) — validates payload, broadcasts `navigate_event` on lick WebSocket.
- `GET /api/secrets`, `GET|POST /api/secrets/session`, `/api/secrets/masked`, `/api/secrets/peek`, `POST /api/secrets/scope`, session-first `DELETE /api/secrets/:name`. Session records are process-memory only; persisted/OAuth records keep masking precedence on name collisions.
- `POST /api/secrets/scrub` (`SecretInjector.scrub(text:)`). No persisted `POST /api/secrets`.
- `POST /api/s3-sign-and-forward`, `/api/da-sign-and-forward` — Keychain S3 creds; transient IMS bearer for DA.
- `POST /api/sudo-approve` — loopback-only `osascript`; fail-closed `{ decision: "deny" }`.
- `ALL /api/fetch-proxy` — HTTP + WebDAV/CalDAV; unknown verbs → `HTTPMethod.RAW`.

WebSocket routes for CDP and lick install separately (`/licks-ws`).

## Tab Session Restore

Chrome reopens previous session tabs minus the SLICC tab (dead token; `clearChromeSessionRestore` prevents `/cdp` eviction wars). URL-only snapshot in `Sources/Browser/TabSessionStore.swift` — sanitized on save **and** load (each entry is a Chrome argv slot) — fed by `TabSessionRecorder.swift`, replayed via `ChromeLaunchConfig.restoreUrls`. Not wired for `--serve-only` / `--electron`; no node-server equivalent. See [`docs/sliccstart-browser.md`](../../docs/sliccstart-browser.md).

## Mount table (`--mount`)

Repeatable `--mount <os-path>:<slicc-path>` (`ServerCommand.mount` → `ServerConfig.mounts`, parsed by `ServerConfig.parseMountMapping`; parity with node-server's `parseMountTableMapping`). `Sources/Server/HostFSRoutes.swift` serves the mapped folders over `/api/hostfs`, mirroring node-server's `hostfs.ts` byte-for-byte (routes, `{ code, message }` errno JSON, traversal/symlink containment, mount-root delete refusal, 100 MiB body cap). Advertised as `autoMounts` (`{ path, hostPath }[]`) on `GET /api/runtime-config`; the webapp auto-mounts at boot, no picker/permission. Sliccstart feeds the flags from Settings → Mounts (`MountTablePreference`). Docs: [`docs/mounts.md`](../../docs/mounts.md#auto-mounted-host-folders-the-mount-table).

## Secrets Architecture

`OAuthSecretStore.swift` handles OAuth replicas via `POST /api/secrets/oauth-update` and `DELETE /api/secrets/oauth/:providerId`. `SessionSecretStore.swift` owns process-memory session records for the session/list/peek/scope/delete APIs. Pipeline `Sources/Keychain/SecretInjector.swift` layers sessions after persisted/env/OAuth data without letting a session collision shadow those sources. Masks match `@slicc/shared-ts` byte-for-byte via `Tests/CrossImplementationTests.swift`. `SecretStore.swift` reads `ai.sliccy.slicc / __envfile__` at startup via `SecItemCopyMatching`.

**Trust model (why the prompt recurs).** The default ACL trusts only the creating binary's cdhash; ad-hoc signatures get a new cdhash every `swift build`, re-raising the "allow access" dialog. Durable fix: `packages/dev-tools/tools/setup-dev-cert.sh` installs a stable code-signing identity so one **"Always Allow"** survives rebuilds — the identity must be **trusted** via `security add-trusted-cert -p codeSign`, not just imported. Deep-dive: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

`SLICC_KEYCHAIN_NONINTERACTIVE=1` (dev harness) is an **anti-hang guard only**: `readBlob` passes `kSecUseAuthenticationUIFail`, so headless launches fail fast with `errSecInteractionNotAllowed` instead of hanging. Already-granted items read; otherwise continues **without** Keychain secrets — never silent success.

## Graceful Shutdown and Detach

`Sources/Server/GracefulShutdown.swift` handles `SIGINT`/`SIGTERM` (full shutdown, `closeBrowser: true`) and `SIGUSR1` (`detach()`, `closeBrowser: false` — HTTP + CDP stop, browser stays open). Sliccstart uses `detach()` for binary swaps without killing the user's session (see `packages/swift-launcher/CLAUDE.md` "Smooth-Update Modules"). A second signal after `detach()` no-ops via `shuttingDown`.

## Related Guides

- `packages/node-server/CLAUDE.md` — parallel Node runtime
- `packages/shared-ts/CLAUDE.md` — masking primitives
- `docs/development.md` — run/debug workflow
- `docs/transcript-export.md` — transcript export (webapp; swift-server transparent)
- [`docs/swift-server-details.md`](../../docs/swift-server-details.md) — extended internals
