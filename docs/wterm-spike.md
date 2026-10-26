# wterm terminal migration

The reusable `<slicc-terminal>` component now uses `@wterm/dom@0.5.4` with
`@wterm/ghostty@0.5.4`. Ghostty is required for the [Kitty graphics support
merged in wterm PR #123](https://github.com/vercel-labs/wterm/pull/123); wterm's
default core does not expose images. The component retains its `write`,
`writeln`, `clear`, `focus`, `fit`, and `terminal-data` API. It adopts wterm's
stylesheet in the shadow root and maps the existing terminal palette to wterm's
CSS color variables.

First mount pins an 80×24 grid (`autoResize: false`) then `fit()`s, and the WC
shell warm-loads Ghostty WASM after kernel-ready (`workbench/warm-wterm`) so the
compile cost does not land on the first Term open during tray traffic.

With `autoResize: false`, wterm's `init()` also pins the host's inline
`height` to the 24-row grid. `SliccTerminal.fit()` drops that pin before it
delegates to wterm's own `fit()`, then clamps the grid to sane bounds. Otherwise the host stays
about 424px tall and leaves a dead, unfocusable area below the grid. The
wterm grid's `white-space: pre` rows can also widen an unclamped flex ancestor.
The resize observer then refits to the wider host and adds columns, and this
repeats until there are thousands of columns and the terminal renders blank. The
`.host` uses `contain: inline-size` to stop that, and the WC shell's
`.wcui-term` chain sets `min-width: 0; overflow: hidden`.

## Visual comparison

All captures use the same `Workbench/Terminal/NpmTestRun` Storybook fixture at
1280×900. The panel is 720×360. Its dark surface intentionally stays the same
in both page themes.

| Theme | xterm.js before                                                | wterm with Ghostty after                                      |
| ----- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| Light | ![xterm light](screenshots/wterm-spike/before-xterm-light.png) | ![wterm light](screenshots/wterm-spike/after-wterm-light.png) |
| Dark  | ![xterm dark](screenshots/wterm-spike/before-xterm-dark.png)   | ![wterm dark](screenshots/wterm-spike/after-wterm-dark.png)   |

The frame, text size, ANSI accents, and line spacing remain close. The wterm
cursor appears as a solid block in this state. Its DOM rows allow native text
selection. A browser test also sends a direct Kitty RGB image to Ghostty and
checks for wterm's image canvas.

## Live webapp image

![PNG rendered in the live SLICC webapp](screenshots/wterm-spike/live-webapp-kitty.png)

[Terminal close-up](screenshots/wterm-spike/live-webapp-terminal.png)

The screenshot is from the running local webapp. The worker executed
`imgcat /tmp/wterm-graphics-demo.png`, emitted the PNG bytes, and the panel
sent them to `<slicc-terminal>` as a direct Kitty PNG transfer. Ghostty decoded
the 128×128 bundled SLICC image and wterm painted it on a canvas. The shell
remained usable; a subsequent `echo` command completed normally. The graphics
preview ignores pointer input and returns focus to the shell prompt after rendering.

For a repeatable local run, build the webapp and launch a local-worker dev
instance with `WORKER_BASE_URL`. Open the Terminal panel with
`?wterm-image-demo=1` on the app URL. The flag writes the bundled PNG to the
virtual `/tmp` and executes `imgcat` through the worker shell. An ordinary
`imgcat path.png` follows the same preview route without the flag.

## Interactive shell

The running shell in `packages/webapp/src/kernel/remote-terminal-view.ts`
uses the same Ghostty-backed `<slicc-terminal>` component as the PNG preview.
`terminal-line-editor.ts` handles input, cursor movement, in-memory history,
prompt redraw, and completion. The webapp no longer depends on xterm.js or
`xterm-readline`.

To recapture these screenshots, build Storybook and run
`packages/dev-tools/tools/storybook-affected-screenshots.mjs` with
`packages/webcomponents/src/workbench/slicc-terminal.stories.ts` in the
changed-file list. The script captures both page themes at 1280×900.
