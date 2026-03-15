---
name: sprinkles
description: Create interactive sprinkles — dashboards, forms, and visualizations
allowed-tools: bash
---

# Sprinkles

`.shtml` files in `/shared/sprinkles/` become interactive UI panels. Use them to create dashboards, forms, and visualizations alongside the chat.

**IMPORTANT**: Sprinkles are NOT iframes. They are plain divs injected into the sidebar. Do NOT use `<!DOCTYPE html>`, `<html>`, `<head>`, `<body>`, or custom CSS — use the built-in `.sprinkle-*` classes. Scripts get a `slicc` bridge object automatically — do NOT use `window.parent.postMessage` or `window.addEventListener('message')`.

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
- `open /path/to/file.shtml` — also opens as a sprinkle

**Bridge API** (available as `slicc` in `<script>` tags and `onclick` attributes):
- `slicc.lick({action: 'refresh', data: {...}})` — send a lick event to the cone (cone routes to the right scoop)
- `slicc.on('update', function(data) {...})` — receive data sent via `sprinkle send`
- `slicc.name` — the sprinkle's name
- `slicc.close()` — close the sprinkle

**onclick attributes**: Always use `slicc` — e.g. `onclick="slicc.lick({action: 'add-year'})"`. The `slicc` variable is automatically resolved per-sprinkle, so multiple sprinkles won't collide. Do NOT use `bridge` or any other variable name in onclick.

**CSS components** — Do NOT write custom CSS. Use the built-in `.sprinkle-*` classes: cards, tables, badges, buttons, text fields, progress bars, meters, layout utilities, and more. For inputs use `class="sprinkle-text-field"`, never inline border/padding styles. Run `read_file /workspace/skills/sprinkles/style-guide.md` for the full component reference with markup examples.

**Playground sprinkles** — For interactive playgrounds with rich controls (sliders, chips, toggles, color pickers, canvas) and bidirectional agent communication, see `read_file /workspace/skills/playground-sprinkles/SKILL.md`.
