# CLAUDE.md

This file covers the Node.js CLI/Electron float in `packages/node-server/`.

## Scope

`packages/node-server/src/` launches Chrome or Electron, runs the thin /cdp bridge + `/api` surface, and provides the standalone runtime used by `npm run dev` and packaged releases. node-server serves no UI in any mode — the webapp is always loaded from the hosted origin.

## Main Commands

```bash
npm run dev
npm run dev:electron -- /Applications/Slack.app
npm run build
npm run package:release
```

## Runtime Modes

- **Standalone CLI**: thin-bridge only — the webapp is loaded from the hosted origin (`https://www.sliccy.ai`, or `--lead`/`WORKER_BASE_URL` for a local `:8787` wrangler) and the launched Chrome opens that URL with `?bridge=ws://localhost:<servePort>/cdp&bridgeToken=<token>`; node-server only owns CDP, fetch-proxy, sign-and-forward, and OAuth callback. There is no `--dev`/Vite-HMR mode; for local UI work run `npm run dev:standalone:fresh` (wrangler UI + node-server bridge) — **both `@slicc/webapp` and `@slicc/node-server` must be rebuilt first** or Chrome may fail to launch with a stale build. See [`docs/development.md` — Running a local instance with your UI changes](../../docs/development.md).
- **Serve-only**: reuses an already-running CDP target.
- **Electron mode**: launches or attaches to an Electron app. With the thin-bridge release the launched pages get `/electron?bridge=ws://localhost:<cdpPort>/cdp&bridgeToken=<token>&role=leader|follower` so the same hosted webapp drives every Electron page over the local bridge; the bundled electron-overlay shell is gone.
- **Hosted mode (`--hosted`)**: bundled with the e2b template at `packages/dev-tools/e2b-template/`. node-server boots headless Chromium against `?runtime=hosted-leader`, persists `--user-data-dir=/data/profile`, exposes `/api/cloud-status` and `/api/leader-restart`, reads `SLICC_TRAY_WORKER_BASE_URL`.
- **Cloud subcommands (`--cloud start/list/pause/resume/kill`)**: laptop-side orchestration over an e2b sandbox. The lifecycle logic lives in `@slicc/cloud-core` (`packages/cloud-core/`); the files in `src/cloud/` are thin adapters that wire the file-backed registry (`~/.slicc/cloud-sessions.json`) and the e2b substrate to the matching cloud-core operation. `src/cloud/dispatch.ts` owns argv parsing; each `src/cloud/<op>.ts` is a 1:1 adapter over the corresponding `cloud-core/src/operations/<op>.ts`. Mutually exclusive with `--hosted`. `start` accepts `--name`, `--env-file`, and `--template <alias>` (substrate template, default `slicc`) — use `--template slicc-test` to boot an isolated test template built via `SLICC_E2B_TEMPLATE_NAME` without touching the production `slicc` template. See [`packages/cloud-core/CLAUDE.md`](../cloud-core/CLAUDE.md).

`packages/node-server/src/runtime-flags.ts` is the source of truth for supported flags such as `--serve-only`, `--cdp-port`, `--electron`, `--profile`, `--lead`, `--join`, and `--prompt`.

`--serve-only` now honors `--cdp-port` (previously parsed but silently dropped, so the CDP proxy always pointed at 9222); the fake-LLM E2E harness depends on this to keep the proxy, the helper's `readCdpPageState` probe, and Playwright Chrome's `--remote-debugging-port` agreed on the same port.

## `--prompt` for Automated Testing

The `--prompt` flag auto-submits a prompt when the UI loads and is the quickest way to smoke-test common flows.

```bash
npm run dev -- --prompt "mount /tmp"
npm run dev -- --prompt "ls /workspace"
```

Use it for repeatable dev and QA flows without manual typing.

## Ports

- `5710` — default bridge + `/api` port (`PORT` overrides it)
- `9222` — default Chrome CDP port
- `9223` — default Electron attach CDP port

The runtime auto-resolves port conflicts when needed.

## Parallel Instances

Multiple standalone instances can run at once. Override the bridge port and let the runtime resolve the rest:

```bash
PORT=5720 npm run dev
PORT=5730 npm run dev
```

Each instance gets its own browser profile and CDP port.

## Electron Notes

- `dev:electron` runs the Node server in Electron attach mode.
- `electron-controller.ts`, `electron-runtime.ts`, and `electron-main.ts` own Electron-specific launch and per-target leader/follower URL minting (`/electron?bridge=…&bridgeToken=…&role=…`). The first attached target is `role=leader`; the controller re-elects the leader if it disappears. **Thin-bridge is the only overlay path** — the legacy bundled-UI overlay served from `http://localhost:<servePort>/electron` (Path A) was retired, so `ElectronOverlayInjector.create` requires a `thinBridge` config. `resolveOverlayThinBridge` defaults the hosted origin to production (`https://www.sliccy.ai`), so the only unresolvable case is a missing per-process bridge token, in which case `startOverlayInjector` fails fast instead of serving a bundled overlay.
- `index.ts` ensures the bridge is reachable once CDP is available so each Electron page can connect back over the same `/cdp` WebSocket the standalone Chrome uses.
- The overlay bootstrap injected into Electron pages (`window.__SLICC_ELECTRON_OVERLAY__`) is read from disk at `dist/ui/electron-overlay-entry.js` (`getElectronOverlayEntryDistPath` in `electron-runtime.ts`). That artifact is produced by the self-contained **`@ai-ecoverse/spoon`** package (`packages/spoon`), which owns the `<slicc-launcher>` overlay + IIFE entry; the webapp build mirrors it to the same path. The path is stable, so node-server needs no code change when the overlay source moves.
- If an app blocks remote debugging, the runtime fails early rather than pretending attach succeeded.

## Main Files

- `src/index.ts` — entry point, server boot, Chrome/Electron launch, CDP WebSocket proxy
- `src/browser-shutdown.ts` — graceful close of the launched browser on server shutdown; confirms via CDP polling rather than the launcher process's exit event, since on macOS Chrome is launched through `/usr/bin/open` (see `planChromeSpawn`), so the process handle is `open`, not Chrome itself
- `src/chrome-launch.ts` — Chrome executable/profile/launch argument handling
- `src/electron-controller.ts` — Electron app attach and overlay management
- `src/qa-setup.ts` — isolated QA profile scaffolding
- `src/release-package.ts` — release packaging
- `src/tray-url-shared.ts` — tray URL helpers shared with browser runtime code

## Secrets Architecture

Node-server includes `OauthSecretStore` (in-memory writable store for OAuth token replicas), `POST /api/secrets/oauth-update` and `DELETE /api/secrets/oauth/:providerId` endpoints. The sessionId is persisted to `~/.slicc/session-id` (or `<env-file-dir>/session-id` if `--env-file` is specified). The secret masking primitives (`masking.ts`, `domain-match.ts`) were moved to `@slicc/shared-ts`; node-server now imports from the shared package.

## Related Guides

- `packages/webapp/CLAUDE.md` for the browser code being served
- `packages/chrome-extension/CLAUDE.md` for the extension float
- `packages/cloud-core/CLAUDE.md` for the sandbox lifecycle logic used by `--cloud`
- `packages/shared-ts/CLAUDE.md` for secret masking primitives
- `docs/development.md` and `docs/electron.md` for longer-form workflows
