---
name: playwright-cli
description: Browse the web, interact with pages, take screenshots, extract data via the playwright-cli shell command.
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
playwright-cli open [url]                              # Open tab, returns targetId
playwright-cli tab-new [url]                           # Same as open
playwright-cli tab-close --tab=<id>                    # Close tab
playwright-cli goto --tab=<id> <url>                   # Navigate tab
playwright-cli snapshot --tab=<id> [--filename=path]   # Accessibility tree with refs
playwright-cli eval --tab=<id> <expression>            # Evaluate JS in tab
playwright-cli resize --tab=<id> <width> <height>      # Resize viewport
```

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
```

To view a screenshot yourself, use `open --view <path>` after taking it.

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

## Tips

- **Refs change after every interaction** — always re-snapshot before clicking or filling.
- `open` and `tab-new` open tabs in the **background** by default. Capture the targetId from the output.
- After `click`, `fill`, `goto`, `go-back`, `go-forward`, `reload`, `select`, `check`, `uncheck`, `drag`, or `dialog-*`, take a fresh `snapshot --tab=<id>` before using refs again.
- Unexpected JavaScript dialogs are auto-dismissed on attached pages.
- Use `eval --tab=<id>` for DOM operations not covered by built-in commands.
- The SLICC app tab and Chrome internal UI tabs are automatically excluded from `tab-list`.
- `fill` clears and types into regular inputs, textareas, and `contenteditable` elements.
- Screenshots default to `/tmp/screenshot-<timestamp>.png`. Use `--filename=path` to save elsewhere.
