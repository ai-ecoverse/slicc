---
name: computer
description: |
  Use this when looking at and poking a screen with SLICC's `computer`
  shell command (xdotool grammar). Covers v86 guests (`v86:<name>`),
  browser tabs (`tab:<id>`), display share (`screen:<handle>`), follower
  desktops (`ssh:<runtimeId>`), HTTP remotes (`url:<host>`), jsh-hosted
  backends, screenshot-space coordinates, frozen JPEG frames, and chaining
  click/type/key.
allowed-tools: bash
---

# computer — look at and poke a screen

`computer` is the look-then-act loop for every registered screen. Prefer it over `v86 type|key|mouse|screenshot|text` once a guest is running. `v86 start` still boots the VM and registers `v86:<name>`.

## Target

```bash
computer ls                         # ids, kinds, names, titles
computer use v86:arch               # default for later verbs
computer info                       # descriptor for the current target
```

Resolution order: `-c` / `--computer`, else `$COMPUTER`, else last `computer use`, else the only registered computer.

`-c` takes an id, the `-n` name the computer was added under, or its current title — in that order. Prefer the **id** or the **name**: `ls` shows them in separate columns because `TITLE` is whatever the surface calls itself right now (a tab republishes `document.title` on every capture), while `NAME` is fixed for the life of the registration.

## Look then act

Every poke writes a frozen JPEG and prints `target: <id>` then `screen: <path>`. The extension of that path follows the bytes, so it is `.jpg` in practice and `.png` only if a backend hands back PNG the runtime could not transcode — read the extension, do not assume it. The `target:` line is the resolved computer (`-c`, `$COMPUTER`, last `use`, or the only registered one) so a later `computer screenshot` without `-c` still binds the bash-row UI. That poke frame is a transcript side effect only — it does **not** redefine the coordinate space, so never read new coordinates off it (it can come back narrower and your clicks would map to the wrong place). Run a fresh `computer screenshot` before choosing coordinates for the next click. If the frozen frame cannot be captured, the poke still exits 0 (it already happened); do not retry the same click.

```bash
computer screenshot                 # JPEG; prints WxH → wxh (scale s)
computer screenshot --size high out.jpg
computer text                       # text-mode dump when the backend supports it
```

`--size` is `low` (256), `medium` (768, default), `high` (1536), or a max width. It is an upper bound: a frame is never widened past the computer's native size to reach it, and one that cannot be encoded that narrow arrives at native size rather than upscaled. Coordinates on later verbs are in that last `computer screenshot` (the last model-facing shot) unless `--native` — a poke's frozen frame does not update that space. `--native` is the pixel space `computer info --json` advertises (`size` / lastShot). Tab computers screenshot in device pixels; clicks are converted to CSS pixels with the tab's `devicePixelRatio` before they hit the page. A human can also click, scroll, and type in the live lightbox when the computer allows input; Escape releases. Frozen stills in the transcript never forward.

## Poke (xdotool; chainable)

```bash
computer mousemove 120 80
computer click 1 --at 120,80        # 1 left, 2 middle, 3 right
computer click 120 80               # two numbers → coords, button 1
computer drag 10 10 200 80
computer scroll 0 -3 --at 120,80
computer key ctrl+alt+Delete Return
computer type hello world
computer wait 400
computer click 1 type hello         # chain: click, then type
```

Anthropic aliases work the same: `left_click`, `right_click`, `mouse_move`, `left_click_drag`, `screenshot`, …

## v86 guest

```bash
v86 start -n arch -state "$TMPDIR/arch_state.bin.zst" -fs9p https://i.copy.sh/arch/ -net virtio -m 512
computer use v86:arch
computer screenshot
computer type "uname -a\n"
computer key Return
computer record -V 5 guest.webm
```

`computer rm` unregisters `v86:<name>` and does **not** power the guest off. `v86 stop` / `kill <pid>` still does. `v86 serve` is retired — use `computer watch -c v86:<name>`.

## Browser tab

```bash
playwright-cli tab-list             # pick a targetId that is not the SLICC app
computer add tab <targetId> -n docs
computer screenshot -c tab:<targetId>
computer click 1 --at 100,80 type hello
```

`computer add tab` refuses SLICC app tabs (`sliccy.ai` leader, `?slicc=`, extension pages). Pass a URL or a CDP target id. Look at the screenshot and click what you see — screenshot-space `--at` lands on the visual target even when `devicePixelRatio` is not 1.

## Display share (`screen`)

```bash
computer add screen -n desk          # panel terminal or cone approval card
computer screenshot -c screen:screen1
computer record -V 10 clip.webm      # timed clip from the live session
computer rm screen:screen1           # stops the getDisplayMedia tracks
```

`computer add screen` needs a real user gesture (`getDisplayMedia`). Type it in the panel terminal, or run it from a cone tool call so an approval card can open the picker. `computer ls` marks a live share with `[display slot]`. Input (keyboard/mouse) is not supported. Screen share cannot come back after `jshd --enable` restore — there is no gesture at boot.

`computer record` writes a clip to a VFS path (default `clip.webm`, max 60s). `screen` uses the live session recorder; v86/tab/url/jsh and a non-native `ssh` poll JPEG stills and pipe them through in-repo ffmpeg wasm (`-f image2pipe`). Default `--fps` is 2. A native-capture `ssh` Mac streams instead (see below).

## Follower desktop (`ssh`)

```bash
host                                       # every follower, tagged [ssh] [computer] [playwright]
ssh --list                                 # exec-capable tray followers only
computer add ssh follower-abc -n desk      # view-only
computer screenshot
computer add ssh follower-abc --allow-input
computer click 1 --at 100,80 type hello
computer add ssh mac-follower --sim UDID-1 --allow-input   # iOS Simulator
computer add ssh mac-follower --display 3 -n portrait      # a second screen
```

Probes at add: native ScreenCaptureKit/CGEvent when the follower advertises `capabilities.computer` (Swift launcher `sliccstart-computer`); else `screencapture` + `cliclick` (macOS), `grim`/`scrot`/`import` + `xdotool`/`ydotool` (Linux), `xcrun simctl io <udid> screenshot` + `idb ui` (`--sim`). `--sim` always takes the simctl/idb path, even on a native-capable follower — native capture sees the Mac desktop, never the Simulator; a missing or unbooted udid fails the add.

A Mac started with `slicc <join-url> follow --computer` shows as **one** entry in `host`, tagged `[ssh] [computer]` — the CLI and the headless Sliccstart it spawned are folded by a shared `hello.pairId`. Point `computer add ssh` at that one id and it picks ScreenCaptureKit automatically. **`host` is the roster to read**: an entry tagged `[computer]` can be looked at, whether it holds the screen itself or through its paired launcher. `ssh --list` shows the exec half only, because that is the list of targets that accept commands — a capture-only `sliccstart-computer` is addressable from `host`, never from `ssh`. Without `--computer` the same Mac appears twice (a `follower-…` tagged `[ssh]` and a `sliccstart-computer` tagged `[computer]`); either works, but only the native one captures under SLICC's own screen-recording permission. Frames come back base64 in ≤3 MiB chunks over tray-exec (or `computer.native.frame` when native). `--allow-input` is a sudo hop (`kind: command`) so a phone can answer with Face ID; `computer ls` shows `[input]` or `[view-only]`. The iOS follower itself is never a driven computer (a real iPhone is out of scope).

**Live frames (native capture only).** `computer watch` and `computer record` on a native Mac consume one ScreenCaptureKit stream of the display the id names, rather than taking a fresh screenshot per frame. Two watchers share that one stream; it stops when the last one stops. While it runs, `computer screenshot` hands you the stream's newest frame — a fresh one-shot would replace the follower's live capturer and end the stream. After a click or key, the frame written is the first one that arrives after the action. Everything else (`ssh` without native capture, v86, tab, url, jsh) still polls.

**Which screen (native capture only).** Default is the Mac's **main** display. `--display <n>` picks another: 1-based in the OS display order, the same numbering as `screencapture -D <n>` on that follower, so `screencapture -D 3` through the exec channel shows you what `--display 3` will capture. An out-of-range number fails with the attached displays listed (`display 7 is not attached — attached displays: 1=5120x2880 (main), …`), which is also the cheapest way to enumerate them. A picked display widens the id to `ssh:<runtime>:display:<n>`, so register one computer per screen to drive several at once. Native frames and `--size` are in real **pixels**, so `--size 2000` reaches 2000 px wide on a 2x display, not the 1440 point width.

A Mac only advertises `capabilities.computer` while its Screen Recording grant is actually in place, so `computer add ssh` on an ungranted Mac names the missing grant and falls back to `screencapture` through the machine's exec follower instead of failing on the native path. Ticking the box in System Settings republishes the capability within seconds — no reconnect. A `--computer` Mac without Screen Recording is still **one** `host` entry, tagged `[ssh]` only; the launcher's MOTD naming the missing grant prints on its own line under the CLI's (in `host` and `ssh --list`). A follower whose MOTD mentions Accessibility can capture but not inject: `--allow-input` will be accepted and events will fail until that box is ticked too.

## HTTP remote (`url`)

```bash
computer add url http://127.0.0.1:5710 -n demo
computer screenshot
computer text
computer type hello
```

The remote must answer `GET /computer` with a `ComputerDescriptor`. Screenshots are `GET /computer/screenshot`; optional `GET /computer/text` (404 means none); input is `POST /computer/input`. A trailing `/computer` on the base is stripped. Live frames use `WS /computer/frames` only when the descriptor advertises `frames: "push"`; a failed or closed socket falls back to screenshot polling. Otherwise `computer watch` polls. The in-tree reference is node-server `--computer-demo` (same port as the `/cdp` bridge).

## jsh-hosted backend

A durable `.jsh` can register a computer with `require('sliccy:computer').register(...)`. `register()` subscribes to host `computer-call` events, which keeps `jshd` alive. Optional `handlers.subscribe(fps, onFrame, maxWidth)` is the `computer watch` push path. Example: `/workspace/skills/jshd/examples/fake-computer.jsh`.
