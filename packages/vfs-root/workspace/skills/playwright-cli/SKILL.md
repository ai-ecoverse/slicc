---
name: playwright-cli
description: |
  Use this whenever the user asks to browse, navigate, click, fill a form,
  scrape, take a screenshot, or otherwise interact with a web page. SLICC drives
  the browser through the `playwright-cli` shell command (also aliased as
  `playwright` and `puppeteer`). Read this BEFORE running any browser
  automation: every tab-operating command requires a `--tab` target id, and
  multi-agent tab handling has rules you must follow.
allowed-tools: bash
---

# Browser Automation via playwright-cli

Use `playwright-cli` (also aliased as `playwright` and `puppeteer`) via the bash tool for all browser automation.

**Every tab-operating command requires `--tab=<targetId>`.** There is no implicit "current tab". Always specify which tab you're operating on.

`playwright-cli <command> --help` prints that command's usage and does nothing else — safe to run before any action.

## Quick Start

```bash
# 1. Open a page — note the targetId in the output
playwright-cli open https://example.com
# Output: Opened https://example.com in new tab [targetId: E9A3F...]

# 2. Take a snapshot to see the page structure and get element refs
playwright-cli snapshot --tab=E9A3F

# 3. Interact using refs from the snapshot (e.g. e5, e12)
playwright-cli click --tab=E9A3F e5
playwright-cli fill --tab=E9A3F e12 "hello world"

# 4. Re-snapshot after interactions (refs change)
playwright-cli snapshot --tab=E9A3F
```

## Tab IDs

- `tab-list` shows all tabs with their targetIds. The user's active tab is marked `(active)`.
- `tab-new` / `open` return the new tab's targetId — capture it for subsequent commands.
- Use `--tab=<targetId>` on ALL commands that operate on a tab.

## Frame IDs

- `frames --tab=<targetId>` lists frame IDs. A frame ID is not a tab target ID; never pass it to `--tab`.
- Use `--tab=<targetId> --frame=<frameId>` with `eval`, `eval-file`, or `snapshot` to target a child frame, including cross-origin frames.
- A frame-scoped `snapshot` prints only that frame's accessibility subtree. Its frame-prefixed refs work with `click`, `fill`, `dblclick`, `hover`, `select`, `check`, and `uncheck`; do not pass `--frame` to those commands. Other ref commands require refs from a top-level snapshot.

## Common Failure Modes

- `--tab <targetId> is required` — you forgot `--tab=<id>`. Run `tab-list` to get IDs.
- `is a frame ID, not a tab target ID` — keep the owning tab's targetId in `--tab` and pass the frame ID with `--frame`.
- `No snapshot available` — run `snapshot --tab=<id>` before using refs.
- `unknown flag "--x"` / `unexpected argument "y"` — every subcommand rejects arguments it does not
  support, so an exit code of 0 means everything you passed was honoured. Check `<verb> --help`.
- For free-text payloads that start with `-` (e.g. `fill`/`type`/`eval`), put `--` before the text:
  `fill --tab=<id> e1 -- --dash-looking`.
- `is not an element ref` — a screenshot's positional is a main-frame element ref (`e5`); the output
  path is `--filename=<path>`. Frame-prefixed refs (`f1e5`) clip only with `click`-family commands.
- Refs are tied to **one tab + one snapshot**. They do not carry across tabs, navigations, or reloads.

## Element Refs

Snapshots assign short ref IDs (`e1`, `e2`, ...) to interactive elements. Use these refs with `click`, `fill`, `dblclick`, `hover`, `select`, `check`, `uncheck`, `drag`, `upload`, `drop`, and `screenshot`.

Refs are invalidated after any state-changing command. Always re-snapshot to get fresh refs.

## Commands

All commands below that operate on a tab require `--tab=<targetId>`.

### Core

```bash
playwright-cli open [url] [--foreground]                          # Open tab (background by default), returns targetId
playwright-cli tab-new [url] [--foreground]                       # Same as open
playwright-cli tab-close --tab=<id>                               # Close tab
playwright-cli goto --tab=<id> <url>                              # Navigate tab
playwright-cli navigate --tab=<id> <url>                          # Alias for goto
playwright-cli snapshot --tab=<id> [--frame=<frameId>] [--no-iframes] [--filename=path]  # Tab tree or one frame subtree
playwright-cli eval --tab=<id> [--frame=<frameId>] <expression> [--filename=path]  # Evaluate JS in a tab/frame, incl. top-level await/return; use `--` before an expression that starts with `-`
playwright-cli eval-file --tab=<id> [--frame=<frameId>] <vfs-path>  # Evaluate JS from a VFS file in a tab/frame (top-level await/return supported)
playwright-cli frames --tab=<id>                                  # List frame IDs for --frame (not --tab)
playwright-cli resize --tab=<id> <width> <height>                 # Resize viewport
```

`--foreground` (or `--fg`) opens the new tab **in the foreground** — it brings the
new tab to the front and switches the user's visible/active tab to it, instead of
opening in the background.

**Bringing a tab to the foreground (activate / focus / raise / switch to a tab):**

- **New tab** → `open <url> --foreground` (or `tab-new <url> --fg`).
- **Existing tab** → `tab-select <index>` (1-based index from `tab-list`).

These two are the ONLY ways to change which tab is in front. There is no
`activate`, `bring-to-front`, or `focus` subcommand, and `eval`-ing
`window.focus()` does NOT work (browsers block a page from stealing foreground).
If a tab didn't come to the front, re-run `tab-select` / `--foreground` — do not
fall back to `window.focus()`.

### Interaction

```bash
playwright-cli click --tab=<id> <ref> [--modifiers=Shift,Control,Alt,Meta]  # Click element
playwright-cli dblclick --tab=<id> <ref> [button] [--modifiers=...]          # Double-click
playwright-cli fill --tab=<id> <ref> <text> [--submit]           # Clear input + type text (--submit presses Enter); use `--` before text that starts with `-`
playwright-cli type --tab=<id> <text> [--submit]                 # Type into focused element (--submit presses Enter); use `--` before text that starts with `-`
playwright-cli hover --tab=<id> <ref>                            # Hover over element
playwright-cli select --tab=<id> <ref> <value>                   # Select dropdown value
playwright-cli check --tab=<id> <ref>                            # Check checkbox/radio
playwright-cli uncheck --tab=<id> <ref>                          # Uncheck checkbox/radio
playwright-cli drag --tab=<id> <startRef> <endRef>               # Drag and drop
playwright-cli upload --tab=<id> [ref] <file> [file...]          # Upload VFS files to file input (optional ref targets hidden inputs)
playwright-cli drop --tab=<id> <ref> [--path=<vfs-path>] [--data=<mime/type=value>]  # Drop files/data onto element
playwright-cli dialog-accept --tab=<id> [text]                   # Accept JS dialog
playwright-cli dialog-dismiss --tab=<id>                         # Dismiss JS dialog
```

### Keyboard

```bash
playwright-cli press --tab=<id> <key>    # Press key (keyDown + keyUp, e.g. Enter, Tab, Escape)
playwright-cli keydown --tab=<id> <key>  # Hold key down (no paired keyUp)
playwright-cli keyup --tab=<id> <key>    # Release held key (no paired keyDown)
```

### Mouse

```bash
playwright-cli mousemove --tab=<id> <x> <y>    # Move mouse to coordinates (negative coords ok, e.g. -10 20)
playwright-cli mousedown --tab=<id> [button]   # Press mouse button (left/right/middle, default: left)
playwright-cli mouseup --tab=<id> [button]     # Release mouse button
playwright-cli mousewheel --tab=<id> <dx> <dy> # Scroll mouse wheel (negative deltas ok, e.g. 0 -300)
```

### Navigation

```bash
playwright-cli go-back --tab=<id>     # history.back()
playwright-cli go-forward --tab=<id>  # history.forward()
playwright-cli reload --tab=<id>      # Reload page
```

### Teleport

```bash
playwright-cli teleport --tab=<id> --start=<regex> --return=<regex> [--timeout=<s>]
playwright-cli teleport --list                                                    # List available follower runtimes
playwright-cli teleport --off --tab=<id>                                          # Cancel a teleport on this tab
playwright-cli open <url> --teleport-start=<regex> --teleport-return=<regex>
playwright-cli goto --tab=<id> <url> --teleport-start=<regex> --teleport-return=<regex>
```

Teleport is for leader/follower tray auth handoffs. Scoped to a specific tab — only commands targeting the teleporting tab are blocked; other tabs remain operational.

`--runtime` is optional: without it, teleport picks the most recently active eligible follower (preferring standalone floats). Only followers that can actually serve cookies are eligible — cherry hosts, exec-only CLI followers, and any target advertising `network: false` are excluded, so a teleport fails fast instead of "succeeding" with zero cookies.

### Screenshots

```bash
playwright-cli screenshot --tab=<id>                             # Save to /tmp/screenshot-<ts>.png
playwright-cli screenshot --tab=<id> --filename=page.png         # Save to custom path
playwright-cli screenshot --tab=<id> e5                          # Clip to an element (positional = MAIN-FRAME ref, not a path)
playwright-cli screenshot --tab=<id> --fullPage                  # Full scrollable page (alias: --full-page)
playwright-cli screenshot --tab=<id> --max-width=800             # Downscale to a max width
```

An element screenshot (`screenshot e5`) returns **that element's crop or fails**
(exit 1) — typically because the snapshot went stale after a navigation or
layout change. Re-run `snapshot` and retry with a fresh ref; it never silently
substitutes a full-viewport frame.

A `resize` sticks to its tab: the viewport override is re-applied automatically
whenever the tab is re-attached, so another driver switching tabs cannot reset
it.

All playwright-cli commands share one browser and run **serialized**. When
concurrent callers (e.g. parallel scoops) queue up, commands may emit a
`note: browser bridge contended — ...` line on stderr with the total lock wait
and queue depth — treat it as a signal to stagger callers or reduce fan-out
rather than re-running commands.

### Save As

```bash
playwright-cli pdf --tab=<id> [--filename=path]  # Save page as PDF (not available in extension mode)
```

### Viewing pages and screenshots yourself

The browser displays things to the human; `open --view` is what lets _you_ see them. **But viewing screenshots is a last resort for the cone — every image you load eats a large chunk of the context window** (a single 1280×800 PNG can run 1500+ tokens, full-page screenshots much more). Reach for cheaper signals first:

1. **`playwright-cli snapshot --tab=<id>`** — text accessibility tree. Use this first; it answers "what's on the page" for almost all verification tasks at a tiny fraction of the token cost.
2. **`eval` against the DOM** — when you need a specific value (`document.title`, an attribute, computed style), `eval` it. Don't screenshot for facts you can extract.
3. **Delegate visual inspection to a scoop.** If the cone genuinely needs vision (layout regression, render fidelity, "does this look right"), spawn a scoop to take and view the screenshot — the scoop's context absorbs the tokens, and you receive its summary back. The cone's window stays clean for orchestration.
4. **`open --view` in the cone** — only when the cone itself must see pixels for its current decision and steps 1–3 won't do.

**What you CAN see:**

- `open --view <path>` — reads an image from the VFS and returns it. Works with PNG, JPEG, GIF, WebP, SVG.
- `playwright-cli screenshot --tab=<id>` + `open --view <path>` — screenshot a tab, then view it.
- `screencapture --view screenshot.png` — capture the user's screen via browser screen sharing.
- `playwright-cli snapshot --tab=<id>` — accessibility tree (text). Use to verify content without vision.

**What only the human sees:**

- `serve <dir>` — opens an app directory in a browser tab (read-only preview).
- `serve --ttl 30d <dir>` — uploads an immutable snapshot that works without the leader. TTL units are whole `m`, `h`, `d`, or `w`, capped at 30 days. It implies `--no-bridge`, conflicts with `--bridge`/`--max-tabs`, and is limited to 1,000 files, 25 MiB per file, and 50 MiB total. Use `serve --list` for mode/expiry and `serve --stop <token>` to revoke it early.
- `serve --bridge <dir>` — opens a **driveable** preview whose visitors auto-connect as live synthetic-CDP targets you can navigate/click/evaluate/screenshot via playwright. **Security: opt-in only; cross-subdomain cookie risk accepted (host-only cookies isolated; `Domain=.sliccy.now` cookies readable across previews).** Flags: `--max-tabs <N>` (default 20), `--quiet` (suppress the first-visit announcement), `--no-bridge` (force read-only), `--stop <token>` (revoke + delete webhook). Use `serve --logs [<token>] [--lines <N>]` to inspect leader-memory-only connect/disconnect records without emitting a lick or waking the cone. `serve --truncate [<token>]` clears matching records **and re-arms the first-visit announcement**, so the next visit announces once. Visitor page API: `window.slicc.emit(name, detail?)` (fires webhook lick on cone), `window.slicc.on(name, cb)` (subscribes to CustomEvents you dispatch).
- `open <path>` (no flags) — opens a file in a browser tab.
- `imgcat <path>` — displays an image in the terminal preview.

**Workflow to verify a page (when vision is actually required):**

1. `serve /workspace/app` — open the app (the human sees it).
2. `playwright-cli tab-list` — find the tab by URL, note the targetId.
3. `playwright-cli snapshot --tab=<id>` — required before screenshot, and often answers your question on its own.
4. `playwright-cli screenshot --tab=<id> --filename=/tmp/shot.png` — consider `--max-width` to keep the file small.
5. `open --view /tmp/shot.png` — now you can see it. Strongly prefer doing this from a scoop, not the cone.

**Don't:**

- Default to screenshots when a snapshot would do.
- `read_file` on a PNG or base64-encode to view images.
- `imgcat` or `cat` on screenshots expecting to see them.
- Open a screenshot then screenshot that tab.
- Use `eval` to check the active tab — use `tab-list`.

### Tab Management

```bash
playwright-cli tab-list                  # List tabs with targetIds + (active) marker
playwright-cli tab-new [url]             # New tab, returns targetId
playwright-cli tab-close --tab=<id>      # Close specific tab
playwright-cli tab-select <index>        # Select (bring to front) tab by 1-based index
```

### Cookies

```bash
playwright-cli cookie-list --tab=<id> [--domain=<d>] [--path=<p>]   # List cookies (filter by domain/path)
playwright-cli cookie-get --tab=<id> <name>                          # Get cookie
playwright-cli cookie-set --tab=<id> <name> <value> [--sameSite=Strict|Lax|None] [other flags]  # Set cookie
playwright-cli cookie-delete --tab=<id> <name> [--domain= --path=]  # Delete cookie
playwright-cli cookie-clear --tab=<id>                               # Clear all cookies
```

### Storage

```bash
playwright-cli localstorage-list --tab=<id>
playwright-cli localstorage-get --tab=<id> <key>
playwright-cli localstorage-set --tab=<id> <key> <value>
playwright-cli localstorage-delete --tab=<id> <key>
playwright-cli localstorage-clear --tab=<id>
# Same pattern for sessionstorage-*
playwright-cli state-save --tab=<id> [filename|--filename=path]  # Save cookies + localStorage to JSON
playwright-cli state-load --tab=<id> <filename>                  # Restore from state file
```

### Network

```bash
playwright-cli console --tab=<id> [min-level] [--clear]                       # List console messages (debug/log/info/warning/error)
playwright-cli requests --tab=<id> [--static] [--filter=<regex>] [--clear]    # List network requests
playwright-cli request --tab=<id> <index> [--filename=path]                   # Full request details
playwright-cli request-headers --tab=<id> <index>                             # Request headers only
playwright-cli request-body --tab=<id> <index>                                # Request body only
playwright-cli response-headers --tab=<id> <index>                            # Response headers only
playwright-cli response-body --tab=<id> <index> [--filename=path]             # Response body (saves binary to file)
playwright-cli network-state-set --tab=<id> <online|offline>                  # Toggle network state
playwright-cli route --tab=<id> <pattern> [--status=N] [--body=text] [--content-type=type] [--header=name:value]
playwright-cli route-list --tab=<id>                                          # List active routes
playwright-cli unroute --tab=<id> [pattern]                                   # Remove routes (all if no pattern)
```

### DevTools

```bash
playwright-cli generate-locator --tab=<id> <ref>              # Generate Playwright locator string for element
playwright-cli highlight --tab=<id> <ref> [--style=<css>]     # Highlight element with visual overlay
playwright-cli highlight --tab=<id> --hide [ref]              # Remove highlight (all if no ref)
```

### HAR Recording

```bash
playwright-cli record [url] [--filter=<js-expr>]  # Open tab with network recording
playwright-cli stop-recording <recordingId>        # Stop and save HAR
```

## Multi-Agent Tab Behavior

**All agents (cone + scoops) share the same tab namespace.** There is no tab isolation.

- `tab-list` shows **every** tab from every agent — yours, the cone's, other scoops'. The list can be noisy.
- Any agent can `eval`, `snapshot`, or `close` any tab — there are no ownership checks.
- Tab counts fluctuate as other agents open and close tabs concurrently.

**Best practices for scoops:**

1. **Track your own tab IDs.** When you open a tab, capture the targetId and store it. Don't rely on `tab-list` to find your tabs later — other agents' tabs will be mixed in.

   ```bash
   # Open and capture the ID
   playwright-cli tab-new https://example.com
   # Output: Opened https://example.com in new tab [targetId: ABC123...]
   # Use ABC123 for all subsequent commands on this tab
   ```

2. **NEVER close tabs you didn't open.** Tabs you don't recognize belong to the **user** or other agents. User tabs are off-limits unless the user explicitly asks you to close them. Only close tabs whose targetId you captured from your own `tab-new` / `open` calls.

3. **Handle "tab not found" gracefully.** Another agent might close a tab between your `tab-list` and your command. If you get `Error: No tab with id`, the tab is gone — move on.

4. **Don't depend on tab count or ordering.** Other agents are opening/closing tabs concurrently. Use targetIds, not positional logic.

5. **Clean up when done.** Close all tabs you opened before finishing. Include this in every scoop brief:
   _"Close each tab with `playwright-cli tab-close --tab=<id>` when done."_

## Tips

- **Refs change after every interaction** — always re-snapshot before clicking or filling.
- `open` and `tab-new` open tabs in the **background** by default. Capture the targetId from the output. To open in the **foreground** add `--foreground`/`--fg`; to raise an **already-open** tab use `tab-select <index>`.
- After `click`, `fill`, `goto`, `go-back`, `go-forward`, `reload`, `select`, `check`, `uncheck`, `drag`, or `dialog-*`, take a fresh `snapshot --tab=<id>` before using refs again.
- Unexpected JavaScript dialogs are auto-dismissed on attached pages.
- Use `eval --tab=<id>` for DOM operations not covered by built-in commands; save results with `--filename=path`.
- The SLICC app tab and Chrome internal UI tabs are automatically excluded from `tab-list`.
- `fill` clears and types into regular inputs, textareas, and `contenteditable` elements. Use `--submit` to press Enter after. If the text or an `eval` expression starts with `-`, put `--` before it so it is not parsed as a flag.
- Negative numbers for `mousewheel` / `mousemove` are positionals (no `--` needed): `mousewheel --tab=<id> 0 -300`.
- Screenshots default to `/tmp/screenshot-<timestamp>.png`. Use `--filename=path` to save elsewhere —
  `screenshot <path>` is an error, because that slot is the element ref.
- Unsupported flags and extra positionals are rejected per subcommand, so a probe that exits 0 means
  the flag was honoured — nothing is silently dropped.
- Use `keydown`/`keyup` for holding modifier keys (e.g. Shift+click: `keydown Shift`, `click`, `keyup Shift`).
- Use `requests` + `response-body` to inspect XHR/fetch responses; `route` to mock or block them.
- **Calling the app's own backend? Use `curlwright`, not `eval-file`.** It is curl's flags run by a `fetch()` inside the tab, so cookies, origin and session come along: `curlwright -s -X POST https://app.example.com/api/items -H 'X-CSRF-Token: abc' -d '{"name":"x"}' --tab=<id>`. `-o <file>` writes a **byte-exact** body, which `eval-file` cannot do at all — that is the only way to pull a binary response out of a page. Without `--tab` it uses the tab already on that origin. `curlwright --help` for the flag list.
- `state-save` / `state-load` persist auth state (cookies + localStorage) across sessions.
- `pdf` saves a print-layout PDF; not available in extension mode.

## Low-level CDP escape hatch

For raw Chrome DevTools Protocol calls that `playwright-cli` doesn't wrap, send JSON-RPC directly over WebSocket with `websocat`:

```bash
# Discover the page's debug socket URL via the CDP HTTP endpoint
curl -s http://127.0.0.1:9222/json | jq -r '.[0].webSocketDebuggerUrl'

# Send a single CDP method, receive the response, exit
echo 'Page.navigate {"url":"https://example.com"}' \
  | websocat -1 --jsonrpc --jsonrpc-omit-jsonrpc ws://127.0.0.1:9222/devtools/page/<id>
```

Run `websocat --help` for the full flag list. Use this only when `playwright-cli` has no wrapper for the CDP method you need.
