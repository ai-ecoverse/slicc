# CLAUDE.md

This file covers the native macOS server in `packages/swift-server/`.

## Scope

`packages/swift-server/` is a Hummingbird-based standalone server that launches Chrome/Electron, proxies CDP, exposes the lick WebSocket/event surface, and owns the `/api` bridge surface (fetch-proxy, sign-and-forward, OAuth callback, secrets). In thin-bridge mode — the default, matching node-server (see below) — it serves **no** UI: the launched Chrome loads the hosted webapp. Only the legacy `--dev` / `--serve-only` / `--electron` modes mount the bundled `dist/ui` static serving.

## Thin-bridge parity

Swift-server and `packages/node-server/` are byte-for-byte compatible bridges. With the breaking thin-extension release the launched Chrome/Electron pages load the hosted webapp from `https://www.sliccy.ai` (or `http://localhost:8787` for the wrangler dev harness) with the local bridge attached via `?bridge=ws://localhost:<cdpPort>/cdp&bridgeToken=<token>` (or `/electron?...&role=leader|follower` for Electron pages). `CDPProxy.swift` echoes the `slicc.bridge.v1.<token>` Sec-WebSocket-Protocol per RFC 6455, matching node-server's `Sec-WebSocket-Protocol` handling — the webapp's `CDPClient` uses the same subprotocol regardless of bridge implementation. See [`docs/architecture.md` §Thin-Bridge Architecture](../../docs/architecture.md#thin-bridge-architecture) for the cross-bridge contract.

## Build and Test Commands

```bash
cd packages/swift-server
swift build
swift test
swift run slicc-server --help
npm run lint -w @slicc/swift-server   # SwiftLint
```

## Linting

`packages/swift-server/.swiftlint.yml` inherits the shared rule set from the
repo-root `.swiftlint.yml` (via `parent_config`) and excludes this package's
`.build`. Warnings surface code-quality issues; only `error`-severity violations
fail CI. Run `npm run lint:fix -w @slicc/swift-server` to auto-correct fixable
violations.

## Main Package Layout

- `Sources/Browser/` — Chrome and Electron launchers plus console forwarding
- `Sources/CLI/` — `ServerCommand` argument parsing and runtime bootstrap
- `Sources/Server/` — HTTP routes, static file middleware, request logging, shutdown
- `Sources/Signing/` — `SigV4Signer` (mirrors the JS signers in webapp + node-server byte-for-byte against AWS canonical test vectors)
- `Sources/WebSocket/` — CDP proxy and lick WebSocket system
- `Tests/` — package tests

## Server Overview

- `CLI/ServerCommand.swift` is the entry point and mirrors the major Node runtime flags.
- The server resolves ports and launches or attaches to a browser target. In thin-bridge mode (the default) it mounts `ThinBridgeCorsMiddleware` and serves no UI; only the legacy non-thin modes (`--dev` / `--serve-only` / `--electron`) mount `StaticFileMiddleware` to serve `dist/ui`. Mirrors node-server's `THIN_BRIDGE_MODE` gate — see `ServerCommand.isThinBridgeMode` (`!dev && !serveOnly && !electron`).
- `WebSocket/CDPProxy.swift` exposes the CDP proxy to browser clients.
- `WebSocket/LickSystem.swift` keeps a set of connected browser clients, sends request/response messages, and broadcasts lick events.
- `CDPProxy` keeps a single browser WebSocket open and forwards inbound Chrome frames through an ordered, bounded async message pump to avoid per-frame task churn and unbounded buffering.

## API Routes

`Sources/Server/APIRoutes.swift` is the main route registry. Important routes include:

- `GET /api/status` — health doc mirroring the Node server's; `service: "slicc-server"` is the float fingerprint the UI uses to label the floatbar `sliccstart` (vs `npx` for the Node CLI)
- `GET /api/runtime-config`
- `GET /api/tray-status`
- `GET|POST|DELETE /api/webhooks...`
- `GET|POST|DELETE /api/crontasks...`
- `GET /auth/callback`
- `GET|POST /api/oauth-result`
- `GET /api/secrets`, `GET /api/secrets/masked`
- `POST /api/s3-sign-and-forward`, `POST /api/da-sign-and-forward` — server-side request signing for S3 and Adobe da.live mounts. Mirrors `packages/node-server/src/secrets/sign-and-forward.ts`; resolves S3 credentials from the Keychain (`SecretStore`) and accepts a transient IMS bearer for DA. See `Sources/Server/SignAndForward.swift`.
- `POST /api/sudo-approve` — native sudo approval for the in-browser broker. Mirrors `packages/node-server/src/sudo/` (`endpoint.ts` + `dialog-backends.ts`): validates a `{ kind, detail, suggestedPattern? }` envelope (invalid → 400) and raises the same native `osascript` dialog by shelling out via `Process`. Loopback-only by construction; fail-closed to `{ decision: "deny" }` on any error. See `Sources/Server/SudoApprove.swift`.
- `ALL /api/fetch-proxy` — accepts standard verbs (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`) plus the WebDAV (RFC 4918) and CalDAV (RFC 4791) verbs `PROPFIND`, `PROPPATCH`, `MKCOL`, `MKCALENDAR`, `REPORT`, `COPY`, `MOVE`, `LOCK`, `UNLOCK`. Unknown verbs are forwarded to AsyncHTTPClient via `HTTPMethod.RAW(value:)`.

WebSocket routes are installed separately for CDP proxying and the lick system.

## Static File Serving

- **Thin-bridge mode (the default) serves no static UI** — the launched Chrome loads the hosted webapp from `https://www.sliccy.ai` (or `http://localhost:8787` in the wrangler dev harness). `StaticFileMiddleware` is mounted **only** in the legacy `--dev` / `--serve-only` / `--electron` modes (the `else` branch of the `thinBridgeMode` check in `ServerCommand.swift`), mirroring node-server skipping `attachUiServing` when `THIN_BRIDGE_MODE` is set.
- When static serving IS active (non-thin modes), assets are served from `dist/ui`; keep the web build output in sync before debugging server-side serving behavior.

## Lick / WebSocket System

- `LickSystem` is an actor that tracks connected browser clients and pending requests.
- `LickWebSocketRoute` exposes the `/licks-ws` endpoint.
- Browser-originated messages resolve pending requests or broadcast events back into the runtime.

## Secrets Architecture

Swift-server includes `OAuthSecretStore.swift` for OAuth token replicas plus matching `POST /api/secrets/oauth-update` and `DELETE /api/secrets/oauth/:providerId` endpoints in `Sources/Server/APIRoutes.swift`. The Swift port of the secrets pipeline lives in `Sources/Keychain/SecretInjector.swift` (Basic-auth-aware unmask, URL-credential extraction, byte-safe body unmask, the OAuth replica chain, and sessionId persistence). Mask outputs match `@slicc/shared-ts`'s TS implementation byte-for-byte via `Tests/CrossImplementationTests.swift` (pinned against `packages/shared-ts/tests/cross-impl-vectors.test.ts`).

`SecretStore.swift` reads the single `ai.sliccy.slicc / __envfile__` Keychain blob synchronously at startup (before the port binds) via one `SecItemCopyMatching` in `readBlob()`.

**Trust model (why the prompt recurs).** That single item was created with the default trusted-application ACL, which trusts ONLY the creating binary identified by its code-signing cdhash. An ad-hoc signature gets a NEW cdhash on every `swift build`, so each rebuilt `slicc-server` is a different, untrusted binary and macOS re-raises the "allow access" ACL dialog. The **durable fix** is a stable code-signing identity (`packages/dev-tools/tools/setup-dev-cert.sh`): a constant Designated Requirement means a single interactive **"Always Allow"** grant survives every rebuild. The `unsigned:` partition-list token is **not** a reliable grant for per-rebuild ad-hoc binaries — do not rely on it. **The identity must be TRUSTED, not just imported.** A self-signed cert imports as `CSSMERR_TP_NOT_TRUSTED`, so `security find-identity -v -p codesigning` (the valid-only form both `setup-dev-cert.sh` and `dev-swift-fresh.sh` use to detect it) lists nothing and the harness silently falls back to ad-hoc signing — leaving `/api/secrets/masked` empty. `setup-dev-cert.sh` therefore runs `security add-trusted-cert -p codeSign` in the user trust domain (no `sudo`/`-d`, applied non-interactively) after import, and de-duplicates any pre-existing copies by SHA-1 hash first (a CN is "ambiguous" once stacked) so exactly one valid identity remains.

`SLICC_KEYCHAIN_NONINTERACTIVE=1` (the dev fresh-bridge harness sets it) is **only an anti-hang guard**, not a fix for the prompt: it makes `readBlob` pass `kSecUseAuthenticationUIFail` so a headless launch that would otherwise block on the unanswerable dialog fails fast with `errSecInteractionNotAllowed` instead of hanging. An already-granted item still reads fine; otherwise the read path logs an actionable hint and the server continues **without** Keychain secrets. It never produces silent success.

## Graceful Shutdown and Detach

- `Sources/Server/GracefulShutdown.swift` registers handlers for `SIGINT`, `SIGTERM`, and `SIGUSR1`.
- `SIGINT` / `SIGTERM` run the full shutdown sequence with `closeBrowser: true` — the browser/Electron session is torn down.
- `SIGUSR1` calls `detach()`, which runs the same sequence with `closeBrowser: false`. The HTTP listener and CDP proxy stop, but the launched browser stays open. Sliccstart uses this to swap binaries without killing the user's session; see `packages/swift-launcher/CLAUDE.md` ("Smooth-Update Modules") for the launcher-side reattach flow.
- A second signal after `detach()` is a no-op, guarded by the private `GracefulShutdownHandler.shuttingDown` latch.

## Related Guides

- `packages/node-server/CLAUDE.md` for the parallel Node runtime
- `packages/shared-ts/CLAUDE.md` for secret masking primitives
- `docs/development.md` for broader run/debug workflow guidance
