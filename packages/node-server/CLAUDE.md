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

- **Standalone CLI**: thin-bridge only — the webapp loads from the hosted origin (`https://www.sliccy.ai`, or `--lead`/`WORKER_BASE_URL` for a local `:8787` wrangler); launched Chrome opens it with `?bridge=ws://localhost:<servePort>/cdp&bridgeToken=<token>`. No Vite-HMR; local UI work needs `dev:standalone:fresh` — **rebuild `@slicc/webapp` + `@slicc/node-server` first** or Chrome loads stale assets.
- **Serve-only**: reuses a running CDP target. Honors `--cdp-port` — the fake-LLM E2E harness, `readCdpPageState` probe, and Playwright's `--remote-debugging-port` share one port.
- **Electron mode**: launches or attaches to an Electron app. Launched pages get `/electron?bridge=…&role=leader|follower` so the hosted webapp drives every page over the local bridge; no bundled overlay shell. `--join` sets `tray=<join url>` on the LEADER so an egress-allowed app attaches as ONE tray follower; auto-follow tabs/no-join leaders carry an EMPTY `tray=` to block the stored-join fallback (which would mint a second leader). Egress-blocked apps (Signal) use the headless WebRTC follower. [`docs/electron.md`](../../docs/electron.md).
- **Hosted mode (`--hosted`)**: bundled with the e2b template (`packages/dev-tools/e2b-template/`). Boots headless Chromium against `?runtime=hosted-leader`, persists `--user-data-dir=/data/profile`, exposes `/api/cloud-status` + `/api/leader-restart`, reads `SLICC_TRAY_WORKER_BASE_URL`. `POST /api/cloud-status` writes `SLICC_JOIN_FILE` (or `/tmp/slicc-join.json` when unset; multiple leaders each write their own). `hosted-page-watchdog.ts` reloads the launch URL when a warm page never dials `/cdp`. GPU: hosted Chrome gets `--disable-gpu` unless `SLICC_CHROME_GPU=1` passes WebGPU/Vulkan flags ending `--disable-vulkan-surface` — required, else headless Vulkan init fails and WebGPU falls back to CPU SwiftShader. Set only on Vulkan-capable GPU hosts; standalone/Electron add none.
- **Cloud subcommands (`--cloud start/list/pause/resume/kill`)**: laptop-side orchestration over an e2b sandbox, mutually exclusive with `--hosted`. Lifecycle lives in `@slicc/cloud-core`; `src/cloud/` are thin adapters over the file-backed registry (`~/.slicc/cloud-sessions.json`) + e2b substrate (`dispatch.ts` parses argv; each `<op>.ts` is 1:1 with `cloud-core/src/operations/`). [`cloud-core/CLAUDE.md`](../cloud-core/CLAUDE.md).
- **CLI installer (`--install-cli`)**: downloads the released Go `slicc` follower binary (`packages/slicc-cli`) and exits — no server boots. `src/install-cli.ts` walks releases newest→oldest (`scanGithubReleases`, `@slicc/shared-ts`) for the first `slicc-<os>-<arch>` asset, installing to an OS dir or `--install-dir`.
- **Computer demo (`--computer-demo`)**: mounts the `/computer` routes (screenshot/text/input, optional `WS /frames`) on the bridge port so `computer add url http://127.0.0.1:5710` has an in-tree remote. `src/computer-demo.ts`.

## Flags

`src/runtime-flags.ts` is the source of truth for all flags (`--serve-only`, `--cdp-port`, `--electron`, `--profile`, `--lead`, `--join`, `--prompt`, `--computer-demo`, …). `--prompt` auto-submits on UI load — smoke-test: `npm run dev -- --prompt "ls /workspace"`.

## Mount table (`--mount`)

Repeatable `--mount=<os-path>:<slicc-path>` (`runtime-flags.ts` → `mounts`, `parseMountTableMapping`: last-colon split, `~` expansion, dedup). `src/hostfs.ts` serves them over `/api/hostfs`; the webapp auto-mounts via `HostFsMountBackend` before scoop restore (advertised as `autoMounts` on `GET /api/runtime-config`), no picker or Chrome permission. Swift parity: `HostFSRoutes.swift` / `HostFSWatch.swift`. **Full wire contract** (stats, ranged/streamed reads, conditional requests, errno codes, preflight + cache coherence): [`docs/mounts.md`](../../docs/mounts.md#auto-mounted-host-folders-the-mount-table) — read before touching `hostfs.ts`. Load-bearing gotchas:

- Every `/api/hostfs` error MUST carry an errno `code` (a code-less 404 is how the webapp detects an old bridge and downgrades). The `POST /api/hostfs` dispatcher is excluded from the global 50 MiB `express.json()` via `shouldParseGlobalJson` in **`fetch-proxy-headers.ts`** (kept outside `index.ts` so tests import it without booting the server); its 1 MiB parser + `hostFsBodyErrorHandler` map to 400 `EINVAL` / 413 `EFBIG`. `preflightMaxAge()` caps `/api/hostfs*` preflights at 7200 s.
- `src/hostfs-watch.ts` watches each mount recursively, debounces, broadcasts batched `hostfs_invalidate` over `/licks-ws`; unattributable events clear it.

## Bridge keep-alive

`src/http-keepalive.ts` → `applyBridgeKeepAlive(server)` (in `index.ts` before `listen()`) raises `keepAliveTimeout` to 120 s, `headersTimeout` to 130 s. Node's 5 s default loses a request whenever the browser reuses a socket the server is closing — `/api/hostfs` fan-outs hit this. Swift no-op (Hummingbird `idleTimeout` defaults `nil`). [`docs/pitfalls.md`](../../docs/pitfalls.md).

## Ports

Defaults: `5710` bridge + `/api` (`PORT` overrides), `9222` Chrome CDP, `9223` Electron attach CDP. Runtime auto-resolves conflicts; `PORT=` runs parallel instances with isolated profiles + CDP ports.

## Electron Notes

`dev:electron` attaches to an Electron app; if one blocks remote debugging the runtime fails early rather than pretend attach succeeded. Thin-bridge is the only overlay path; the CSP-strip escalation re-issues intercepted **document** requests through Node (Swift twin `OverlayPostBody.swift`); `electron-{controller,runtime,main}.ts` own launch + leader/follower minting. Internals: [`docs/electron.md`](../../docs/electron.md#node-server-internals).

## CDP proxy: Chrome-leg drops

Chrome's browser-level socket can drop on its own (`messageTooLarge`, queue overflow), discarding EVERY session behind it. `src/cdp-proxy/chrome-reconnect.ts` re-dials and buffers Client→Chrome frames (`client-frame-buffer.ts`) at parity with swift-server's `CDPProxy` — keep both identical. Close codes (`close-codes.ts`) MUST match webapp `src/cdp/cdp-client.ts`: 4002 (`CDP_UPSTREAM_RESET_CLOSE_CODE`, non-latching reset/re-dial) vs 4001 (superseded). `docs/pitfalls.md`.

## Layer stack

Import direction is `transport → services → entry`, enforced by `npm run lint:layer-back-edges` (`layer-back-edge-baseline-node-server.json`). Transport layer: `cdp-proxy/`, `bridge-security.ts`, `fetch-proxy-gzip.ts`, `http-keepalive.ts`, `links-middleware.ts`, `runtime-flags.ts`, `cli-log-dedup.ts`. `index.ts` + `*-main.ts` are composition roots; imports point down.

## Main Files

- `src/index.ts` — entry point, server boot, Chrome/Electron launch, CDP WebSocket proxy
- `src/cdp-proxy/` — secret unmask gate, session→URL tracker, Chrome-leg reconnect + close codes
- `src/browser-shutdown.ts` — graceful close; confirms via CDP polling, not the launcher exit event (on macOS `planChromeSpawn` launches Chrome via `/usr/bin/open`, so the handle is `open`, not Chrome)
- `src/chrome-launch.ts` — executable/profile/launch args. `buildChromeLaunchArgs` (hosted `gpu` option ← `SLICC_CHROME_GPU=1`) disables Local Network Access checks (`--disable-features=LocalNetworkAccessChecks,…`) on **every** launch, or Chromium 142+ prompts on the public→local hosted-UI→bridge hop (`docs/pitfalls.md`). Synced with swift-server.
- `src/qa-setup.ts` — QA profile scaffolding; `src/release-package.ts` — packaging

## API Routes

- `ALL /api/fetch-proxy` — forwards browser requests across origins, injects masked secrets, records agent activity. Does **not** force `accept-encoding: identity`; `fetch-proxy-gzip.ts` inflates undeclared cached gzip and strips `content-encoding` (the synthetic SW `Response` doesn't inflate — `docs/pitfalls.md`).
- Raw mode (`routes/fetch-proxy-raw.ts`, mounted ahead of the default handler, selected by `X-Slicc-Raw-Request`) serves the wasm realm's HTTP proxy. Node specifics: chunked non-text uploads stream upstream (`duplex: 'half'`, caller's `Content-Length` kept); other bodies buffer, capped at 256 MiB (413 beyond). Contract `@slicc/shared-ts` `raw-fetch-protocol.ts`; swift twin `RawFetchProxy.swift`.
- `GET /api/agent-activity` — `{ activeInLastMinute }` over non-OPTIONS `/api/fetch-proxy` traffic (60 s window).

## Secrets Architecture

`OauthSecretStore` (in-memory OAuth token replicas) backs `POST /api/secrets/oauth-update` and `DELETE /api/secrets/oauth/:providerId`. The sessionId persists to `~/.slicc/session-id` (or `<env-file-dir>/session-id` under `--env-file`). Masking primitives (`masking.ts`, `domain-match.ts`) in `@slicc/shared-ts`.

## Related Guides

Docs: `docs/development.md` (workflows) · `docs/pitfalls.md` (CDP-leg drops, keep-alive, CSP-strip hop, Local Network Access) · `docs/transcript-export.md` (export bundle). `docs/electron.md`/`docs/mounts.md` linked above.

The `node-server` coverage gate measures only `packages/node-server`; `@slicc/shared-ts` is the separate `shared` gate. Keep that boundary explicit in `coverage-thresholds.json` so a shared barrel export cannot silently lower node-server coverage.
