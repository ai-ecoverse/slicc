---
name: playwright-cli
description: Browse the web, interact with pages, take screenshots, extract data via the playwright-cli shell command.
allowed-tools: bash
---

# Browser Automation via playwright-cli

Use `playwright-cli` (also aliased as `playwright` and `puppeteer`) via the bash tool for all browser automation. The aliases share the same current tab, snapshots, cookies/storage context, and session history.

## Quick Start

**Always snapshot first**, then interact using element refs.

- `playwright-cli`, `playwright`, and `puppeteer` are interchangeable. Pick one prefix and stay consistent within a session so your transcript is easier to read.
- Ref-based commands operate on the **current tab only**. If you opened multiple tabs or used `open`/`tab-new` without `--foreground`, verify the target with `tab-list` and `tab-select` before using refs.

```bash
# 1. Open a page
playwright-cli open https://example.com

# 2. Take a snapshot to see the page structure and get element refs
playwright-cli snapshot

# 3. Interact using refs from the snapshot (e.g. e5, e12)
playwright-cli click e5
playwright-cli fill e12 "hello world"

# 4. Re-snapshot after interactions (refs change)
playwright-cli snapshot
```

## Common Failure Modes

- `No snapshot available` usually means you never ran `snapshot` on the current tab, the current tab changed, or a previous command invalidated the old refs.
- Refs are tied to **one tab + one snapshot**. They do not carry across tabs, navigations, reloads, or stale page states.
- `screenshot e5` is snapshot-dependent too; if it targets an element ref, run `snapshot` first.
- Auto-saved snapshots in `/.playwright/snapshots/` are for history recovery. They do **not** refresh the in-memory refs for the next command; run `snapshot` again before more ref-based actions.

## Element Refs

Snapshots assign short ref IDs (`e1`, `e2`, ..., `e15`, etc.) to interactive elements. Use these refs with `click`, `fill`, `dblclick`, `hover`, `select`, `check`, `uncheck`, `drag`, and `screenshot`.

Refs are invalidated after any state-changing command. Always re-snapshot to get fresh refs. After `go-back`, `go-forward`, or `reload`, take a fresh `snapshot` before using refs again.

## Commands

### Core

```bash
playwright-cli open [url] [--foreground|--fg]  # Open tab (default: background)
playwright-cli close                            # Close current tab
playwright-cli goto <url>                       # Navigate current tab
playwright-cli snapshot [--filename=path]       # Accessibility tree with refs
playwright-cli eval <expression>                # Evaluate JS in current tab
playwright-cli resize <width> <height>          # Resize viewport
```

### Interaction

```bash
playwright-cli click <ref>              # Click element
playwright-cli dblclick <ref> [button]  # Double-click (button: left|right|middle)
playwright-cli fill <ref> <text>        # Clear input + type text
playwright-cli type <text>              # Type into focused element
playwright-cli hover <ref>              # Hover over element
playwright-cli select <ref> <value>     # Select dropdown value
playwright-cli check <ref>              # Check checkbox/radio
playwright-cli uncheck <ref>            # Uncheck checkbox/radio
playwright-cli drag <startRef> <endRef> # Drag and drop
playwright-cli dialog-accept [text]     # Accept JS dialog (alert/confirm/prompt)
playwright-cli dialog-dismiss           # Dismiss JS dialog
```

### Keyboard

```bash
playwright-cli press <key>  # Press key (e.g. Enter, Tab, Escape, ArrowDown)
```

### Navigation

```bash
playwright-cli go-back     # history.back()
playwright-cli go-forward  # history.forward()
playwright-cli reload      # Reload page
```

### Screenshots

```bash
playwright-cli screenshot                       # Save to /tmp/screenshot-<ts>.png
playwright-cli screenshot --filename=page.png   # Save to custom path
playwright-cli screenshot e5                    # Screenshot specific element
playwright-cli screenshot --fullPage            # Full scrollable page
```

### Tab Management

```bash
playwright-cli tab-list                              # List open tabs
playwright-cli tab-new [url] [--foreground|--fg]     # New tab (default: background)
playwright-cli tab-select <index>                    # Switch to tab by index
playwright-cli tab-close [index]                     # Close tab (default: current)
playwright-cli close                                 # Close current tab
```

### Cookies

```bash
playwright-cli cookie-list                                  # List all cookies
playwright-cli cookie-get <name>                            # Get cookie by name
playwright-cli cookie-set <name> <value> [flags]            # Set cookie
#   flags: --domain=, --path=, --secure, --httpOnly, --expires=
#   when --domain/--path are omitted, the current page URL is used
playwright-cli cookie-delete <name> [--domain= --path=]     # Delete cookie
#   when --domain/--path are omitted, the current page URL is used
playwright-cli cookie-clear                                  # Clear all cookies
```

### localStorage

```bash
playwright-cli localstorage-list           # List all entries
playwright-cli localstorage-get <key>      # Get value
playwright-cli localstorage-set <key> <value>  # Set value
playwright-cli localstorage-delete <key>   # Delete entry
playwright-cli localstorage-clear          # Clear all
```

### sessionStorage

```bash
playwright-cli sessionstorage-list             # List all entries
playwright-cli sessionstorage-get <key>        # Get value
playwright-cli sessionstorage-set <key> <value>  # Set value
playwright-cli sessionstorage-delete <key>     # Delete entry
playwright-cli sessionstorage-clear            # Clear all
```

### HAR Recording

```bash
playwright-cli record [url] [--filter=<js-expr>]  # Open tab with network recording
playwright-cli stop-recording <recordingId>        # Stop and save HAR
```

The `--filter` flag takes a JS expression `(entry) => true|false|object` to filter/transform HAR entries. HAR files are saved to `/recordings/<recordingId>/`.

## Session History

Every command is automatically logged to `/.playwright/session.md`. State-changing commands such as `click`, `fill`, and `goto` also save an accessibility snapshot to `/.playwright/snapshots/`. History navigation (`go-back`, `go-forward`) and `reload` invalidate refs but do not auto-save a fresh snapshot, so run `snapshot` afterward.

### Recovering Context

After context compaction or in a new conversation, read the session history to understand what browser actions were taken:

```bash
cat /.playwright/session.md
```

This shows the full chronological log of all browser commands, their results, and links to saved snapshots.

## Tips

- **Refs change after every interaction** — always re-snapshot before clicking or filling.
- `open` and `tab-new` open tabs in the **background** by default. Use `--foreground` or `--fg` to make the new tab the current tab. If there is no current browser target yet, the first background tab becomes current so `snapshot` works right away.
- If tab focus seems to drift during a multi-step session, run `tab-list`, `tab-select <index>`, then `snapshot` before continuing.
- After `click`, `fill`, `goto`, `go-back`, `go-forward`, `reload`, `select`, `check`, `uncheck`, `drag`, or `dialog-*`, take a fresh `snapshot` before using refs again.
- Unexpected JavaScript dialogs are auto-dismissed on attached pages so a stray `alert()` does not block the session forever.
- Use `eval` for DOM operations not covered by built-in commands.
- The SLICC app tab is automatically excluded — you can't accidentally interact with it.
- The current tab is auto-selected. Use `tab-select` to switch between multiple tabs.
- `fill` clears and types into regular inputs, textareas, and `contenteditable` elements.
- Screenshots default to `/tmp/screenshot-<timestamp>.png`. Use `--filename=path` to save elsewhere.
