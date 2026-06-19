# CLAUDE.md

This file covers the Node.js CLI/Electron float in `packages/node-server/`.

## Scope

`packages/node-server/src/` launches Chrome or Electron, serves the UI, proxies CDP, and provides the standalone runtime used by `npm run dev` and packaged releases.

## Main Commands

```bash
npm run dev
npm run dev:electron -- /Applications/Slack.app
npm run build
npm run package:release
```

## Runtime Modes

- **Standalone CLI**: launches Chrome and serves the webapp. With `THIN_BRIDGE_MODE=1` (default for the breaking release), the webapp is loaded from the hosted origin (`https://www.sliccy.ai` or the local `:8787` wrangler) and the launched Chrome opens that URL with `?bridge=ws://localhost:<cdpPort>/cdp&bridgeToken=<token>`; node-server only owns CDP, fetch-proxy, sign-and-forward, and OAuth callback.
- **Serve-only**: reuses an already-running CDP target.
- **Electron mode**: launches or attaches to an Electron app. With the thin-bridge release the launched pages get `/electron?bridge=ws://localhost:<cdpPort>/cdp&bridgeToken=<token>&role=leader|follower` so the same hosted webapp drives every Electron page over the local bridge; the bundled electron-overlay shell is gone.
- **Hosted mode (`--hosted`)**: bundled with the e2b template at `packages/dev-tools/e2b-template/`. node-server boots headless Chromium against `?runtime=hosted-leader`, persists `--user-data-dir=/data/profile`, exposes `/api/cloud-status` and `/api/leader-restart`, reads `SLICC_TRAY_WORKER_BASE_URL`.
- **Cloud subcommands (`--cloud start/list/pause/resume/kill`)**: laptop-side orchestration over an e2b sandbox. The lifecycle logic lives in `@slicc/cloud-core` (`packages/cloud-core/`); the files in `src/cloud/` are thin adapters that wire the file-backed registry (`~/.slicc/cloud-sessions.json`) and the e2b substrate to the matching cloud-core operation. `src/cloud/dispatch.ts` owns argv parsing; each `src/cloud/<op>.ts` is a 1:1 adapter over the corresponding `cloud-core/src/operations/<op>.ts`. Mutually exclusive with `--hosted`. See [`packages/cloud-core/CLAUDE.md`](../cloud-core/CLAUDE.md).

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

- `5710` — default served UI port (`PORT` overrides it)
- `9222` — default Chrome CDP port
- `9223` — default Electron attach CDP port

Vite HMR shares the UI server via `/__vite_hmr` path (no separate port).
The runtime auto-resolves port conflicts when needed.

## Parallel Instances

Multiple standalone instances can run at once. Override the served UI port and let the runtime resolve the rest:

```bash
PORT=5720 npm run dev
PORT=5730 npm run dev
```

Each instance gets its own browser profile and CDP port. HMR shares the UI server.

## Electron Notes

- `dev:electron` runs the Node server in dev mode with Electron attach behavior.
- `electron-controller.ts`, `electron-runtime.ts`, and `electron-main.ts` own Electron-specific launch and per-target leader/follower URL minting (`/electron?bridge=…&bridgeToken=…&role=…`). The first attached target is `role=leader`; the controller re-elects the leader if it disappears. The bundled electron-overlay HTML shell was retired with the thin-bridge release — Electron pages now load the hosted webapp directly.
- `index.ts` ensures the bridge is reachable once CDP is available so each Electron page can connect back over the same `/cdp` WebSocket the standalone Chrome uses.
- If an app blocks remote debugging, the runtime fails early rather than pretending attach succeeded.

## Main Files

- `src/index.ts` — entry point, server boot, Chrome/Electron launch, CDP WebSocket proxy
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
