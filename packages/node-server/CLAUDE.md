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

- **Standalone CLI**: launches Chrome and serves the webapp.
- **Serve-only**: reuses an already-running CDP target.
- **Electron mode**: launches or attaches to an Electron app and injects the overlay shell.

`packages/node-server/src/runtime-flags.ts` is the source of truth for supported flags such as `--serve-only`, `--cdp-port`, `--electron`, `--profile`, `--lead`, `--join`, and `--prompt`.

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
- `24679` — preferred Vite HMR port in dev mode

The runtime auto-resolves port conflicts when needed.

## Parallel Instances

Multiple standalone instances can run at once. Override the served UI port and let the runtime resolve the rest:

```bash
PORT=5720 npm run dev
PORT=5730 npm run dev
```

Each instance gets its own browser profile, CDP port, and HMR port.

## Electron Notes

- `dev:electron` runs the Node server in dev mode with Electron attach behavior.
- `electron-controller.ts`, `electron-runtime.ts`, and `electron-main.ts` own Electron-specific launch and overlay logic.
- `index.ts` starts an overlay injector once CDP is available.
- If an app blocks remote debugging, the runtime fails early rather than pretending attach succeeded.

## Main Files

- `src/index.ts` — entry point, server boot, Chrome/Electron launch, CDP WebSocket proxy
- `src/chrome-launch.ts` — Chrome executable/profile/launch argument handling
- `src/electron-controller.ts` — Electron app attach and overlay management
- `src/qa-setup.ts` — isolated QA profile scaffolding
- `src/release-package.ts` — release packaging
- `src/tray-url-shared.ts` — tray URL helpers shared with browser runtime code

## Related Guides

- `packages/webapp/CLAUDE.md` for the browser code being served
- `packages/chrome-extension/CLAUDE.md` for the extension float
- `docs/development.md` and `docs/electron.md` for longer-form workflows
