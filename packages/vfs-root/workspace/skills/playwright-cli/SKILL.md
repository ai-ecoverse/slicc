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

## Common Failure Modes

- `--tab <targetId> is required` — you forgot `--tab=<id>`. Run `tab-list` to get IDs.
- `No snapshot available` — run `snapshot --tab=<id>` before using refs.
- Refs are tied to **one tab + one snapshot**. They do not carry across tabs, navigations, or reloads.

## Element Refs

Snapshots assign short ref IDs (`e1`, `e2`, ...) to interactive elements. Use these refs with `click`, `fill`, `dblclick`, `hover`, `select`, `check`, `uncheck`, `drag`, and `screenshot`.

Refs are invalidated after any state-changing command. Always re-snapshot to get fresh refs.

## Commands

All commands below that operate on a tab require `--tab=<targetId>`.

### Core

```bash
playwright-cli open [url] [--foreground]               # Open tab (background by default), returns targetId
playwright-cli tab-new [url] [--foreground]            # Same as open
playwright-cli tab-close --tab=<id>                    # Close tab
playwright-cli goto --tab=<id> <url>                   # Navigate tab
playwright-cli navigate --tab=<id> <url>               # Alias for goto
playwright-cli snapshot --tab=<id> [--filename=path]   # Accessibility tree with refs
playwright-cli snapshot --tab=<id> --no-iframes        # Skip iframe content (faster)
playwright-cli eval --tab=<id> <expression>            # Evaluate JS in tab
playwright-cli eval-file --tab=<id> <vfs-path>         # Evaluate JS from a VFS file
playwright-cli frames --tab=<id>                       # List iframes in the page
playwright-cli resize --tab=<id> <width> <height>      # Resize viewport
```

`--foreground` (or `--fg`) opens the new tab focused instead of in the background.

### Interaction

```bash
playwright-cli click --tab=<id> <ref>              # Click element
playwright-cli dblclick --tab=<id> <ref> [button]  # Double-click
playwright-cli fill --tab=<id> <ref> <text>        # Clear input + type text
playwright-cli type --tab=<id> <text>              # Type into focused element
playwright-cli hover --tab=<id> <ref>              # Hover over element
playwright-cli select --tab=<id> <ref> <value>     # Select dropdown value
playwright-cli check --tab=<id> <ref>              # Check checkbox/radio
playwright-cli uncheck --tab=<id> <ref>            # Uncheck checkbox/radio
playwright-cli drag --tab=<id> <startRef> <endRef> # Drag and drop
playwright-cli dialog-accept --tab=<id> [text]     # Accept JS dialog
playwright-cli dialog-dismiss --tab=<id>           # Dismiss JS dialog
```

### Keyboard

```bash
playwright-cli press --tab=<id> <key>  # Press key (e.g. Enter, Tab, Escape)
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

### Screenshots

```bash
playwright-cli screenshot --tab=<id>                       # Save to /tmp/screenshot-<ts>.png
playwright-cli screenshot --tab=<id> --filename=page.png   # Save to custom path
playwright-cli screenshot --tab=<id> e5                    # Screenshot specific element
playwright-cli screenshot --tab=<id> --fullPage            # Full scrollable page
playwright-cli screenshot --tab=<id> --max-width=800       # Downscale to a max width
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

- `serve <dir>` — opens an app directory in a browser tab.
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
playwright-cli tab-list                          # List tabs with targetIds + (active) marker
playwright-cli tab-new [url]                     # New tab, returns targetId
playwright-cli tab-close --tab=<id>              # Close specific tab
```

### Cookies

```bash
playwright-cli cookie-list --tab=<id>                              # List all cookies
playwright-cli cookie-get --tab=<id> <name>                        # Get cookie
playwright-cli cookie-set --tab=<id> <name> <value> [flags]        # Set cookie
playwright-cli cookie-delete --tab=<id> <name> [--domain= --path=] # Delete cookie
playwright-cli cookie-clear --tab=<id>                              # Clear all cookies
```

### localStorage / sessionStorage

```bash
playwright-cli localstorage-list --tab=<id>
playwright-cli localstorage-get --tab=<id> <key>
playwright-cli localstorage-set --tab=<id> <key> <value>
playwright-cli localstorage-delete --tab=<id> <key>
playwright-cli localstorage-clear --tab=<id>
# Same pattern for sessionstorage-*
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
- `open` and `tab-new` open tabs in the **background** by default. Capture the targetId from the output.
- After `click`, `fill`, `goto`, `go-back`, `go-forward`, `reload`, `select`, `check`, `uncheck`, `drag`, or `dialog-*`, take a fresh `snapshot --tab=<id>` before using refs again.
- Unexpected JavaScript dialogs are auto-dismissed on attached pages.
- Use `eval --tab=<id>` for DOM operations not covered by built-in commands.
- The SLICC app tab and Chrome internal UI tabs are automatically excluded from `tab-list`.
- `fill` clears and types into regular inputs, textareas, and `contenteditable` elements.
- Screenshots default to `/tmp/screenshot-<timestamp>.png`. Use `--filename=path` to save elsewhere.

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
