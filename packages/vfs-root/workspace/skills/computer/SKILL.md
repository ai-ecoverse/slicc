---
name: computer
description: |
  Use this when looking at and poking a screen with SLICC's `computer`
  shell command (xdotool grammar). Covers v86 guests (`v86:<name>`),
  browser tabs (`tab:<id>`), display share (`screen:<handle>`), follower
  desktops (`ssh:<runtimeId>`), jsh-hosted backends, screenshot-space
  coordinates, frozen JPEG frames, and chaining click/type/key.
allowed-tools: bash
---

# computer — look at and poke a screen

`computer` is the look-then-act loop for every registered screen. Prefer it over `v86 type|key|mouse|screenshot|text` once a guest is running. `v86 start` still boots the VM and registers `v86:<name>`.

## Target

```bash
computer ls                         # ids, kinds, sizes
computer use v86:arch               # default for later verbs
computer info                       # descriptor for the current target
```

Resolution order: `-c` / `--computer`, else `$COMPUTER`, else last `computer use`, else the only registered computer.

## Look then act

Every poke writes a frozen JPEG and prints `target: <id>` then `screen: <path>`. The `target:` line is the resolved computer (`-c`, `$COMPUTER`, last `use`, or the only registered one) so a later `computer screenshot` without `-c` still binds the bash-row UI. Read that frame (or `computer screenshot`) before the next click.

```bash
computer screenshot                 # JPEG; prints WxH → wxh (scale s)
computer screenshot --size high out.jpg
computer text                       # text-mode dump when the backend supports it
```

`--size` is `low` (256), `medium` (768, default), `high` (1536), or a max width. Coordinates on later verbs are in that last screenshot unless `--native`.

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
```

`computer rm` unregisters `v86:<name>` and does **not** power the guest off. `v86 stop` / `kill <pid>` still does.

## Browser tab

```bash
playwright-cli tab-list             # pick a targetId that is not the SLICC app
computer add tab <targetId> -n docs
computer screenshot -c tab:<targetId>
computer click 1 --at 100,80 type hello
```

`computer add tab` refuses SLICC app tabs (`sliccy.ai` leader, `?slicc=`, extension pages). Pass a URL or a CDP target id.

## Display share (`screen`)

```bash
computer add screen -n desk          # panel terminal or cone approval card
computer screenshot -c screen:screen1
computer record -V 10 clip.webm      # timed clip from the live session
computer rm screen:screen1           # stops the getDisplayMedia tracks
```

`computer add screen` needs a real user gesture (`getDisplayMedia`). Type it in the panel terminal, or run it from a cone tool call so an approval card can open the picker. `computer ls` marks a live share with `[display slot]`. Input (keyboard/mouse) is not supported. Screen share cannot come back after `jshd --enable` restore — there is no gesture at boot.

`computer record` is screen-only in this phase; other kinds fail with a phase-4 message.

## Follower desktop (`ssh`)

```bash
ssh --list                                 # exec-capable tray followers
computer add ssh follower-abc -n desk      # view-only
computer screenshot
computer add ssh follower-abc --allow-input
computer click 1 --at 100,80 type hello
computer add ssh mac-follower --sim UDID-1 --allow-input   # iOS Simulator
```

Probes at add: `screencapture` + `cliclick` (macOS), `grim`/`scrot`/`import` + `xdotool`/`ydotool` (Linux), `xcrun simctl io <udid> screenshot` + `idb ui` (`--sim`). Frames come back base64 in ≤3 MiB chunks over tray-exec. `--allow-input` is a sudo hop (`kind: command`) so a phone can answer with Face ID; `computer ls` shows `[input]` or `[view-only]`. The iOS follower itself is never a driven computer (a real iPhone is out of scope).

## jsh-hosted backend

A durable `.jsh` can register a computer with `require('sliccy:computer').register(...)`. `register()` subscribes to host `computer-call` events, which keeps `jshd` alive. Optional `handlers.subscribe(fps, onFrame, maxWidth)` is the `computer watch` push path. Example: `/workspace/skills/jshd/examples/fake-computer.jsh`.
