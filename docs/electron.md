## Electron mode

Electron mode is now part of the main CLI entrypoint. Instead of launching a separate Electron-only wrapper, SLICC starts the normal CLI server and attaches to a target Electron app over CDP.

## Common commands

```bash
# Development
npm run dev:electron -- /Applications/Slack.app

# If the target app is already running
npm run dev:electron -- --kill /Applications/Slack.app

# Production build
npm run build
npm run start:electron -- /Applications/Slack.app
```

You can also run the CLI directly:

```bash
node dist/node-server/index.js --electron /Applications/Slack.app
node dist/node-server/index.js --electron-app=/Applications/Slack.app --kill
```

## Flags

- `--electron` — enable Electron attach mode; accepts a positional app path immediately after the flag
- `--electron-app <path>` / `--electron-app=<path>` — explicit Electron app path
- `--kill` — if the target app is already running, stop it first and relaunch with remote debugging enabled
- `--cdp-port=<port>` — override the Electron CDP port (defaults to `9223` in Electron mode)
- `--dev` — run against the Vite-powered dev server instead of built assets

## Running-app behavior

- If the target Electron app is already running and `--kill` is **not** supplied, SLICC exits with a clear message.
- If `--kill` **is** supplied, SLICC terminates the running app, relaunches it with remote debugging enabled, starts the local SLICC server, and reconnects the overlay path.

## How overlay injection works

1. The main CLI launches the target Electron app with a remote debugging port.
2. The local SLICC server starts as usual on port `5710`.
3. An overlay injector polls the Electron CDP target list.
4. For each eligible page target, it:
   - registers `Page.addScriptToEvaluateOnNewDocument`
   - evaluates the overlay bootstrap script immediately
5. That keeps the SLICC launcher/overlay available across page navigations.

## Verification checklist

- Start Electron mode against a real Electron app path.
- Confirm the launcher appears.
- Navigate within the target app and confirm the launcher reappears.
- Re-run while the app is already open and confirm:
  - without `--kill`, SLICC exits clearly
  - with `--kill`, SLICC relaunches the app and reconnects

## Notes

- macOS `.app` bundles are resolved to their inner executable automatically.
- The target app path should be a real bundle/executable path, not just a command name from `PATH`.
