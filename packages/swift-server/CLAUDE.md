# CLAUDE.md

Native macOS server in `packages/swift-server/`.

## Scope

A Hummingbird standalone server: launches Chrome/Electron, proxies CDP, exposes the lick WebSocket/event surface, and owns the `/api` bridge (fetch-proxy, sign-and-forward, OAuth callback, secrets). Serves **no** UI in any mode (like node-server — thin-bridge everywhere): no `--dev`, no bundled `dist/ui`, no `StaticFileMiddleware` / `--static-root`.

## Thin-bridge parity

Swift-server and `packages/node-server/` are byte-for-byte compatible bridges. Chrome/Electron pages load the hosted webapp (`https://www.sliccy.ai`, or `http://localhost:8787` in wrangler dev) with local bridge via `?bridge=ws://localhost:<cdpPort>/cdp&bridgeToken=<token>` (Electron: `/electron?...&role=leader|follower`). `CDPProxy.swift` echoes `slicc.bridge.v1.<token>` per RFC 6455. See [`docs/architecture.md`](../../docs/architecture.md#thin-bridge-architecture).

Both launchers (`ChromeLauncher.buildLaunchArgs` here, node-server's `chrome-launch.ts` — byte-identical) disable Chromium local-network-access checks and every background-throttling feature, so a backgrounded leader is never frozen. Flags/rationale: [`docs/swift-server-details.md`](../../docs/swift-server-details.md#chrome-launch-flags), [`docs/pitfalls.md`](../../docs/pitfalls.md).

The Electron overlay (`ElectronLauncher.swift`) is **thin-bridge only**. Bootstrap `window.__SLICC_ELECTRON_OVERLAY__.inject()` embeds `dist/ui/electron-overlay-entry.js` (in `Contents/Resources/slicc/`), built by `@ai-ecoverse/spoon` (`node packages/spoon/build.mjs`); node-server reads the same file. Internals: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## Build and Test Commands

```bash
cd packages/swift-server
swift build
swift test
swift run slicc-server --help
npm run lint -w @slicc/swift-server   # SwiftLint
```

## Linting & Formatting

`.swiftlint.yml` inherits repo-root via `parent_config` and excludes `.build`; only `error` fails CI. Formatting is `swift format` (Swift 6+) against repo-root `.swift-format` — no per-package copy. Version-sensitive keys + the multi-line-interpolation footgun: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

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
- `Sources/Signing/` — `SigV4Signer` (mirrors JS signers vs AWS vectors). `Sources/WebSocket/` — CDP proxy + lick WS.

## Electron `--join` — egress decides the attach route

Two routes, chosen by whether the app allows renderer egress:

- **Egress allowed**: the LEADER-role overlay URL carries `tray=<join url>` (the Chrome join path's `?tray=` contract), so the pinned first tab boots as a tray follower instead of minting its own. In-app auto-follow tabs carry an explicitly EMPTY `tray=`, blocking the webapp's stored-join-URL fallback at the shared sliccy.ai origin — one app, one follower.
- **Egress blocked** (Signal-class): the app denies **all** renderer egress at the main process (`net::ERR_ACCESS_DENIED`), beneath `Page.setBypassCSP` / CDP Fetch. `ElectronOverlayEgress.swift` detects it via `Network.loadingFailed` on the overlay iframe and shows a **status-only** overlay (mirrors `electron-controller.ts`). When blocked AND a `--join` tray URL is given, swift-server exposes the app's CDP to the leader via a headless WebRTC tray follower in `Sources/Follower/` (`ElectronTrayFollower.swift` + `FederatedCDPServicer.swift`, `stasel/WebRTC` via `swift-trayfollower`; mirrors `electron-tray-follower.ts` / `electron-federated-cdp.ts`).

Full route + follower internals: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## Server Overview

- `CLI/ServerCommand.swift` — entry; mirrors Node runtime flags; launches/attaches to a browser. Root mounts only `ThinBridgeCorsMiddleware` (`shouldMountThinBridgeCors`); `--serve-only` / `--electron` mount none. Gate: `isThinBridgeMode = !serveOnly && !electron`.
- `WebSocket/CDPProxy.swift` — CDP proxy; one browser WebSocket, ordered bounded pump.
- `WebSocket/LickSystem.swift` (actor) — tracks clients + pending requests, lick-event broadcast; `LickWebSocketRoute` exposes `/licks-ws`. Browser messages resolve pending requests or broadcast events.

## API Routes

`Sources/Server/APIRoutes.swift` — main registry. Handlers mirror `packages/node-server/`; full contracts: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

- `GET /api/status` — `service: "slicc-server"` labels the floatbar `sliccstart` (vs `npx` for Node CLI). `GET /api/agent-activity` — non-OPTIONS `/api/fetch-proxy` within 60s.
- `GET /api/runtime-config`, `/api/tray-status`, `/auth/callback`, `GET|POST /api/oauth-result`, `GET|POST|DELETE /api/webhooks...` / `/api/crontasks...`
- `POST /api/handoff` (`Handoff.swift`) — validates payload, broadcasts `navigate_event` on the lick WS.
- Secrets: `GET /api/secrets`, `GET|POST /api/secrets/session`, `/api/secrets/masked`, `/api/secrets/peek`, `POST /api/secrets/scope`, session-first `DELETE /api/secrets/:name`, `POST /api/secrets/scrub`. See below.
- `POST /api/s3-sign-and-forward`, `/api/da-sign-and-forward` (`SignAndForward.swift`) — S3 creds from Keychain, transient IMS bearer for DA. DA `origin` allow-list is `admin.da.live` (default) + `api.aem.live` (Helix 6); keep in lockstep with `@slicc/shared-ts` `DA_ALLOWED_ORIGINS` (#2811).
- `POST /api/sudo-approve` (`SudoApprove.swift`) — native `osascript` via `Process`; loopback-only; fail-closed to `deny`.
- `ALL /api/fetch-proxy` — HTTP verbs plus WebDAV/CalDAV (`PROPFIND`, `MKCOL`, `MKCALENDAR`, `REPORT`, `COPY`, `MOVE`, `LOCK`, …). Unknown → AsyncHTTPClient via `HTTPMethod.RAW(value:)`.

CDP and lick WS routes install separately (see Server Overview).

## Tab Session Restore

Chrome reopens previous session tabs minus the SLICC tab (dead token; `clearChromeSessionRestore` prevents `/cdp` eviction wars). URL-only snapshot in `TabSessionStore.swift` — sanitized on save **and** load (each entry is a Chrome argv slot) — fed by `TabSessionRecorder.swift`, replayed via `ChromeLaunchConfig.restoreUrls`. Not wired for `--serve-only` / `--electron`; no node-server twin. See [`docs/sliccstart-browser.md`](../../docs/sliccstart-browser.md).

## Mount table (`--mount`)

Repeatable `--mount <os-path>:<slicc-path>` (`ServerCommand.mount` → `ServerConfig.mounts`, parsed by `parseMountMapping`; parity with node-server's `parseMountTableMapping`). `HostFSRoutes.swift` serves mapped folders over `/api/hostfs`, mirroring `hostfs.ts` byte-for-byte (routes — including the stable `POST /api/hostfs` dispatcher for list/stat/mkdir/rename/remove — errno JSON, traversal/symlink containment, mount-root delete refusal, 100 MiB body cap, `Range` support on `read` — 206 + `Content-Range`, 416 outside the file, cap applies to the unranged read only; windows stream through a closure-backed `ResponseBody` in `streamChunkBytes` pieces so `bytes=0-` on a huge file never materializes; strong `ETag`/`Last-Modified` from the stat with `If-None-Match`/`If-Modified-Since`/`If-Range` handling, mirroring `cacheValidator` in `hostfs.ts` (#2711)). `BridgeSecurity.preflightMaxAge` mirrors node-server's: `/api/hostfs*` preflights get Chrome's 7200 s cap, the rest 600 s (#2715). Advertised as `autoMounts` on `GET /api/runtime-config`; the webapp auto-mounts at boot, no picker/permission. Sliccstart feeds the flags from Settings → Mounts (`MountTablePreference`). Docs: [`docs/mounts.md`](../../docs/mounts.md#auto-mounted-host-folders-the-mount-table).

`HostFSWatch.swift` owns one FSEventStream and debounce timer per configured mount. Each stream
retains its mount/root identity so overlapping host roots broadcast invalidations to the correct
cache namespace. It emits batched `hostfs_invalidate` events over `/licks-ws`; the webapp bypasses
the opaque HTTP cache, memoizes bodies up to 4 MiB under a stable target + host namespace, and
invalidates matching prefixes. Node parity: `hostfs-watch.ts`.

## Secrets Architecture

`OAuthSecretStore.swift` handles OAuth replicas (`POST /api/secrets/oauth-update`, `DELETE /api/secrets/oauth/:providerId`). `SessionSecretStore.swift` owns process-memory session records for the session/list/peek/scope/delete APIs. Pipeline `SecretInjector.swift` layers sessions after persisted/env/OAuth data without a session collision shadowing those sources (so persisted/OAuth keep masking precedence on name collisions; no persisted `POST /api/secrets` route). Masks match `@slicc/shared-ts` byte-for-byte (`Tests/CrossImplementationTests.swift`). `SecretStore.swift` reads `ai.sliccy.slicc / __envfile__` at startup via `SecItemCopyMatching`.

**Trust model (why the prompt recurs).** The default ACL trusts only the creating binary's cdhash; ad-hoc signatures get a new cdhash every `swift build`, re-raising the "allow access" dialog. Durable fix: `packages/dev-tools/tools/setup-dev-cert.sh` installs a stable code-signing identity so one **"Always Allow"** survives rebuilds — the identity must be **trusted** via `security add-trusted-cert -p codeSign`, not just imported. `SLICC_KEYCHAIN_NONINTERACTIVE=1` (dev harness) is an **anti-hang guard only**: headless launches fail fast rather than hang, continuing **without** Keychain secrets — never silent success. Deep-dive: [`docs/swift-server-details.md`](../../docs/swift-server-details.md).

## Graceful Shutdown and Detach

`GracefulShutdown.swift` handles `SIGINT`/`SIGTERM` (full shutdown, `closeBrowser: true`) and `SIGUSR1` (`detach()`, `closeBrowser: false` — HTTP + CDP stop, browser stays open). Sliccstart uses `detach()` for binary swaps without killing the user's session (see `packages/swift-launcher/CLAUDE.md` "Smooth-Update Modules"). A second signal after `detach()` no-ops via `shuttingDown`.

## Related Guides

- `packages/node-server/CLAUDE.md` — parallel Node runtime · `packages/shared-ts/CLAUDE.md` — masking
- `docs/development.md` — run/debug workflow · `docs/transcript-export.md` — export (webapp; swift-server transparent)
- [`docs/swift-server-details.md`](../../docs/swift-server-details.md) — extended internals
