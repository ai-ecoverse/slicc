# CLAUDE.md

Node.js CLI/Electron float. `src/` launches Chrome or Electron and runs the thin `/cdp` bridge + `/api` surface — the standalone runtime for `npm run dev` and packaged releases. Serves no UI; the webapp always loads from the hosted origin.

## Main Commands

```bash
npm run dev
npm run dev:electron -- /Applications/Slack.app
npm run build
npm run package:release
```

## Runtime Modes

- **Standalone CLI**: thin-bridge only — the webapp loads from the hosted origin (`https://www.sliccy.ai`, or `--lead`/`WORKER_BASE_URL` for a local `:8787` wrangler); launched Chrome opens it with `?bridge=ws://localhost:<servePort>/cdp&bridgeToken=<token>`. node-server owns only CDP, fetch-proxy, sign-and-forward, the OAuth callback. No Vite-HMR; for local UI work run `dev:standalone:fresh` — **rebuild `@slicc/webapp` + `@slicc/node-server` first** or Chrome loads stale.
- **Serve-only**: reuses a running CDP target. Honors `--cdp-port` — the fake-LLM E2E harness, the `readCdpPageState` probe, and Playwright's `--remote-debugging-port` must share one agreed port.
- **Electron mode**: launches or attaches to an Electron app. Launched pages get `/electron?bridge=…&role=leader|follower` so the hosted webapp drives every page over the local bridge; no bundled overlay shell. On `--join`, the LEADER URL carries `tray=<join url>` so an egress-allowed app attaches as ONE tray follower (without it the overlay mints a second leader); auto-follow tabs and no-join leaders carry an explicitly EMPTY `tray=` to block the stored-join-URL fallback. Egress-blocked apps (Signal) use the headless WebRTC follower. [`docs/electron.md`](../../docs/electron.md).
- **Hosted mode (`--hosted`)**: bundled with the e2b template (`packages/dev-tools/e2b-template/`). Boots headless Chromium against `?runtime=hosted-leader`, persists `--user-data-dir=/data/profile`, exposes `/api/cloud-status` + `/api/leader-restart`, reads `SLICC_TRAY_WORKER_BASE_URL`.
- **Cloud subcommands (`--cloud start/list/pause/resume/kill`)**: laptop-side orchestration over an e2b sandbox, mutually exclusive with `--hosted`. Lifecycle lives in `@slicc/cloud-core`; `src/cloud/` are thin adapters over the file-backed registry (`~/.slicc/cloud-sessions.json`) + e2b substrate (`dispatch.ts` parses argv; each `<op>.ts` is 1:1 with `cloud-core/src/operations/`). See [`cloud-core/CLAUDE.md`](../cloud-core/CLAUDE.md).
- **CLI installer (`--install-cli`)**: downloads the released Go `slicc` follower binary (`packages/slicc-cli`) and exits — no server boots. `src/install-cli.ts` uses `scanGithubReleases` (`@slicc/shared-ts`) to walk releases newest→oldest for the first `slicc-<os>-<arch>` asset (attached only when `packages/slicc-cli` changed), installing to an OS-idiomatic dir or `--install-dir`.
- **Computer demo (`--computer-demo`)**: mounts `GET /computer`, `/computer/screenshot`, `/computer/text`, `POST /computer/input`, optional `WS /computer/frames` on the bridge port so `computer add url http://127.0.0.1:5710` has an in-tree remote. `src/computer-demo.ts` (services layer; `runtime-flags.ts` holds the boolean).

## `--prompt` & flags

`src/runtime-flags.ts` is the source of truth for flags (`--serve-only`, `--cdp-port`, `--electron`, `--profile`, `--lead`, `--join`, `--prompt`, `--computer-demo`, …). `--prompt` auto-submits when the UI loads — quickest smoke-test is `npm run dev -- --prompt "ls /workspace"`.

## Mount table (`--mount`)

Repeatable `--mount=<os-path>:<slicc-path>` (`runtime-flags.ts` → `mounts`, `parseMountTableMapping`: last-colon split, `~` expansion, dedup by target). `src/hostfs.ts` serves the folders over `/api/hostfs`; the webapp auto-mounts them via `HostFsMountBackend` as soon as the shared filesystem exists, before scoop restore (advertised as `autoMounts` on `GET /api/runtime-config`) — no picker, no Chrome permission; a picker mount already on a table target is replaced. Other picker mounts are unaffected. Swift parity: `HostFSRoutes.swift` / `HostFSWatch.swift`. The **full wire contract** (stats, ranged/streamed reads, conditional requests, errno codes, preflight + cache coherence) is [`docs/mounts.md`](../../docs/mounts.md#auto-mounted-host-folders-the-mount-table) — read before touching `hostfs.ts`. Wiring:

- Every `/api/hostfs` error MUST carry an errno `code` (a code-less 404 is how the webapp detects an old bridge and downgrades). The stable `POST /api/hostfs` dispatcher is excluded from the global 50 MiB `express.json()` via `shouldParseGlobalJson` in **`fetch-proxy-headers.ts`** (outside `index.ts` so tests import it without booting the server); its bounded 1 MiB parser + `hostFsBodyErrorHandler` map to 400 `EINVAL` / 413 `EFBIG`. `HOSTFS_MAX_BODY_BYTES` guards only the unranged read; `preflightMaxAge()` (`bridge-security.ts`) caps `/api/hostfs*` preflights at 7200 s.
- `src/hostfs-watch.ts` watches each mount recursively, debounces, broadcasts batched `hostfs_invalidate` over `/licks-ws`; unattributable events clear it.

## Bridge keep-alive

`src/http-keepalive.ts` → `applyBridgeKeepAlive(server)` (in `index.ts` before `listen()`) raises `keepAliveTimeout` to 120 s, `headersTimeout` to 130 s. Node's 5 s default loses a request whenever the browser reuses a socket the server is closing — a `/api/hostfs` fan-out hits this regularly. Swift no-op (Hummingbird `idleTimeout` defaults `nil`). Both halves + the hostfs cache-coherence trap: [`docs/pitfalls.md`](../../docs/pitfalls.md).

## Ports & Parallel Instances

Defaults: `5710` bridge + `/api` (`PORT` overrides), `9222` Chrome CDP, `9223` Electron attach CDP. Runtime auto-resolves conflicts; `PORT=5720 npm run dev` runs a parallel instance with its own profile + CDP port.

## Electron Notes

- `dev:electron` runs the Node server in Electron attach mode; if an app blocks remote debugging the runtime fails early rather than pretend attach succeeded.
- Thin-bridge is the only overlay path; the CSP-strip escalation re-issues intercepted **document** requests through Node (Swift twin `OverlayPostBody.swift`); `electron-controller.ts` / `electron-runtime.ts` / `electron-main.ts` own launch + leader/follower minting. Full internals: [`docs/electron.md`](../../docs/electron.md#node-server-internals).

## CDP proxy: Chrome-leg drops

Chrome's browser-level socket can drop on its own (`messageTooLarge`, inbound-queue overflow), discarding EVERY session behind it. `src/cdp-proxy/chrome-reconnect.ts` re-dials and buffers Client→Chrome frames (`client-frame-buffer.ts`) at parity with swift-server's `CDPProxy` — keep both identical. Close codes (`close-codes.ts`) MUST match `packages/webapp/src/cdp/cdp-client.ts`: 4002 (`CDP_UPSTREAM_RESET_CLOSE_CODE`, non-latching "reset and re-dial") vs 4001 (superseded). Full policy: `docs/pitfalls.md`.

## Layer stack

Import direction is `transport → services → entry`, enforced by `npm run lint:layer-back-edges` (`layer-back-edge-baseline-node-server.json`). Transport: `cdp-proxy/`, `bridge-security.ts`, `fetch-proxy-gzip.ts`, `http-keepalive.ts`, `links-middleware.ts`, `runtime-flags.ts`, `cli-log-dedup.ts`. `index.ts` and `*-main.ts` are composition roots; imports must point down.

## Main Files

- `src/index.ts` — entry point, server boot, Chrome/Electron launch, CDP WebSocket proxy
- `src/cdp-proxy/` — secret unmask gate, session→URL tracker, Chrome-leg reconnect + close codes
- `src/browser-shutdown.ts` — graceful close; confirms via CDP polling not the launcher exit event, since on macOS Chrome launches through `/usr/bin/open` (`planChromeSpawn`) so the handle is `open`, not Chrome
- `src/chrome-launch.ts` — Chrome executable/profile/launch args. `buildChromeLaunchArgs` disables Local Network Access checks (`--disable-features=LocalNetworkAccessChecks,…`) on **every** launch — the hosted UI → local bridge hop is public→local, which Chromium 142+ gates behind a prompt. Synced with swift-server.
- `src/qa-setup.ts` — QA profile scaffolding · `src/release-package.ts` — packaging

## API Routes

- `ALL /api/fetch-proxy` — forwards browser requests across origins, injects masked secrets, records agent activity. Does **not** force `accept-encoding: identity` (undici negotiates gzip/br); `fetch-proxy-gzip.ts` sniffs gzip magic to inflate undeclared cached gzip and strips `content-encoding` (the browser hop is a synthetic SW `Response` that doesn't inflate). `docs/pitfalls.md`.
- `GET /api/agent-activity` — `{ activeInLastMinute }` over non-OPTIONS `/api/fetch-proxy` traffic in a fixed 60 s window.

## Secrets Architecture

`OauthSecretStore` (in-memory OAuth token replicas) backs `POST /api/secrets/oauth-update` and `DELETE /api/secrets/oauth/:providerId`. The sessionId persists to `~/.slicc/session-id` (or `<env-file-dir>/session-id` under `--env-file`). Masking primitives (`masking.ts`, `domain-match.ts`) are in `@slicc/shared-ts`.

## Related Guides

- Packages: `webapp` (served browser code), `chrome-extension`, `cloud-core` (`--cloud` lifecycle), `shared-ts` (masking primitives).
- Docs: `docs/development.md` + `docs/electron.md` (workflows) · `docs/mounts.md` (`/api/hostfs` wire contract) · `docs/pitfalls.md` (CDP-leg drops, keep-alive, CSP-strip hop, Local Network Access) · `docs/transcript-export.md` (export bundle).

The `node-server` coverage gate measures only `packages/node-server`; `@slicc/shared-ts` is owned by the separate `shared` gate. Keep that boundary explicit in `coverage-thresholds.json` so a shared barrel export cannot silently lower node-server coverage.
