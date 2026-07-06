---
name: demo-recording
description: |
  Record short demo videos of UI features using playwright-cli.
  Captures browser interactions with a visible animated cursor,
  chapter markers, and produces trimmed MP4s ready for GitHub PRs.
  Use when asked to record a UI demo, showcase a feature, or
  create a video for a pull request.
globs: 'packages/webcomponents/**,packages/webapp/src/ui/**'
---

# Demo Recording with playwright-cli

Record short (15–30s) demo videos of SLICC UI features using
`playwright-cli video-start/stop`, an injected visible cursor, and
`ffmpeg` for post-processing. Produces GitHub-embeddable MP4s.

## Quick Start

**Verify the dev URL first.** Don't assume the obvious port serves the UI —
in thin-bridge/single-page-app architectures the "app port" may serve no UI
at all (SLICC's node-server serves none; the webapp loads from a separate
UI-serving port and dials back over a bridge token in the query string, e.g.
`http://localhost:8787/?bridge=ws://localhost:5710/cdp&bridgeToken=<uuid>`).
`curl` the candidate port or check the dev script before wiring a recording
around it. See "Attaching to a Single-Leader-Tab App" below if the app only
accepts one connected browser session.

```bash
# 1. Open a browser and navigate — replace with your app's real dev URL
playwright-cli open http://localhost:PORT
playwright-cli resize 1280 720

# 2. Inject the visible cursor (headless Chrome has no native cursor)
playwright-cli eval '<CURSOR_SNIPPET>'   # see § Visible Cursor below

# 3. Start recording
playwright-cli video-start /tmp/demo.webm

# 4. Perform interactions (clicks, drags, etc.)
playwright-cli click e119               # click by snapshot ref
playwright-cli run-code --filename /tmp/demo-script.js

# 5. Stop recording
playwright-cli video-stop

# 6. Convert + trim with ffmpeg
ffmpeg -y -ss 2 -t 18 -i /tmp/demo.webm \
  -c:v libx264 -preset fast -crf 20 \
  -pix_fmt yuv420p -movflags +faststart \
  /tmp/demo.mp4
```

## Visible Cursor

Headless Chrome renders no mouse pointer. Inject a fake SVG cursor
that you position via `window.__mc(x, y)` during the demo:

```bash
playwright-cli eval '(() => { var c = document.createElement("div"); c.id = "fake-cursor"; c.style.cssText = "position:fixed;width:24px;height:24px;z-index:999999;pointer-events:none;display:none;"; c.innerHTML = "<svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><path d=\"M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 01.35-.15h6.87a.5.5 0 00.35-.85L6.35 2.86a.5.5 0 00-.85.35z\" fill=\"#111\" stroke=\"#fff\" stroke-width=\"1.5\"/></svg>"; document.body.appendChild(c); window.__mc = function(x, y) { c.style.left = x + "px"; c.style.top = y + "px"; c.style.display = "block"; }; window.__hc = function() { c.style.display = "none"; }; return "cursor ready"; })()'
```

- `window.__mc(x, y)` — move cursor to position (display it)
- `window.__hc()` — hide cursor

## Attaching to a Single-Leader-Tab App

Some apps only support one connected browser session per backend instance
(e.g. SLICC's standalone thin-bridge: one Chrome tab is "the leader" for a
given bridge token). `playwright-cli open <url>` launches an independent
browser — pointing it at a URL someone else's session already owns creates
two competing clients on the same channel, not a second view.

**Recording without disturbing a live session:** spin up an isolated
instance of the app's own dev stack on different ports, then attach
`playwright-cli` to that instance's browser instead of opening a new one:

```bash
# 1. Launch Chrome yourself with a FIXED (non-zero) CDP port
"$CHROME_BIN" --remote-debugging-port=9522 --no-first-run \
  --user-data-dir="$(mktemp -d)" about:blank &

# 2. Start the app's own dev server(s) on unused ports, pointed at that
#    fixed CDP port if the framework supports reusing an external browser
#    (check for a "--serve-only" / "--attach" / "--external-cdp" style flag
#    before assuming you must launch its browser too)

# 3. Grab the real websocket endpoint from the profile dir Chrome just
#    wrote (needed because `--remote-debugging-port=0` is otherwise auto-picked)
cat "$USER_DATA_DIR/DevToolsActivePort"   # port on line 1, ws path on line 2

# 4. Attach playwright-cli's tooling (video, run-code, etc.) to that SAME
#    browser instead of launching a new one
playwright-cli attach --cdp "ws://127.0.0.1:9522/devtools/browser/<uuid>"
playwright-cli goto "http://localhost:<app-ui-port>/?<app-specific-auth-params>"
```

This keeps the recording fully isolated — the original session's ports,
tabs, and state are never touched. Tear down the isolated Chrome/dev-server
processes when done (`kill` by the PIDs you started, or by the ports you
picked) — they're throwaway infrastructure, not the user's environment.

## Clipboard Interactions

Reading a value with `navigator.clipboard.readText()` proves what's in the
clipboard, but inserting it with `page.keyboard.type(value)` is **simulated
typing, not a paste** — visually similar, technically a different action. If
the demo is specifically about a copy/paste feature, do a real paste:

```js
// Once, before interacting with the composer:
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
  origin: 'http://localhost:PORT', // must match the page's actual origin
});

// Later, in the recording script:
await composer.click();
await page.keyboard.press('Meta+V'); // 'Control+V' on non-Mac targets
```

Without `grantPermissions`, both `readText()` and a real `Meta+V` paste can
hang waiting on a permission prompt that never resolves headlessly.

## Recording Script Pattern

For complex demos with animated drags or multi-step flows, write a
`run-code` script file. The function receives `page` (Playwright Page):

```js
// /tmp/demo-script.js
async (page) => {
  const wait = (ms) => page.waitForTimeout(ms);

  // Click a button by accessible name
  await page.getByRole('button', { name: 'Terminal' }).click();
  await wait(1500);

  // Move the visible cursor
  await page.evaluate(([x, y]) => window.__mc(x, y), [400, 300]);
  await wait(300);

  // Animate a smooth cursor move
  for (let i = 0; i <= 20; i++) {
    const x = 400 + (700 - 400) * (i / 20);
    await page.evaluate(([px, py]) => window.__mc(px, py), [x, 300]);
    await wait(25);
  }

  // Hide cursor at end
  await page.evaluate(() => window.__hc());
};
```

Run it:

```bash
playwright-cli run-code --filename /tmp/demo-script.js
```

## Key Gotchas

### Scripts must be self-contained

Always inject the cursor **inside** the `run-code` script, not in a
prior `playwright-cli eval`. If the page URL changes (e.g., switching
workbench surfaces updates `?ws=` via `replaceState`), `window.__mc`
survives. But a full reload wipes it. Putting injection at the top of
every script makes it idempotent:

```js
async (page) => {
  // Always re-inject — idempotent, safe to call multiple times
  await page.evaluate(() => {
    const old = document.getElementById('fake-cursor');
    if (old) old.remove();
    const c = document.createElement('div');
    c.id = 'fake-cursor';
    c.style.cssText =
      'position:fixed;width:24px;height:24px;z-index:999999;pointer-events:none;display:none;';
    c.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 01.35-.15h6.87a.5.5 0 00.35-.85L6.35 2.86a.5.5 0 00-.85.35z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>';
    document.body.appendChild(c);
    window.__mc = (x, y) => {
      c.style.left = x + 'px';
      c.style.top = y + 'px';
      c.style.display = 'block';
    };
    window.__hc = () => {
      c.style.display = 'none';
    };
  });
  // ... rest of script
};
```

### Reset page/component state before recording

Component state persists between recording takes. If a previous run
expanded a tree node or left a file selected, the next run will start
in that state — shifting all coordinates and breaking the script. Reset
before recording:

```js
// Example: ensure a file tree starts clean
await page.evaluate(() => {
  const ft = document.querySelector('slicc-file-tree');
  if (ft && ft.isDirOpen('/workspace/skills')) ft.toggleDir('/workspace/skills');
});
```

Always verify state with a measurement eval before starting the
recording, especially when re-taking a failed demo.

### Combine `page.mouse.move` with `window.__mc` for hover events

The visible cursor and the real browser pointer are independent.
`page.evaluate(() => window.__mc(x, y))` only moves the SVG — it does
NOT fire `pointerover`/`pointermove` events on page elements. Always
drive both together in the `moveTo` loop:

```js
async function moveTo(tx, ty, steps = 14, delay = 18) {
  const p = await page.evaluate(() => {
    const c = document.getElementById('fake-cursor');
    return { x: parseInt(c.style.left || '640'), y: parseInt(c.style.top || '360') };
  });
  for (let i = 1; i <= steps; i++) {
    const nx = p.x + (tx - p.x) * (i / steps);
    const ny = p.y + (ty - p.y) * (i / steps);
    await page.evaluate((v) => window.__mc(v[0], v[1]), [nx, ny]);
    await page.mouse.move(nx, ny); // ← fires real pointerover/hover
    await wait(delay);
  }
}
```

Without `page.mouse.move`, hover-triggered UI (dropdown buttons,
tooltips, action overlays) will not appear on screen.

**Don't also call `.locator().hover()` or `.locator().click()` alongside a
manual `moveTo` loop.** Playwright's own actionability pre-checks (visible,
stable, "receives events") run independently of your animation and can fail
intermittently — "element is not visible" / "X intercepts pointer events" —
even though the element is plainly on screen. Once you're driving the cursor
yourself, commit to it: use `page.mouse.click(x, y)` at the coordinates you
already animated to, not the locator-based click/hover helpers.

### Prefer CSS selectors over snapshot refs for apps with periodic re-renders

`playwright-cli snapshot`-derived `ref=...` IDs go stale the moment the
underlying DOM node is replaced. If the app rebuilds parts of its UI on a
timer (polling, live-refresh panels), a ref captured even a few seconds
earlier can point at a detached node, failing with "Ref not found in the
current page snapshot." A CSS/attribute selector (`page.locator('[data-id="..."]')`)
re-resolves against the live DOM on every call and doesn't have this problem
— use selectors for anything you'll interact with more than once per script.

### Native dialogs (`confirm`/`prompt`) in attached CDP sessions

`page.once('dialog', async (d) => await d.accept(...))` registered inside a
`run-code` script is NOT reliably intercepted when attached via
`playwright-cli attach --cdp` — the CLI's own dialog tracking can surface it
as a pending "Modal state" instead, and the triggering `run-code` call
returns without finishing. Don't chase this inside the script. Instead:

```bash
# 1. Trigger the action that opens the dialog
playwright-cli run-code --filename open-dialog-step.js
# 2. Resolve it as a separate command
playwright-cli dialog-accept "typed value"   # or: playwright-cli dialog-dismiss
# 3. Verify the app's actual state changed — don't trust the CLI's own
#    "already handled" / "Modal state" messages as proof of success
playwright-cli eval '...check the DOM reflects the action...'
```

If you see "Cannot accept dialog which is already handled" that's fine — it
means an in-script handler beat you to it. If a _later_ command reports a
NEW pending "Modal state" you didn't expect, dialogs can queue; drain them
with repeated `dialog-dismiss`/`dialog-accept` calls before continuing.

### `video-start`'s live screencast can silently render panels as solid grey

The CDP screencast behind `video-start` is a different rendering path than
`page.screenshot()`, and can fail to composite certain panels — rendering
them as a flat color for the _entire recording_ while the rest of the page
looks fine. This is easy to miss at a glance and will ruin a recording whose
whole point is that panel. **Verify before trusting a `video-start` take:**
extract one frame and compare it to a `page.screenshot()` taken at the same
moment; if the panel is blank/flat in the video frame but populated in the
screenshot, `video-start` isn't usable for this recording.

**Fallback: screenshot-sequence recording.** `page.screenshot()` always
renders correctly, so build the video from a sequence of screenshots
instead of a live capture:

```js
// Inside the run-code script: snap(N) takes ONE screenshot but reserves N
// index slots, so the gap to the next frame encodes how long to hold it.
let fc = 0;
async function snap(page, holdFrames = 1) {
  const n = ++fc;
  await page.screenshot({ path: `/tmp/frames/frame_${String(n).padStart(5, '0')}.png` });
  fc += holdFrames - 1;
}
// snap(page, 1) during cursor movement, snap(page, 10-30) to hold a result
```

```python
# Build an ffmpeg concat playlist from the actual files present (gaps = hold
# duration in units of BASE seconds), then encode — handles the numbering
# gaps `snap()` leaves behind:
import os, re
d = '/tmp/frames'
entries = sorted((int(re.match(r'frame_(\d+)\.png', f).group(1)), f) for f in os.listdir(d))
BASE = 0.09
lines = []
for i, (n, f) in enumerate(entries):
    gap = (entries[i + 1][0] - n) if i + 1 < len(entries) else 20
    lines += [f"file '{d}/{f}'", f'duration {max(gap, 1) * BASE:.3f}']
lines.append(f"file '{d}/{entries[-1][1]}'")  # concat demuxer quirk: repeat last file, no duration
open('/tmp/concat.txt', 'w').write('\n'.join(lines) + '\n')
```

```bash
ffmpeg -y -f concat -safe 0 -i /tmp/concat.txt \
  -vsync vfr -pix_fmt yuv420p -vf "fps=30,scale=1280:800" \
  -c:v libx264 -preset fast -crf 19 -movflags +faststart \
  /tmp/demo.mp4
```

### `--size` for `video-start`

`playwright-cli video-start` defaults to fitting the video within 800×800.
If your actual viewport is larger (e.g. 1280×800), the output is scaled down
and padded with a dead margin. Always pass `--size` matching the real
viewport: `playwright-cli video-start out.webm --size "1280x800"`.

### CDP mouse events vs Pointer Events

`page.mouse.down()` dispatches CDP-level mouse events. These do NOT
reliably engage `setPointerCapture()` — if the target uses Pointer
Events with capture (like a drag handle), the drag won't work.

**Workaround**: use `page.evaluate()` to dispatch `PointerEvent`
directly on the element for the functional behavior, and use
`page.evaluate()` with `window.__mc()` for the visual cursor:

```js
// Dispatch a real PointerEvent for the handler
await page.evaluate(
  ([cx, cy]) => {
    const el = document.querySelector('.my-drag-handle');
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: cx,
        clientY: cy,
        pointerId: 1,
        button: 0,
        bubbles: true,
      })
    );
  },
  [x, y]
);
// Move the visible cursor in sync
await page.evaluate((v) => window.__mc(v[0], v[1]), [x, y]);
```

### Timing estimates drift — verify with frame screenshots

Script timing is cumulative and unpredictable: `page.evaluate`
overhead, animation frames, and async VFS calls all add invisible
latency. **Never trust timing math alone.** The correct workflow:

1. Record the raw webm
2. Convert to mp4
3. Extract frames at estimated timestamps:
   ```bash
   for ts in 1.5 3.0 5.5 9.0; do
     frame=$(echo "$ts * 25" | bc | cut -d. -f1)
     ffmpeg -y -i demo.mp4 -vf "select=eq(n\,${frame})" -vframes 1 /tmp/check_${ts}.png -loglevel quiet
   done
   ```
4. Read each frame image — adjust timestamps based on what's actually visible
5. Only then add overlays/toasts

### Timing

- `page.waitForTimeout(ms)` — use this in `run-code` scripts
  (`setTimeout` is not available in Playwright's Node context)
- Keep pauses short (200–400ms between actions) for a snappy demo
- Add 1–1.5s holds after each major state change so viewers can see it
- Total target: 15–30s — shorter is better for PR embeds

### Video format

- `playwright-cli video-start` produces `.webm` (VP8)
- GitHub PR embeds require `.mp4` (H.264) — always convert with ffmpeg
- Use `-movflags +faststart` for instant playback in browsers
- Crop banners/chrome: `-vf "crop=iw:ih-18:0:18"`

## Chapter Markers

Add chapter markers for longer recordings (visible in the Playwright
dashboard, useful for debugging timing):

```bash
playwright-cli video-chapter "Panel opened"
# ... interactions ...
playwright-cli video-chapter "Resize complete"
```

## Action Annotations

`video-show-actions` overlays a callout on each subsequent CLI action
with the action name and a pointer animation between targets:

```bash
playwright-cli video-show-actions --cursor pointer --duration 500
```

This is useful for simple click/type flows but does NOT show custom
`page.evaluate()` interactions. For complex demos (drags, animated
sequences), use the manual cursor approach above.

## Post-Processing with ffmpeg

```bash
# Convert webm → mp4
ffmpeg -y -i demo.webm -c:v libx264 -preset fast -crf 20 \
  -pix_fmt yuv420p -movflags +faststart demo.mp4

# Trim to 15s starting at 5s mark
ffmpeg -y -ss 5 -t 15 -i demo.webm ... demo.mp4

# Crop top 18px (remove a banner)
ffmpeg -y -i demo.webm -vf "crop=iw:ih-18:0:18" ... demo.mp4

# All together
ffmpeg -y -ss 5 -t 15 -i demo.webm \
  -vf "crop=iw:ih-18:0:18" \
  -c:v libx264 -preset fast -crf 20 \
  -pix_fmt yuv420p -movflags +faststart \
  demo.mp4
```

## Text Overlays / Chapter Toasts

`ffmpeg`'s `drawtext` filter requires freetype, which may not be
compiled in. Check first: `ffmpeg -filters 2>/dev/null | grep drawtext`.
If missing, use Python + OpenCV + Pillow instead.

### Freeze-frame toast pattern (Python)

Insert a static freeze at key moments with a text overlay — much more
reliable than trying to match exact timestamps to fast-moving content.
The workflow:

1. **Extract verification frames** at estimated timestamps (see timing section above)
2. **Identify the right freeze frame** for each section by reading the PNGs
3. **Run the script** to insert freezes and overlay text

```python
# /tmp/add_toasts.py
import cv2, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont

INPUT  = "/tmp/demo.mp4"
OUTPUT = "/tmp/demo-toasts.mp4"

# (original_video_time_s, freeze_duration_s, text) — ASCII only, no Unicode arrows/dots
FREEZE = [
    (1.2, 1.5, "Files panel - folder icons, file sizes, navigation"),
    (3.0, 1.5, "Hover a file - action buttons appear"),
    (6.0, 2.0, "Click CAT - file opens in terminal"),
]
FONT_SIZE = 15; PAD_X = 16; PAD_Y = 9; MARGIN_BOT = 38; FADE = 0.20

cap = cv2.VideoCapture(INPUT)
FPS = cap.get(cv2.CAP_PROP_FPS)
W   = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
H   = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", FONT_SIZE)
except Exception:
    font = ImageFont.load_default()

frames = []
while True:
    ok, f = cap.read()
    if not ok: break
    frames.append(f)
cap.release()

def draw_toast(frame_bgr, text, alpha):
    img = Image.fromarray(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)).convert("RGBA")
    ov  = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d   = ImageDraw.Draw(ov)
    bb  = d.textbbox((0, 0), text, font=font)
    tw, th = bb[2]-bb[0], bb[3]-bb[1]
    bx = (W - tw)//2 - PAD_X; by = H - MARGIN_BOT - th - PAD_Y*2
    d.rounded_rectangle([bx, by, bx+tw+PAD_X*2, by+th+PAD_Y*2], radius=6,
                        fill=(20, 20, 20, int(180*alpha)))
    d.text((bx+PAD_X, by+PAD_Y), text, font=font, fill=(255, 255, 255, int(240*alpha)))
    return cv2.cvtColor(np.array(Image.alpha_composite(img, ov).convert("RGB")), cv2.COLOR_RGB2BGR)

output_frames = []
freeze_specs  = [(int(t * FPS), int(dur * FPS), txt) for t, dur, txt in FREEZE]
prev_src = 0
for (orig_idx, n_freeze, txt) in freeze_specs:
    for i in range(prev_src, min(orig_idx, len(frames))):
        output_frames.append((frames[i], None, None))
    ff = frames[min(orig_idx, len(frames)-1)]
    fade_f = int(FADE * FPS)
    for j in range(n_freeze):
        a = j/fade_f if j < fade_f else (n_freeze-j)/fade_f if j > n_freeze-fade_f else 1.0
        output_frames.append((ff, txt, max(0.0, min(1.0, a))))
    prev_src = orig_idx
for i in range(prev_src, len(frames)):
    output_frames.append((frames[i], None, None))

cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-vcodec", "rawvideo",
       "-s", f"{W}x{H}", "-pix_fmt", "rgb24", "-r", str(FPS), "-i", "pipe:0",
       "-c:v", "libx264", "-preset", "fast", "-crf", "20",
       "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUTPUT]
proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
for frame_bgr, txt, alpha in output_frames:
    out = draw_toast(frame_bgr, txt, alpha) if txt and alpha and alpha > 0.01 else frame_bgr
    proc.stdin.write(cv2.cvtColor(out, cv2.COLOR_BGR2RGB).tobytes())
proc.stdin.close(); proc.wait()
```

**Important:** Use ASCII-only text — Unicode arrows (`→`), dots (`·`),
and em-dashes (`—`) render as empty squares with Helvetica.ttc in PIL.
Use `-` and `->` instead.

## Embedding in GitHub PRs

GitHub auto-embeds `.mp4` URLs from `user-attachments` as inline
`<video>` players. The upload requires the web UI:

1. Edit the PR description on github.com
2. Drag-and-drop the `.mp4` file into the text area
3. GitHub uploads it and inserts a
   `https://github.com/user-attachments/assets/...` URL
4. That bare URL on its own line renders as an embedded video player

There is no programmatic upload path — the `user-attachments` endpoint
requires browser session authentication (not API tokens).

## Full Example: Resize Demo

```js
// /tmp/resize-demo.js — records the side panel resize feature
async (page) => {
  const wait = (ms) => page.waitForTimeout(ms);

  // Get layout dimensions
  const dims = await page.evaluate(() => {
    const s = document.querySelector('slicc-shell');
    const b = s.getBoundingClientRect();
    return { left: b.left, width: b.width, top: b.top, height: b.height };
  });
  const avail = dims.width - 48;
  const midY = dims.top + dims.height / 2;

  // Helper: animate cursor + dispatch resize events
  async function drag(fromFrac, toFrac) {
    const sx = dims.left + avail * fromFrac;
    const tx = dims.left + avail * toFrac;

    // Approach cursor
    for (let i = 0; i <= 6; i++) {
      const x = sx - 30 + 30 * (i / 6);
      await page.evaluate(([px, py]) => window.__mc(px - 4, py - 2), [x, midY]);
      await wait(20);
    }
    await wait(150);

    // Start drag
    await page.evaluate(
      ([cx, cy]) => {
        const d = document.querySelector('.slicc-shell__divider');
        d.dispatchEvent(
          new PointerEvent('pointerdown', {
            clientX: cx,
            clientY: cy,
            pointerId: 1,
            button: 0,
            bubbles: true,
          })
        );
      },
      [sx, midY]
    );

    // Animate drag
    for (let i = 0; i <= 30; i++) {
      const x = sx + (tx - sx) * (i / 30);
      await page.evaluate(([px, py]) => window.__mc(px - 4, py - 2), [x, midY]);
      await page.evaluate(
        ([cx, cy]) => {
          const d = document.querySelector('.slicc-shell__divider');
          d.dispatchEvent(
            new PointerEvent('pointermove', {
              clientX: cx,
              clientY: cy,
              pointerId: 1,
              bubbles: true,
            })
          );
        },
        [x, midY]
      );
      await wait(25);
    }

    // End drag
    await page.evaluate(
      ([cx, cy]) => {
        const d = document.querySelector('.slicc-shell__divider');
        d.dispatchEvent(
          new PointerEvent('pointerup', {
            clientX: cx,
            clientY: cy,
            pointerId: 1,
            bubbles: true,
          })
        );
      },
      [tx, midY]
    );
  }

  // Open terminal panel
  await page.getByRole('button', { name: 'Terminal' }).click();
  await wait(1500);

  // Drag wider → narrower → reset
  await drag(0.75, 0.55);
  await wait(1000);
  await drag(0.55, 0.22);
  await wait(1000);
  await drag(0.22, 0.48);
  await wait(500);

  // Double-click to reset
  await page.evaluate(() => {
    document
      .querySelector('.slicc-shell__divider')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await wait(1000);
  await page.evaluate(() => window.__hc());
};
```

Orchestration:

```bash
playwright-cli open http://localhost:PORT
playwright-cli resize 1280 720
playwright-cli eval '<CURSOR_SNIPPET>'
playwright-cli video-start /tmp/resize-demo.webm --size "1280x720"
playwright-cli run-code --filename /tmp/resize-demo.js
playwright-cli video-stop
ffmpeg -y -i /tmp/resize-demo.webm \
  -c:v libx264 -preset fast -crf 20 \
  -pix_fmt yuv420p -movflags +faststart \
  /tmp/resize-demo.mp4
```
