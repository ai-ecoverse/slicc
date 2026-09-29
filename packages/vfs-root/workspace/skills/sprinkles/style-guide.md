# Sprinkle Component Reference

Use `.sprinkle-*` classes. **No custom CSS.**

## Rail icon

```html
<link rel="icon" href="music" />
```

Lucide name, VFS SVG path, or `data:image/svg+xml` URL. See SKILL.md "Sprinkle icon". Never skip — Sparkles reserved for no thematic anchor.

## Icons (Lucide)

`LucideIcons` global. Declarative:

```html
<i data-lucide="check" class="sprinkle-icon"></i>
<i data-lucide="settings" class="sprinkle-icon sprinkle-icon--l"></i>
```

Sizes: `--xs` 12px, `--s` 14px, `--m` 16px (default), `--l` 20px, `--xl` 24px. Kebab-case from [lucide.dev/icons](https://lucide.dev/icons). **No emojis.**

Programmatic: `LucideIcons.createElement(name, opts)`; `LucideIcons.render()` after dynamic content.

## Cards

`.sprinkle-card` — shadow card. `.sprinkle-stat-card` — `.value` + `.label`.

## Action Card

`.sprinkle-action-card` — compact card for inline chat (` ```shtml ` blocks). Children:

- `__header` — bold title; `.sprinkle-badge` inside auto right-aligns.
- `__body` — secondary description.
- `__actions` — right-aligned button row with top border.

All three optional. Minimal (actions only):

```html
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick('go')">Go</button>
  </div>
</div>
```

Full card with progress inside body:

```html
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">Build status</div>
  <div class="sprinkle-action-card__body">
    <div class="sprinkle-progress-bar" style="--progress:67%">
      <div class="sprinkle-progress-bar__header">
        <span class="label">Tests</span><span class="value">67%</span>
      </div>
      <div class="sprinkle-progress-bar__track"><div class="fill" style="width:67%"></div></div>
    </div>
  </div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick('cancel')">
      Cancel
    </button>
    <button
      class="sprinkle-btn sprinkle-btn--primary"
      onclick="slicc.lick({action:'confirm',data:{id:1}})"
    >
      Confirm
    </button>
  </div>
</div>
```

## Table / Badges / Status

`.sprinkle-table` — bold headers, row hover. `.sprinkle-badge` + `--positive`/`--negative`/`--notice`/`--informative`/`--accent`; `--subtle`, `--outline`. `.sprinkle-status-light` + color variants.

## Buttons / Text Field

`.sprinkle-btn` + `--primary`/`--secondary`/`--negative`. `.sprinkle-btn-group`. `.sprinkle-text-field` on `<input>`.

## Progress / Meter

Simple: `<div class="sprinkle-progress-bar" style="--progress:75%"></div>`. With label: `__header` (`.label`/`.value`) + `__track` > `.fill`. Variants: `--positive`/`--negative`/`--notice`/`--informative`; `--fill-color` override.

`.sprinkle-meter` — same structure; `--value` or `--progress`.

## Code Editor

`<slicc-editor language="json|markdown|html" line-numbers readonly>placeholder</slicc-editor>`

- `.value` get/set. `change` event → `e.detail.value`.
- `setHighlighter({ token(stream) })` for custom syntax.
- `setGutterMarkers({ lineNo: { color, tooltip? } })`.
- Bundles load async: `window.__SLICC_SPRINKLE_ASSETS__['slicc-editor.js'].then(...)`.

## Diff Viewer

`<slicc-diff>` — [@pierre/diffs](https://diffs.com) with Shiki highlighting, auto dark/light.

Two-file mode:

```html
<slicc-diff
  old-name="config.json"
  old-contents='{"debug": false}'
  new-name="config.json"
  new-contents='{"debug": true, "verbose": true}'
  diff-style="split"
></slicc-diff>
```

Patch mode:

```html
<slicc-diff id="mydiff"></slicc-diff>
<script>
  document.getElementById('mydiff').patch =
    '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new';
</script>
```

Dynamic:

```html
<slicc-diff id="preview"></slicc-diff>
<script>
  var diff = document.getElementById('preview');
  diff.oldFile = { name: 'app.ts', contents: oldCode };
  diff.newFile = { name: 'app.ts', contents: newCode };
  diff.options = { diffStyle: 'unified', overflow: 'wrap' };
</script>
```

| Attribute                 | Default  | Description                          |
| ------------------------- | -------- | ------------------------------------ |
| `old-name`/`old-contents` | —        | Old file                             |
| `new-name`/`new-contents` | —        | New file                             |
| `patch`                   | —        | Unified diff string (alt to old/new) |
| `diff-style`              | `split`  | `split` or `unified`                 |
| `overflow`                | `scroll` | `scroll` or `wrap`                   |
| `disable-header`          | —        | Hide file header bar                 |

Bundles load async — set properties (adopted on upgrade), await bundle before methods:

```javascript
window.__SLICC_SPRINKLE_ASSETS__['slicc-editor.js'].then(function () {
  document.getElementById('lyrics').setHighlighter({ token: myTokenizer });
});
```

## Layout — Basic

`.sprinkle-grid`, `.sprinkle-stack`, `.sprinkle-row`, `.sprinkle-heading`, `.sprinkle-body`, `.sprinkle-detail`, `.sprinkle-divider` (`--medium`).

## Layout — Advanced

### Sidebar

```html
<div class="sprinkle-sidebar">
  <nav class="sprinkle-sidebar__nav">
    <div class="sprinkle-sidebar__nav-label">Section</div>
    <div class="sprinkle-sidebar__nav-item sprinkle-sidebar__nav-item--active">Active</div>
    <div class="sprinkle-sidebar__nav-item">Other</div>
  </nav>
  <div class="sprinkle-sidebar__main">…</div>
</div>
```

### Split / Toolbar / Tabs

`.sprinkle-split` (add `--vertical`). `.sprinkle-toolbar` with `__start`/`__center`/`__end`. `.sprinkle-tabs` with `__tab`, `__tab--active`, `__panel`, `__panel--active`.

### Dialog

```html
<div class="sprinkle-dialog" hidden id="myDialog">
  <div class="sprinkle-dialog__backdrop" onclick="closeDialog()"></div>
  <div class="sprinkle-dialog__content">
    <div class="sprinkle-dialog__header">
      <span class="sprinkle-dialog__title">Title</span>
      <button class="sprinkle-dialog__close" onclick="closeDialog()">×</button>
    </div>
    <p>Content</p>
    <div class="sprinkle-dialog__footer">
      <button class="sprinkle-btn sprinkle-btn--secondary" onclick="closeDialog()">Cancel</button>
      <button class="sprinkle-btn sprinkle-btn--primary" onclick="confirm()">Confirm</button>
    </div>
  </div>
</div>
```

### Collapsible / Canvas

Native `<details>`/`<summary>` works both modes — trigger text in `<summary>` only. Or `.sprinkle-collapsible` with `--open` toggled on header click. `.sprinkle-canvas` + `--16x9`/`--4x3`/`--1x1` for SVG/canvas. `.sprinkle-panel` — container queries (<400px stacks, >600px sidebar 240px).

## Key-Value / Empty

`.sprinkle-kv-list` — `<dl>` with `<dt>`/`<dd>`. `.sprinkle-empty-state`.

## Multi-Action Licks

```html
<button onclick="slicc.lick({action:'save-section', data:{id:'hero', content:getContent()}})">
  Save
</button>
```

```javascript
slicc.on('update', function (data) {
  if (data.type === 'audit-results') renderResults(data.results);
});
var saved = slicc.getState();
```

## Design Guidelines

Professional tools, not chatbot output. No emojis in headings. No inline hard-coded colors — use S2 tokens or `light-dark()`. Tables for findings (severity badges in first column). Status lights for pass/fail. `sprinkle-kv-list` for stats (stat cards for 3–4 KPIs only).

### Report template

```html
<title>Report Title</title>
<link rel="icon" href="clipboard-list" />
<div class="sprinkle-stack">
  <div>
    <h2 class="sprinkle-heading">Report Title</h2>
    <p class="sprinkle-detail">Context line — source, date</p>
  </div>
  <div class="sprinkle-grid">
    <div class="sprinkle-stat-card">
      <div class="value">A</div>
      <div class="label">Grade</div>
    </div>
    <div class="sprinkle-stat-card">
      <div class="value">12</div>
      <div class="label">Passed</div>
    </div>
    <div class="sprinkle-stat-card">
      <div class="value">0</div>
      <div class="label">Issues</div>
    </div>
  </div>
  <div class="sprinkle-divider"></div>
  <h3 class="sprinkle-body" style="font-weight:600">Issues</h3>
  <table class="sprinkle-table">
    <thead>
      <tr>
        <th>Severity</th>
        <th>Finding</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><span class="sprinkle-badge sprinkle-badge--negative">Critical</span></td>
        <td><strong>Title</strong><br /><span class="sprinkle-detail">Description</span></td>
      </tr>
      <tr>
        <td><span class="sprinkle-badge sprinkle-badge--notice">Warning</span></td>
        <td><strong>Title</strong><br /><span class="sprinkle-detail">Description</span></td>
      </tr>
    </tbody>
  </table>
  <div class="sprinkle-divider"></div>
  <h3 class="sprinkle-body" style="font-weight:600">Passed checks</h3>
  <table class="sprinkle-table">
    <thead>
      <tr>
        <th>Status</th>
        <th>Check</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><span class="sprinkle-status-light sprinkle-status-light--positive">Pass</span></td>
        <td>Check description</td>
      </tr>
    </tbody>
  </table>
  <div class="sprinkle-divider"></div>
  <h3 class="sprinkle-body" style="font-weight:600">Stats</h3>
  <dl class="sprinkle-kv-list">
    <dt>Metric</dt>
    <dd>Value</dd>
  </dl>
  <p class="sprinkle-detail" style="text-align:center;margin-top:var(--s2-spacing-200)">
    Footer note
  </p>
</div>
```

## DATA CONTRACT protocol

Stateful sprinkles: comment block at top of `<script>` documenting exact JSON format.

Three states: **empty** (URL form), **loading**, **ready**. Scoop drives via `sprinkle send`:

```bash
sprinkle send <name> '{"status":"analyzing","url":"https://…"}'   # immediately after open
sprinkle send <name> '{"content":"…","rules":{…}}'                # when complete
sprinkle send <name> '{"status":"empty"}'                          # no page specified
```

Scoop brief template:

```
scoop_scoop("<name>")
feed_scoop("<name>", "You own sprinkle '<name>'.
1. read_file style-guide.md  2. Pick Lucide icon  3. Write .shtml with DATA CONTRACT
4. sprinkle open <name>  5. IMMEDIATELY: sprinkle send '{\"status\":\"loading\"}'
6. Gather data  7. Push results per DATA CONTRACT  8. Handle lick events
9. On user confirm, apply to underlying source. Do not finish.")
```

## Applying Changes

Content-editing sprinkles should write user-confirmed changes back to the actual site — not just local UI state.

### When to apply

After user **confirms** — `suggestion-applied` or `apply-fix` lick. Not on every lick.

### Determining write access

Cone sets backend context in scoop brief:

- **EDS site** (`*--*--*.aem.page|live`): `aem get`, `aem put`, `aem preview`
- **No write access** (external/unknown CMS): push `fix-error`

### EDS workflow

```bash
aem get <eds-url> --output /scoops/<scoop-name>/page.html
# read/edit HTML (title, meta, headings)
aem put <eds-url> /scoops/<scoop-name>/page.html
aem preview <eds-url>
```

### Confirm back to sprinkle

```bash
sprinkle send <name> '{"action":"fix-applied","pageIndex":0,"category":"Title","value":"new title","path":"/page","previewUrl":"https://…"}'
```

Sprinkle updates score/checkmarks only after `fix-applied`. On failure:

```bash
sprinkle send <name> '{"action":"fix-error","message":"Cannot apply — no write access to example.com"}'
```

### Sprinkle-side handlers

```javascript
slicc.on('update', function (data) {
  if (data.action === 'fix-applied') {
    applyFixToLocal(data.pageIndex, data.category, data.value);
    showToast('Applied: ' + data.path);
  }
  if (data.action === 'fix-error') showToast('Error: ' + data.message, true);
});
```

## Light & dark mode

S2 tokens swap with `.theme-light`. Never hard-code theme colors. No `@media (prefers-color-scheme)` for app-theme sync.

```css
:root {
  color-scheme: light dark;
}
.my-tile {
  background: light-dark(#fafafa, #1c1c1c);
}
```

## S2 Token Reference

### Border Radius

| Token                 | Value  | Usage               |
| --------------------- | ------ | ------------------- |
| `--s2-radius-s`       | 4px    | Checkboxes          |
| `--s2-radius-default` | 8px    | Inputs, small cards |
| `--s2-radius-l`       | 10px   | Cards, panels       |
| `--s2-radius-xl`      | 16px   | Dialogs             |
| `--s2-radius-pill`    | 9999px | **Buttons**, badges |

### Backgrounds

`--s2-bg-base`, `--s2-bg-layer-1`, `--s2-bg-layer-2`, `--s2-bg-elevated`. Never `#fff` — use tokens.

### Text / Tints / Shadows / Spacing

Text on dark: `var(--s2-gray-25)` not pure white. Tints: `color-mix(in srgb, var(--s2-positive) 10%, transparent)` or `--uxc-<hue>-subtle-bg`/`-text` pairs. Shadows: `--s2-shadow-container`, `--s2-shadow-elevated`. Spacing: `--s2-spacing-100` (8px) through `--s2-spacing-600` (40px).
