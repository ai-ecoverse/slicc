# Computer protocol

Every screen the agent can look at and poke — a v86 guest, a browser tab, a jsh-hosted backend, a persistent display share, a follower desktop (`ssh`), or an HTTP remote (`url`) — is a **computer**. Wire types live in `packages/shared-ts/src/computer-protocol.ts` so a descriptor that crosses the tray channel is the same shape the kernel registry emits.

Agent loop: [`packages/vfs-root/workspace/skills/computer/SKILL.md`](../packages/vfs-root/workspace/skills/computer/SKILL.md). Shell surface: [`shell-reference.md`](./shell-reference.md) (`computer`).

Phase 1 (#3245) ships the protocol, registry, `computer` command, `v86` / `tab` adapters, and `sliccy:computer`. UI (#3246) ships overlay cards, a live lightbox, bash-row frames, and additive tray wire (`computers.list` / `computer.frame` / `computer.watch` / `computer.unwatch`) — page wiring in `docs/webapp-details.md`, components in `docs/webcomponents-details.md`. Phase 3 (#3247) adds `screen` (persistent `getDisplayMedia` session), `ssh` (follower desktop / iOS Simulator), and `url` (HTTP remote-computer contract). VNC is not in this issue.

## Types

| Type                   | Role                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ComputerDescriptor`   | `id`, `kind`, `title`, `size`, `state`, `capabilities`, optional `pid` / `softKeys` / `lastShot`                                                              |
| `ComputerCapabilities` | `screenshot`, `text`, `frames` (`push` / `poll` / `none`), `keyboard`, `mouse` (`absolute` / `relative` / `touch` / `none`), `scroll`, `exec`, `inputAllowed` |
| `ComputerInputEvent`   | `mousemove`, `button`, `click`, `scroll`, `key`, `text`, `wait`, `drag`. Mouse backends expand drag; touch backends send `{ type: 'drag' }`                   |
| `ComputerFrame`        | `seq`, `mime` (`image/jpeg` or `image/png`), `width`, `height`, `bytes`, optional `overCap` when encoded pixels exceed the requested maxWidth                 |
| `ComputerLastShot`     | screenshot-space size + scale of the last frame the model saw                                                                                                 |

Kinds on the wire: `'v86' | 'tab' | 'screen' | 'ssh' | 'url' | 'vnc' | 'jsh'`. Ids are namespaced (`v86:<name>`, `tab:<targetId>`, `screen:<handle>`, `ssh:<runtimeId>`, `ssh:<runtimeId>:sim:<udid>`, `url:<host><path>`, `jsh:<name>`).

Buttons: xdotool 1 / 2 / 3 = left / middle / right.

## Screenshot space

Input coordinates are in the space of `lastShot` unless `--native`. `computer screenshot` prints `WxH → wxh (scale s)` so the mapping is visible in the transcript.

Presets (`packages/webapp/src/computers/scale.ts`): `low` 256, `medium` 768 (default), `high` 1536. A bare number is a max width.

Every poke writes a frozen JPEG to `$TMPDIR/computer/<name>/<seq>.jpg` and prints `screen: <path>`. Successful look/act verbs also prepend `target: <id>` (the resolved computer) so bash-row UI can watch without `-c` on the command line. `ls` / `add` / `rm` / `use` and `--json` omit the stamp.

## Registry and host

`packages/webapp/src/computers/` is unranked in the layer stack (same band as UI minus a half-step). Shell, kernel, and CDP may import it. Importing `ui/` from `computers/` is a back-edge — the computers store lives in `ui/`.

- `backend.ts` — `ComputerBackend` (`describe`, `screenshot`, `input`, optional `text` / `exec` / `subscribe`, `close`)
- `registry.ts` — `installComputerRegistry` (idempotent). Spawn `ProcessKind 'computer'` or adopt an existing pid (v86 VM, jshd unit). Abort of an owned pid closes the backend; an adopted pid is not killed on `computer rm`
- `host.ts` — kernel messages `computers`, `computer-frame`, `computer-watch`, `computer-unwatch`. Watches poll `screenshot` when the backend has no `subscribe`. Push `subscribe(fps, onFrame, maxWidth)` receives the watch cap; the host resamples wider frames with createImageBitmap + OffscreenCanvas + convertToBlob, or passes them through with `overCap` when those APIs are missing
- `encode-frame.ts` / `frame-bytes.ts` / `frames.ts` / `keys.ts` / `scale.ts`

The kernel worker lazy-loads `startComputersHost` so computers stay out of the first-load graph.

## Adapters (phase 1–3)

| Kind     | Module                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v86`    | `computers/adapters/v86.ts`                                           | Relative mouse, Y inverted to guest origin. `v86 start` registers `v86:<name>` by adopting the VM pid. `close()` detaches only; JPEG mime even when the VGA buffer was RGBA                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tab`    | `computers/adapters/tab.ts`                                           | Absolute mouse. Injected `browser` without `panelRpc` → Local (CLI page handlers); both present → Bridged (kernel worker). Refuses `isSliccAppUrl` at add, screenshot, and input                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `jsh`    | `computers/adapters/jsh.ts` + `kernel/realm/realm-computer-bridge.ts` | Realm `require('sliccy:computer').register(handlers)` subscribes to `computer-call` (keep-alive via `onEvent`) and answers over the `computer` RPC channel (`register` / `unregister` / `reply` / `frame`). Optional `handlers.subscribe(fps, onFrame, maxWidth)` is the push path; the host caches frames, resamples wider than the watch cap (or marks `overCap`), and times out a silent stream                                                                                                                                                                                                                                                       |
| `screen` | `computers/adapters/screen.ts`                                        | Always bridged. Persistent `getDisplayMedia` session (`screencapture` RPC `mode: 'session'`). Keyboard/mouse off. `computer add screen` needs a user gesture (panel terminal `requestPermission('screenshare')` or cone approval card `data-picker="screenshare"`). `computer ls` suffixes `[display slot]`. `computer rm` / kill / page unload stop tracks. `computer record -V` records from the live session. Cannot restore on `jshd --enable` (no gesture at boot)                                                                                                                                                                                  |
| `ssh`    | `computers/adapters/ssh.ts`                                           | Follower desktop over tray-exec. Probe at add: `screencapture`+`cliclick` (macOS), `grim`/`scrot`/`import`+`xdotool`/`ydotool` (Linux), `xcrun simctl`+`idb` (`--sim`). Frames return as base64 in ≤3 MiB chunks. View-only unless `--allow-input` (sudo `kind: 'command'` once at add; `ls` / overlay badge `[input]` vs `[view-only]`). iOS follower is never a computer; `--sim` is a Mac follower's Simulator. Adapter takes injected `SshExec` (lazy import).                                                                                                                                                                                       |
| `url`    | `computers/adapters/url.ts`                                           | HTTP remote. Probe `GET /computer` → `ComputerDescriptor`. `GET /computer/screenshot`, optional `GET /computer/text` (404 → null), `POST /computer/input`. Optional native `WS /computer/frames` only when `capabilities.frames === 'push'`; a failed or closed socket falls back to screenshot polling because the host returns immediately when `subscribe` exists. All HTTP goes through injected fetch (`createProxiedFetch` in production — lazy from `run.ts`, never a static adapter import). `computer add url http://127.0.0.1:5710` (trailing `/computer` stripped). Reference server: node-server `--computer-demo` (`src/computer-demo.ts`). |

## Shell

`computer` (`packages/webapp/src/shell/supplemental-commands/computer/`) is xdotool plus Anthropic aliases. Target: `-c` → `$COMPUTER` → last `computer use` → the only registered computer. `switch (verb)` in `run.ts` so subcommand-help source scan finds cases.

`v86 type|key|mouse|screenshot|text` are thin aliases of `computer` (`v86:<name>`); prefer `computer <verb> -c v86:<name>`. Each poke still prints `target: <id>` then `screen: <path>`.

`computer record [-V SEC] [--fps N] [file]` writes a clip (default `clip.webm`, max 60s). `screen` uses the live session `recordClip` path. Other kinds poll JPEG stills (max width 768, default 2 fps) and pipe them through in-repo ffmpeg wasm (`-f image2pipe -c:v mjpeg`).
