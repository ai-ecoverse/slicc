# CLAUDE.md

Covers the Node.js CLI/Electron float in `packages/node-server/`. `src/` launches Chrome or Electron, runs the thin `/cdp` bridge + `/api` surface, and is the standalone runtime for `npm run dev` and packaged releases. It serves no UI — the webapp always loads from the hosted origin.

## Main Commands

```bash
npm run dev
npm run dev:electron -- /Applications/Slack.app
npm run build
npm run package:release
```

## Runtime Modes

- **Standalone CLI**: thin-bridge only — the webapp loads from the hosted origin (`https://www.sliccy.ai`, or `--lead`/`WORKER_BASE_URL` for a local `:8787` wrangler) and the launched Chrome opens it with `?bridge=ws://localhost:<servePort>/cdp&bridgeToken=<token>`; node-server owns only CDP, fetch-proxy, sign-and-forward, and the OAuth callback. No Vite-HMR; for local UI work run `npm run dev:standalone:fresh` — **rebuild `@slicc/webapp` and `@slicc/node-server` first** or Chrome launches stale ([`docs/development.md`](../../docs/development.md)).
- **Serve-only**: reuses an already-running CDP target. Honors `--cdp-port` (the fake-LLM E2E harness needs the proxy, the helper's `readCdpPageState` probe, and Playwright's `--remote-debugging-port` on one agreed port).
- **Electron mode**: launches or attaches to an Electron app. Launched pages get `/electron?bridge=ws://localhost:<cdpPort>/cdp&bridgeToken=<token>&role=leader|follower` so the hosted webapp drives every page over the local bridge; no bundled overlay shell. On a `--join` launch the LEADER URL also carries `tray=<join url>` so an egress-allowed app attaches as ONE tray follower — without it the overlay mints its own tray as a second leader; auto-follow tabs and no-join leaders carry an explicitly EMPTY `tray=` to block the stored-join-URL fallback. Egress-blocked apps (Signal) join via the headless WebRTC follower. See `docs/electron.md`.
- **Hosted mode (`--hosted`)**: bundled with the e2b template (`packages/dev-tools/e2b-template/`). Boots headless Chromium against `?runtime=hosted-leader`, persists `--user-data-dir=/data/profile`, exposes `/api/cloud-status` + `/api/leader-restart`, reads `SLICC_TRAY_WORKER_BASE_URL`.
- **Cloud subcommands (`--cloud start/list/pause/resume/kill`)**: laptop-side orchestration over an e2b sandbox, mutually exclusive with `--hosted`. Lifecycle logic lives in `@slicc/cloud-core`; `src/cloud/` files are thin adapters wiring the file-backed registry (`~/.slicc/cloud-sessions.json`) + e2b substrate to the matching cloud-core op — `dispatch.ts` parses argv, each `<op>.ts` is a 1:1 adapter over `cloud-core/src/operations/<op>.ts`. `start` takes `--name`, `--env-file`, `--template <alias>` (default `slicc`; `slicc-test` for an isolated test template via `SLICC_E2B_TEMPLATE_NAME`). See [`packages/cloud-core/CLAUDE.md`](../cloud-core/CLAUDE.md).
- **CLI installer (`--install-cli`)**: downloads the released Go `slicc` follower binary (`packages/slicc-cli`) for the platform and exits — no server boots. `src/install-cli.ts` uses `scanGithubReleases` (`@slicc/shared-ts`) to walk GitHub releases newest→oldest for the first `slicc-<os>-<arch>` asset (sparse: binaries attach only when `packages/slicc-cli` changed), installing to an OS-idiomatic dir (POSIX `~/.local/bin` / `/usr/local/bin`, Windows `%LOCALAPPDATA%\Programs\slicc`, or `--install-dir`).

`src/runtime-flags.ts` is the source of truth for flags (`--serve-only`, `--cdp-port`, `--electron`, `--profile`, `--lead`, `--join`, `--prompt`, …).

## `--prompt`

Auto-submits a prompt when the UI loads — quickest smoke-test: `npm run dev -- --prompt "ls /workspace"`.

## Mount table (`--mount`)

Repeatable `--mount=<os-path>:<slicc-path>` (`runtime-flags.ts` → `mounts`, `parseMountTableMapping`: last-colon split, `~` expansion, dedup by target). `src/hostfs.ts` serves the mapped folders over `/api/hostfs`; the webapp auto-mounts them at kernel boot via `HostFsMountBackend` (advertised as `autoMounts` on `GET /api/runtime-config`) — no picker, no Chrome permission. Picker mounts are unaffected. Swift parity: `HostFSRoutes.swift` / `HostFSWatch.swift`. The **full wire contract** (request shapes, per-entry stats, ranged/streamed reads, conditional requests, errno codes, preflight + cache coherence) lives in [`docs/mounts.md`](../../docs/mounts.md#auto-mounted-host-folders-the-mount-table) — read it before touching `hostfs.ts`.

node-server wiring behind that contract:

- Every `/api/hostfs` error MUST carry an errno `code` — a code-less 404 is how the webapp detects an old bridge and downgrades. Non-obvious: the stable `POST /api/hostfs` dispatcher is excluded from the global 50 MiB `express.json()` via `shouldParseGlobalJson` in **`fetch-proxy-headers.ts`** (outside `index.ts` so tests import it without booting the server), so its bounded 1 MiB parser and `hostFsBodyErrorHandler` (parse → 400 `EINVAL`, oversized → 413 `EFBIG`) apply. `HOSTFS_MAX_BODY_BYTES` guards only the UNRANGED read (a ranged read is bounded by its window). `preflightMaxAge()` (`bridge-security.ts`) caps `/api/hostfs*` preflights at 7200 s, else 600 s.
- `src/hostfs-watch.ts` recursively watches each mount, debounces per mount, broadcasts batched `hostfs_invalidate` over `/licks-ws`; unattributable events clear it.

## Bridge keep-alive

`src/http-keepalive.ts` → `applyBridgeKeepAlive(server)` (in `index.ts` before `listen()`) raises `keepAliveTimeout` to 120 s and `headersTimeout` to 130 s. Node's 5 s default loses a request whenever the browser reuses a socket the server is closing — a `/api/hostfs` fan-out hits this regularly. Swift is a no-op: Hummingbird's `idleTimeout` defaults to `nil`.

## Ports & Parallel Instances

Defaults: `5710` bridge + `/api` (`PORT` overrides), `9222` Chrome CDP, `9223` Electron attach CDP. The runtime auto-resolves conflicts; multiple standalone instances can run at once — set `PORT=5720 npm run dev` and each gets its own browser profile and CDP port.

## Electron Notes

- `dev:electron` runs the Node server in Electron attach mode. If an app blocks remote debugging, the runtime fails early rather than pretend attach succeeded.
- `electron-controller.ts`, `electron-runtime.ts`, `electron-main.ts` own launch and per-target leader/follower URL minting. The first attached target is `role=leader`; the controller re-elects on disappearance. `index.ts` makes the bridge reachable once CDP is up so each page connects back over the same `/cdp` WebSocket. **Thin-bridge is the only overlay path** — the legacy bundled-UI overlay was retired, so `ElectronOverlayInjector.create` requires a `thinBridge` config; `resolveOverlayThinBridge` defaults the origin to production, so only a missing bridge token is unresolvable, on which `startOverlayInjector` fails fast.
- The overlay bootstrap (`window.__SLICC_ELECTRON_OVERLAY__`) is read from the stable path `dist/ui/electron-overlay-entry.js` (`getElectronOverlayEntryDistPath`), produced by the self-contained **`@ai-ecoverse/spoon`** package (owns the `<slicc-launcher>` overlay + IIFE entry) and mirrored there by the webapp build — node-server needs no change when it moves.
- The CSP-strip escalation (`Fetch.enable` → `handleFetchRequestPaused`) re-issues intercepted **document** requests through Node http/https, forwarding POST bodies byte-exact via `decodeCdpRequestPostBody` (`Fetch.failRequest` rather than corrupt an unreconstructable body). Swift twin `OverlayPostBody.swift`; background in [`docs/pitfalls.md`](../../docs/pitfalls.md).

## CDP proxy: Chrome-leg drops

Chrome's browser-level socket drops on its own (`messageTooLarge`, inbound-queue overflow) and Chrome discards EVERY CDP session behind it. `src/cdp-proxy/chrome-reconnect.ts` handles that at parity with swift-server's `CDPProxy`: `markChromeLegDown` clears the leg and starts buffering Client→Chrome frames (bounded at 1,000 with drop-oldest, `client-frame-buffer.ts`), and `ChromeReconnectController` re-discovers the ws URL via `/json/version` and re-dials. The active client is closed with `CDP_UPSTREAM_RESET_CLOSE_CODE` (4002, `close-codes.ts`); the page-side `CDPClient` treats 4002 as "reset sessions and re-dial" — unlike 4001 (superseded) it does NOT latch. Both codes MUST stay in sync with `packages/webapp/src/cdp/cdp-client.ts`. Live frames from a client that no longer holds the slot (superseded, closed, or reset with 4002) are dropped before forwarding — the same guard as swift-server's `receive`. Background: issue #2417.

**Reconnect policy (identical in node-server and swift-server).** Retry indefinitely with a 1 s delay between attempts, until shutdown — there is no attempt cap. Close the active client with 4002 `upstream-reset` after the 3rd consecutive failure, so it does not hang on a proxy whose Chrome leg is gone. After a successful reconnect, reset the active client ONLY if it is the same client that held the slot when the Chrome leg went down — it is the one whose sessions Chrome discarded. A client that connected during the outage never had sessions on the dead leg and its buffered frames were just flushed onto the replacement connection, so closing it with 4002 would make the page retry commands that already ran (a sessionless `Target.createTarget` opens a duplicate tab). Never leave a clientless buffer around: buffered frames are dropped whenever the client that wrote them loses the slot.

**Buffer generations.** Every buffer is tagged `{chromeConnectionId, clientId}` and is flushed only when both still match at flush time (`client-frame-buffer.ts` owns the transitions — `adoptClientSlot`, `takeClientFrameBuffer`, `releaseClientSlot` — so the policy is unit-testable without booting a server). Frames buffered because the Chrome leg dropped name sessions the replacement connection never had, and a browser-level `Target.createTarget` among them would execute after its caller was already rejected with 4002, so the caller's retry opens a duplicate tab; those buffers are dropped with a `[cdp-proxy] Dropped N buffered client frame(s) — <reason>` line. A buffer left by a superseded or departed client is dropped the same way. Only the original initial-connect buffering (client connected before Chrome was ready, `chromeConnectionId: null`) still flushes.

## Main Files

- `src/index.ts` — entry point, server boot, Chrome/Electron launch, CDP WebSocket proxy
- `src/cdp-proxy/` — proxy internals: secret unmask gate, session→URL tracker, Chrome-leg reconnect + close codes
- `src/browser-shutdown.ts` — graceful close on shutdown; confirms via CDP polling not the launcher's exit event, since on macOS Chrome launches through `/usr/bin/open` (`planChromeSpawn`) so the process handle is `open`, not Chrome
- `src/chrome-launch.ts` — Chrome executable/profile/launch args. `buildChromeLaunchArgs` disables Local Network Access checks (`--disable-features=LocalNetworkAccessChecks,…`) on **every** launch, because the hosted UI → local bridge hop is public→local and Chromium 142+ gates it behind a prompt. Synced with swift-server; [`docs/pitfalls.md`](../../docs/pitfalls.md).
- `src/qa-setup.ts` — QA profile scaffolding · `src/release-package.ts` — release packaging

## API Routes

- `ALL /api/fetch-proxy` — forwards browser requests across origins, injects masked secrets, records agent activity before forwarding. Does **not** force `accept-encoding: identity`; undici negotiates gzip/br, and a gzip-magic sniff inflates cached gzip that arrived with no `content-encoding` (#3037). `content-encoding` is stripped because the browser hop is a synthetic SW `Response` that does not inflate.
- `GET /api/agent-activity` — `{ activeInLastMinute: boolean }` over non-OPTIONS `/api/fetch-proxy` traffic in a fixed 60 s window

## Secrets Architecture

`OauthSecretStore` (in-memory writable store for OAuth token replicas) backs `POST /api/secrets/oauth-update` and `DELETE /api/secrets/oauth/:providerId`. The sessionId persists to `~/.slicc/session-id` (or `<env-file-dir>/session-id` under `--env-file`). Masking primitives (`masking.ts`, `domain-match.ts`) live in `@slicc/shared-ts`.

## Related Guides

- `packages/webapp/CLAUDE.md` — served browser code · `packages/chrome-extension/CLAUDE.md` — extension float · `packages/cloud-core/CLAUDE.md` — `--cloud` lifecycle · `packages/shared-ts/CLAUDE.md` — masking primitives
- `docs/development.md`, `docs/electron.md` — workflows · `docs/mounts.md` — `/api/hostfs` wire contract · `docs/pitfalls.md` — CSP-strip hop, Local Network Access
- `docs/transcript-export.md` — export bundle layout (runs in the webapp; the `/cdp` bridge is transparent)
