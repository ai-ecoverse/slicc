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
node dist/cli/index.js --electron /Applications/Slack.app
node dist/cli/index.js --electron-app=/Applications/Slack.app --kill
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

## Server runtime selection

Electron float now launches the server through a small runtime-selection boundary in `src/cli/server-runtime.ts`.

- Default runtime: Node (`src/cli/index.ts`)
- Optional requested runtime: set `SLICC_SERVER_RUNTIME=swift`
- Swift binary path: set `SLICC_SWIFT_SERVER_PATH=/path/to/SliccServer`
- Current behavior: if Swift is requested but unavailable, or if the float is running in `--dev`, SLICC logs the reason and falls back to Node.

## How overlay injection works

1. The main CLI launches the target Electron app with a remote debugging port.
2. The local SLICC server starts as usual on port `5710`.
3. An overlay injector polls the Electron CDP target list.
4. For each eligible page target, it:
   - registers `Page.addScriptToEvaluateOnNewDocument`
   - evaluates the overlay bootstrap script immediately
5. That keeps the SLICC launcher/overlay available across page navigations.

## macOS trust and distribution readiness

- **Local dev builds are different from shipped builds.** A locally built binary that never picked up the "downloaded from the internet" quarantine flow may launch without showing the same Gatekeeper dialogs that end users will see.
- **Direct-distribution builds should be Developer ID signed and notarized before sharing.** Apple’s current guidance for software distributed outside the Mac App Store is to sign with a Developer ID certificate and notarize the app before distribution.
- **Expect one normal first-launch confirmation even for a good release build.** A signed and notarized app downloaded from the internet can still show the standard "downloaded from the Internet" confirmation on first open.
- **Do not train users to bypass hard-fail malware warnings.** If macOS says it "cannot check the app for malicious software," the developer "cannot be verified," or the app is "damaged" / "will damage your computer," treat that as a packaging or trust failure. The only acceptable "Open Anyway" guidance is for internal or local dev builds.
- **Plain app launch does not imply an Automation prompt.** If `Sliccstart` launches target apps with `NSWorkspace.openApplication(...)`, no Apple Events privacy prompt should be required just for launch. Only add `NSAppleEventsUsageDescription` and Automation UX copy if the launcher later sends Apple Events / AppleScript to control another app.

## Suggested first-run guidance for a native `Sliccstart` app

- "If you downloaded `Sliccstart` from the internet, macOS may ask you to confirm opening it once."
- "If macOS says Apple cannot check it for malicious software or the developer cannot be verified, you are using an unsigned or unnotarized build. Prefer a notarized release."
- "If you are intentionally testing a local/internal build, you can retry once and then use **System Settings → Privacy & Security → Open Anyway**."
- "If macOS says the app is damaged or will damage your computer, stop and re-download or replace the build instead of bypassing the warning."
- "Launching Chrome or an Electron app should not require Accessibility or Automation approval unless a future build adds Apple Events-based control."

## Packaging checklist for the future native launcher

- Local development: expect unsigned / unnotarized binaries and document that Gatekeeper behavior may not match a downloaded release unless the artifact is actually quarantined.
- Direct distribution: archive the `.app`, sign with Developer ID, notarize it, and staple the ticket before shipping a downloadable artifact.
- First-run UX: include a help link or inline explanation that distinguishes the benign first-open confirmation from a true trust failure.
- Escalation path: if the app ever adds Apple Events-based automation, add `NSAppleEventsUsageDescription` with user-facing copy before shipping that change.

## Verification checklist

- Start Electron mode against a real Electron app path.
- Confirm the launcher appears.
- Navigate within the target app and confirm the launcher reappears.
- Re-run while the app is already open and confirm:
  - without `--kill`, SLICC exits clearly
  - with `--kill`, SLICC relaunches the app and reconnects
- For macOS packaging review, compare the intended release path against Apple’s current Gatekeeper / notarization support guidance before shipping a downloadable `.app`.

## Notes

- macOS `.app` bundles are resolved to their inner executable automatically.
- The target app path should be a real bundle/executable path, not just a command name from `PATH`.