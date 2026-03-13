---
name: shtml-panels
description: Create interactive SHTML sidebar panels — dashboards, forms, and visualizations
allowed-tools: bash
---

# SHTML Canvas Panels

`.shtml` files on the VFS become interactive sidebar panels. Use them to create dashboards, forms, and visualizations alongside the chat.

**Creating a panel**: Use `write_file` to create `/workspace/skills/<name>/<name>.shtml`, then `panel open <name>`. When the user asks for a dashboard, status view, form, or any visual UI — create a panel.

**IMPORTANT**: Panels are NOT iframes. They are plain divs injected into the sidebar. Do NOT use `<!DOCTYPE html>`, `<html>`, `<head>`, `<body>`, or custom CSS — use the built-in `.shtml-*` classes. Scripts get a `slicc` bridge object automatically — do NOT use `window.parent.postMessage` or `window.addEventListener('message')`.

**Template** — copy and adapt this pattern:
```html
<title>My Dashboard</title>
<div class="shtml-stack">
  <h2 class="shtml-heading">My Dashboard</h2>
  <div class="shtml-grid">
    <div class="shtml-stat-card"><div class="value" id="v1">—</div><div class="label">Metric 1</div></div>
    <div class="shtml-stat-card"><div class="value" id="v2">—</div><div class="label">Metric 2</div></div>
  </div>
  <button class="shtml-btn shtml-btn--primary" onclick="slicc.lick({action:'refresh'})">Refresh</button>
  <div id="status" class="shtml-detail">Ready</div>
</div>
<script>
  slicc.on('update', function(data) {
    if (data.v1) document.getElementById('v1').textContent = data.v1;
    if (data.v2) document.getElementById('v2').textContent = data.v2;
    document.getElementById('status').textContent = 'Updated: ' + JSON.stringify(data);
  });
</script>
```

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
