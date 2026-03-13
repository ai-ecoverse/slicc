---
name: shtml-panels
description: Create interactive SHTML sidebar panels — dashboards, forms, and visualizations
allowed-tools: bash
---

# SHTML Canvas Panels

`.shtml` files on the VFS become interactive sidebar panels. Use them to create dashboards, forms, and visualizations alongside the chat.

**Creating a panel**: Use `write_file` to create `/workspace/skills/<name>/<name>.shtml`, then `panel open <name>`. When the user asks for a dashboard, status view, form, or any visual UI — create a panel.

**IMPORTANT**: Panels are NOT iframes. They are plain divs injected into the sidebar. Do NOT use `<!DOCTYPE html>`, `<html>`, `<head>`, `<body>`, or custom CSS — use the built-in `.shtml-*` classes. Scripts get a `slicc` bridge object automatically — do NOT use `window.parent.postMessage` or `window.addEventListener('message')`.

**Workflow**:
1. `read_file /workspace/skills/style-guide/style-guide.md` — **always read first** before writing any panel
2. `write_file` to `/workspace/skills/<name>/<name>.shtml` (follow the style guide templates)
3. `bash` → `panel open <name>`
4. `bash` → `panel send <name> '{"v1":"42","v2":"99%"}'` to push data

**Managing panels via bash**:
- `panel list` — see available panels
- `panel open <name>` — show a panel in the sidebar
- `panel close <name>` — remove it
- `panel send <name> '<json>'` — push data (single-quote the JSON!)
- `open /path/to/file.shtml` — also opens as a panel

**Bridge API** (available as `slicc` in `<script>` tags):
- `slicc.lick({action: 'refresh', data: {...}})` — send a lick event to you (arrives as a panel lick in chat)
- `slicc.on('update', function(data) {...})` — receive data sent via `panel send`
- `slicc.name` — the panel's name
- `slicc.close()` — close the panel

**CSS components** — Do NOT write custom CSS. Use the built-in `.shtml-*` classes: cards, tables, badges, buttons, text fields, progress bars, meters, layout utilities, and more. For inputs use `class="shtml-text-field"`, never inline border/padding styles. Run `read_file /workspace/skills/style-guide/style-guide.md` for the full component reference with markup examples.
