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

# computer

Look-then-act for every registered screen. Prefer over `v86 type|key|mouse|screenshot|text` once running. `v86 start` boots and registers `v86:<name>`.

## Target

```bash
computer ls
computer use v86:arch
computer info
```

Resolution: `-c`/`--computer`, else `$COMPUTER`, else last `use`, else sole registered. `-c` takes id, `-n` name, or title — prefer **id** or **name** (title changes per capture).

## Look then act

Every poke writes frozen JPEG + prints `target: <id>` then `screen: <path>` (`.jpg` usually). Poke frame is transcript-only — **does not** update coordinate space. Fresh `computer screenshot` before next click coords.

```bash
computer screenshot
computer screenshot --size high out.jpg
computer text
```

`--size`: `low` (256), `medium` (768, default), `high` (1536), or max width — upper bound, never upscale. Coords match last `computer screenshot` unless `--native` (pixel space from `computer info --json`). Tab screenshots device pixels; clicks → CSS via `devicePixelRatio`. Live lightbox input when allowed; Escape releases. Frozen stills never forward.

## Poke (chainable)

```bash
computer mousemove 120 80
computer click 1 --at 120,80
computer click 120 80
computer drag 10 10 200 80
computer scroll 0 -3 --at 120,80
computer key ctrl+alt+Delete Return
computer type hello world
computer wait 400
computer click 1 type hello
```

Aliases: `left_click`, `right_click`, `mouse_move`, `left_click_drag`, `screenshot`, …

## v86

```bash
v86 start -n arch -state "$TMPDIR/arch_state.bin.zst" -fs9p https://i.copy.sh/arch/ -net virtio -m 512
computer use v86:arch
computer screenshot
computer type "uname -a\n"
computer key Return
computer record -V 5 guest.webm
```

`computer rm` unregisters, does not power off (`v86 stop`/`kill`). `v86 serve` retired — `computer watch -c v86:<name>`.

## Browser tab

```bash
playwright-cli tab-list
computer add tab <targetId> -n docs
computer screenshot -c tab:<targetId>
computer click 1 --at 100,80 type hello
```

Refuses SLICC app tabs (`sliccy.ai` leader, `?slicc=`, extension). Pass URL or CDP target id. `--at` in screenshot space.

## Display share (`screen`)

```bash
computer add screen -n desk
computer screenshot -c screen:screen1
computer record -V 10 clip.webm
computer rm screen:screen1
```

Needs user gesture (`getDisplayMedia`). Panel terminal keystroke = gesture; cone tool → approval card. `[display slot]` in `ls`. No input. `size` from first frame. Cannot restore after `jshd --enable` restore.

`computer record` → VFS path (default `clip.webm`, max 60s). `screen` = live recorder; others poll JPEG + ffmpeg wasm. Default `--fps` 2. Native `ssh` Mac may stream.

## Follower desktop (`ssh`)

```bash
host
ssh --list
computer add ssh follower-abc -n desk
computer screenshot
computer add ssh follower-abc --allow-input
computer click 1 --at 100,80 type hello
computer add ssh mac-follower --sim UDID-1 --allow-input
computer add ssh mac-follower --display 3 -n portrait
```

Probes: native ScreenCaptureKit/CGEvent when `capabilities.computer`; else `screencapture`+`cliclick` (macOS), `grim`/`scrot`+`xdotool` (Linux), `simctl`+`idb` (`--sim`). `--sim` always sim path.

`host` = roster (`[ssh] [computer]` folded by `pairId`). `ssh --list` = exec-capable only. Without Screen Recording grant → `screencapture` fallback; capability republishes when granted. `--allow-input` = sudo hop; `[input]` vs `[view-only]` in `ls`. iOS phone not a driven computer.

**Native live frames:** `computer watch`/`record` share one ScreenCaptureKit stream; `screenshot` returns newest frame while streaming. **`--display <n>`** — 1-based OS order (`screencapture -D <n>` to preview). Id widens to `ssh:<runtime>:display:<n>`.

## HTTP remote (`url`)

```bash
computer add url http://127.0.0.1:5710 -n demo
computer screenshot
computer text
computer type hello
```

Remote: `GET /computer` → `ComputerDescriptor`. Screenshot `GET /computer/screenshot`; text `GET /computer/text` (404 = none); input `POST /computer/input`. Trailing `/computer` stripped. Push frames: `WS /computer/frames` when `frames: "push"`. Reference: node-server `--computer-demo`.

## jsh backend

`.jsh` registers via `require('sliccy:computer').register(...)`. Subscribes `computer-call`, keeps `jshd` alive. Optional `handlers.subscribe(fps, onFrame, maxWidth)` for watch push. Example: `/workspace/skills/jshd/examples/fake-computer.jsh`.
