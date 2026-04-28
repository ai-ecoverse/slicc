---
name: sprinkles
description: Create interactive sprinkles — dashboards, forms, and visualizations
allowed-tools: bash
---

# Sprinkles

`.shtml` files in `/shared/sprinkles/` become interactive UI panels. Use them to create dashboards, forms, and visualizations alongside the chat.

**Two sprinkle modes**:

- **Fragment mode** (default): Plain HTML fragments injected into the sidebar. Do NOT use `<!DOCTYPE html>`, `<html>`, `<head>`, `<body>`, or custom CSS — use the built-in `.sprinkle-*` classes. Scripts get a `slicc` bridge object automatically.
- **Full-document mode**: Complete HTML documents (starting with `<!DOCTYPE html>` or `<html>`) render inside sandboxed iframes. Use this for complex layouts with custom CSS, sidebars, split panes, modals, or canvas/SVG visualizations. The bridge script is auto-injected — `window.slicc` and `window.bridge` are available in your scripts. Use `parent.postMessage` is handled internally.

**When to use full-document mode**: Use it when you need custom CSS beyond `.sprinkle-*` classes, complex layouts (sidebar + main, split panes, tabs), or interactive canvas/SVG. The parent page's S2 theme tokens are injected automatically.

**Creating a sprinkle**:

1. `read_file /workspace/skills/sprinkles/style-guide.md` — **always read first** before writing any sprinkle
2. `write_file` to `/shared/sprinkles/<name>/<name>.shtml` (follow the style guide templates)
3. `bash` → `sprinkle open <name>`
4. **CRITICAL: Do NOT finish or send a completion message.** You own this sprinkle for its entire lifetime. The cone will send you follow-up instructions (modifications, lick events) via `feed_scoop`. If you finish, you lose your context and cannot handle future work on this sprinkle.

**Updating a sprinkle** (when you receive follow-up instructions):

1. Edit `/shared/sprinkles/<name>/<name>.shtml` with the requested changes
2. Reload: `sprinkle close <name> && sprinkle open <name>`
3. Do NOT finish — stay ready for more instructions

**Handling lick events** (when the cone forwards a user interaction):
The cone will send you a message with the lick action and your sprinkle name. Only modify YOUR sprinkle — the one matching your scoop name. Process the action and push updates:

- `bash` → `sprinkle send <name> '{"key":"value"}'` to push data to the sprinkle's `slicc.on('update', ...)` handler
- Or edit the `.shtml` file and reload if the UI structure needs to change
- Do NOT finish — stay ready for more events

**Managing sprinkles via bash**:

- `sprinkle list` — see available sprinkles
- `sprinkle open <name>` — show a sprinkle in the sidebar
- `sprinkle close <name>` — remove it
- `sprinkle send <name> '<json>'` — push data (single-quote the JSON!)
- `sprinkle chat '<html>'` — show inline HTML in the chat (for quick confirmations/choices)
- `open /path/to/file.shtml` — also opens as a sprinkle

**Bridge API** (available as `slicc` in `<script>` tags and `onclick` attributes):

- `slicc.lick({action: 'refresh', data: {...}})` — send a lick event to the cone (cone routes to the right scoop)
- `slicc.on('update', function(data) {...})` — receive data sent via `sprinkle send`
- `slicc.name` — the sprinkle's name
- `slicc.close()` — close the sprinkle
- `slicc.stopCone()` — stop the cone agent
- `slicc.readFile(path)` — read a VFS file (returns `Promise<string>`)
- `slicc.writeFile(path, content)` — write text content to a VFS file
- `slicc.readDir(path)` — list directory entries (returns `Promise<Array<{name, type}>>`)
- `slicc.exists(path)` — check if path exists (returns `Promise<boolean>`)
- `slicc.stat(path)` — get file metadata (returns `Promise<{type, size}>`)
- `slicc.mkdir(path)` — create a directory (recursive)
- `slicc.rm(path)` — remove a file
- `slicc.screenshot(selector?)` — capture sprinkle DOM as base64 PNG data URL. Note: The screenshot captures a DOM clone using SVG foreignObject. External stylesheets and some computed styles may not be fully reproduced. For best results, use inline styles on elements you intend to screenshot.

**onclick attributes**: Always use `slicc` — e.g. `onclick="slicc.lick({action: 'add-year'})"`. The `slicc` variable is automatically resolved per-sprinkle, so multiple sprinkles won't collide. Do NOT use `bridge` or any other variable name in onclick.

**CSS components** — Do NOT write custom CSS. Use the built-in `.sprinkle-*` classes: cards, tables, badges, buttons, text fields, progress bars, meters, layout utilities, and more. For inputs use `class="sprinkle-text-field"`, never inline border/padding styles. Run `read_file /workspace/skills/sprinkles/style-guide.md` for the full component reference with markup examples.

## Built-in Sprinkles

SLICC no longer ships with a catalog of pre-built sprinkles. The only `.shtml` under `/shared/sprinkles/` is `welcome/` which backs the inline first-run welcome dip — not a panel sprinkle. **Always create sprinkles from scratch** for what the user is asking for, following the "Creating a sprinkle" flow above. Do not assume a built-in sprinkle name exists.

### Cone orchestration for sprinkles

**Rule 3: Creating sprinkles** — Create a scoop, then feed it a complete, self-contained brief:

```
scoop_scoop("giro-winners")
feed_scoop("giro-winners", "You own the sprinkle 'giro-winners'. Your job:
1. Run: read_file /workspace/skills/sprinkles/style-guide.md
2. Research the last 3 Giro d'Italia winners
3. Write the sprinkle to /shared/sprinkles/giro-winners/giro-winners.shtml
4. Run: sprinkle open giro-winners
5. IMPORTANT: After opening the sprinkle, do NOT finish. Stay ready — you will receive follow-up instructions and lick events for this sprinkle via feed_scoop. Do not send a completion message.")
```

**Rule 4: Modifying sprinkles** — Feed the EXISTING scoop that owns it. Do NOT create a new scoop:

```
feed_scoop("giro-winners", "Modify YOUR sprinkle 'giro-winners' at /shared/sprinkles/giro-winners/giro-winners.shtml:
Add an 'Add Previous Year' button with onclick=\"slicc.lick({action: 'add-year'})\"
Then reload: sprinkle close giro-winners && sprinkle open giro-winners
Stay ready for more work.")
```

**Rule 5: Lick events** — Forward to owning scoop, never handle yourself:

```
feed_scoop("giro-winners", "Lick event on YOUR sprinkle 'giro-winners' (/shared/sprinkles/giro-winners/giro-winners.shtml):
Action: 'add-year'
Look up the next previous year's Giro d'Italia winner and update the sprinkle.
Use: sprinkle send giro-winners '<json>' to push data, or edit the .shtml and reload.
Stay ready for more lick events.")
```
