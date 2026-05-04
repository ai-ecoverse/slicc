# Sprinkle Component Reference

Use these CSS classes in `.shtml` sprinkles. Do NOT write custom CSS — these components cover all common UI patterns.

## Rail icon (favicon)

Every sprinkle declares its own glyph for the side rail. Add this to the sprinkle's `<head>` (full-document mode) or as the first element (fragment mode):

```html
<link rel="icon" href="music" />
```

The `href` accepts a Lucide icon name (preferred), a VFS path to an SVG (`/shared/sprinkles/<name>/icon.svg`), or a `data:image/svg+xml;...` URL. See the SKILL.md "Sprinkle icon" section for the full list. **Never skip this** — generic Sparkles tiles are reserved for sprinkles that genuinely have no thematic anchor.

## Icons (Lucide)

Lucide icons are available globally via the `LucideIcons` object. Use declarative `data-lucide` attributes for automatic rendering, or create icons programmatically.

**Declarative usage** (recommended):

```html
<!-- Icon renders automatically on page load -->
<i data-lucide="check" class="sprinkle-icon"></i>
<i data-lucide="alert-circle" class="sprinkle-icon"></i>
<i data-lucide="settings" class="sprinkle-icon sprinkle-icon--l"></i>

<!-- In buttons -->
<button class="sprinkle-btn sprinkle-btn--primary">
  <i data-lucide="save" class="sprinkle-icon"></i> Save
</button>

<!-- In action card headers -->
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">
    <i data-lucide="check-circle" class="sprinkle-icon" style="color: var(--uxc-positive-text)"></i>
    Success
  </div>
</div>
```

**Programmatic usage**:

```javascript
// Create an icon element
const icon = LucideIcons.createElement('alert-triangle', {
  size: 20,
  color: 'var(--uxc-notice-text)',
  strokeWidth: 2,
  class: 'sprinkle-icon',
});
container.appendChild(icon);

// Re-render all icons after dynamic content changes
LucideIcons.render();
```

**Icon sizes**:

- `.sprinkle-icon--xs` — 12px (small badges)
- `.sprinkle-icon--s` — 14px (inline text)
- `.sprinkle-icon--m` — 16px (default, buttons)
- `.sprinkle-icon--l` — 20px (headings)
- `.sprinkle-icon--xl` — 24px (large cards)

**Icon names**: Use kebab-case from [lucide.dev/icons](https://lucide.dev/icons) — e.g., `check`, `alert-circle`, `arrow-right`, `file-text`.

**NO EMOJIS** — Always use Lucide icons instead of emoji for a professional, consistent look.

## Cards

`.sprinkle-card` — Card with shadow (hover elevates).
`.sprinkle-stat-card` — Stat card with `.value` + `.label` children.

## Action Card (Inline)

`.sprinkle-action-card` — Compact card with background and border for inline chat interactions (` ```shtml ` blocks). Children:

- `__header` — Bold title row. Put a `.sprinkle-badge` inside for status (auto right-aligned).
- `__body` — Secondary-color description text.
- `__actions` — Right-aligned button row with top border separator.

All three children are optional. Minimal card (just actions):

```html
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick('go')">Go</button>
  </div>
</div>
```

Use existing `.sprinkle-*` components inside the body:

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
</div>
```

Full card with all sections:

```html
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">
    Title
    <span class="sprinkle-badge sprinkle-badge--notice">status</span>
  </div>
  <div class="sprinkle-action-card__body">Description</div>
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

## Table

`.sprinkle-table` — Table with bold headers (no uppercase!), row hover, row dividers.

## Badges

`.sprinkle-badge` — Bold solid-fill badges.

- Color variants: `--positive`, `--negative`, `--notice`, `--informative`, `--accent`
- Styles: `--subtle` (tinted bg), `--outline` (stroke)
- Combine: `sprinkle-badge sprinkle-badge--subtle sprinkle-badge--positive`

## Status Light

`.sprinkle-status-light` — Dot + label. Variants: `--positive`/`--negative`/`--notice`/`--informative`.

## Buttons

`.sprinkle-btn` — Pill-rounded buttons.

- `--primary` — accent fill (CTA)
- `--secondary` — outline with hover
- `--negative` — red fill (destructive)
- Add `disabled` attribute for disabled state

`.sprinkle-btn-group` — Gap-spaced button group (each button keeps pill shape).

## Text Field

`.sprinkle-text-field` — Styled text input. Use on `<input type="text">`. Supports hover/focus states, placeholder styling. Combine with `.sprinkle-row` for inline input + button layouts:

```html
<div class="sprinkle-row">
  <input type="text" class="sprinkle-text-field" style="flex:1" placeholder="https://example.com" />
  <button class="sprinkle-btn sprinkle-btn--primary">Go</button>
</div>
```

## Progress Bar

`.sprinkle-progress-bar` — Two modes:

**Simple** (no label):

```html
<div class="sprinkle-progress-bar" style="--progress: 75%"></div>
```

Auto-fills via `::after` pseudo-element. No children needed.

**With label**:

```html
<div class="sprinkle-progress-bar">
  <div class="sprinkle-progress-bar__header">
    <span class="label">Upload</span>
    <span class="value">75%</span>
  </div>
  <div class="sprinkle-progress-bar__track">
    <div class="fill" style="width: 75%"></div>
  </div>
</div>
```

The `.fill` child accepts inline `style="width: 75%"` or `data-value="75"`. Alternatively, omit `.fill` and set `--progress` on the container.

**Color variants** on container: `--positive` (green), `--negative` (red), `--notice` (orange), `--informative` (blue).
Inline `--fill-color` overrides the variant color.

## Meter

`.sprinkle-meter` — Same structure as progress bar but uses `.sprinkle-meter`, `__header`/`__track`.

**Simple**:

```html
<div class="sprinkle-meter" style="--value: 50%"></div>
```

Accepts `--value` or `--progress` for fill width.

**Variants**: `--positive`/`--notice`/`--negative` on container. Default color: informative (blue).

## Code Editor

`<slicc-editor>` — Pre-bundled CodeMirror 6 editor custom element. Use for code editing, config editing, or any domain-specific text with syntax highlighting. The editor auto-themes to S2 tokens (dark/light).

**Attributes:**

- `language` — Built-in: `json`, `markdown`, `html`. Omit for plain text.
- `line-numbers` — Show line numbers gutter (boolean attribute).
- `readonly` — Disable editing (boolean attribute).

**Inner text** is used as placeholder (shown when editor is empty).

**Basic usage:**

```html
<slicc-editor id="config" language="json" line-numbers>{"key": "value"}</slicc-editor>
<script>
  var editor = document.getElementById('config');
  editor.value = '{\n  "name": "example"\n}';
  editor.addEventListener('change', function (e) {
    slicc.lick({ action: 'config-changed', data: { value: e.detail.value } });
  });
</script>
```

**Custom syntax highlighter** for domain-specific languages:

```html
<slicc-editor id="lyrics" line-numbers>[Intro] Write your lyrics here...</slicc-editor>
<script>
  var editor = document.getElementById('lyrics');
  var CM6 = window.__SLICC_CM6__;
  editor.setHighlighter({
    token: function (stream) {
      if (stream.match(/^\[.*?\]/)) return 'keyword';
      if (stream.match(/^\(.*?\)/)) return 'comment';
      stream.next();
      return null;
    },
  });
</script>
```

**Gutter markers** (colored dots on specific lines):

```javascript
editor.setGutterMarkers({
  3: { color: 'var(--s2-notice)', tooltip: 'Check meter' },
  7: { color: 'var(--s2-negative)', tooltip: 'Error here' },
});
```

**Properties & Methods:**

| API                          | Description                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| `.value`                     | Get/set editor content (string)                                     |
| `.setHighlighter(parser)`    | Set custom StreamLanguage parser with `token(stream, state)` method |
| `.setGutterMarkers(markers)` | Set line markers: `{ lineNo: { color, tooltip? } }`                 |
| `change` event               | Fires on edit. `e.detail.value` has new content                     |

## Diff Viewer

`<slicc-diff>` — Pre-bundled diff viewer custom element ([@pierre/diffs](https://diffs.com)). Use for showing code changes, migration previews, before/after comparisons. Includes Shiki syntax highlighting and auto dark/light theming.

**Two-file mode** (compare old vs new):

```html
<slicc-diff
  old-name="config.json"
  old-contents='{"debug": false}'
  new-name="config.json"
  new-contents='{"debug": true, "verbose": true}'
  diff-style="split"
></slicc-diff>
```

**Patch mode** (unified diff string):

```html
<slicc-diff id="mydiff"></slicc-diff>
<script>
  document.getElementById('mydiff').patch =
    '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old line\n+new line';
</script>
```

**JS property API** (for dynamic content):

```html
<slicc-diff id="preview"></slicc-diff>
<script>
  var diff = document.getElementById('preview');
  diff.oldFile = { name: 'app.ts', contents: oldCode };
  diff.newFile = { name: 'app.ts', contents: newCode };
  diff.options = { diffStyle: 'unified', overflow: 'wrap' };
</script>
```

**Attributes:**

| Attribute        | Default  | Description                                  |
| ---------------- | -------- | -------------------------------------------- |
| `old-name`       | —        | Old filename                                 |
| `old-contents`   | —        | Old file contents                            |
| `new-name`       | —        | New filename                                 |
| `new-contents`   | —        | New file contents                            |
| `patch`          | —        | Unified diff string (alternative to old/new) |
| `diff-style`     | `split`  | `split` (side-by-side) or `unified` (single) |
| `overflow`       | `scroll` | `scroll` or `wrap` for long lines            |
| `disable-header` | —        | Boolean: hide the file header bar            |

**JS Properties:** `.oldFile`, `.newFile` (objects with `name` + `contents`), `.patch` (string), `.options` (object).

## Layout — Basic

`.sprinkle-grid` — Auto-fit responsive grid.
`.sprinkle-stack` — Vertical stack with gap.
`.sprinkle-row` — Horizontal flex row, centered.
`.sprinkle-heading` — Section heading.
`.sprinkle-body` — Body text.
`.sprinkle-detail` — Small secondary text.
`.sprinkle-divider` — Subtle separator line. Add `--medium` for thicker.

## Layout — Advanced (Fragment & Full-Doc)

### Sidebar

`.sprinkle-sidebar` — Two-column layout: fixed nav + flexible main.

```html
<div class="sprinkle-sidebar">
  <nav class="sprinkle-sidebar__nav">
    <div class="sprinkle-sidebar__nav-label">Section</div>
    <div class="sprinkle-sidebar__nav-item sprinkle-sidebar__nav-item--active">Active Item</div>
    <div class="sprinkle-sidebar__nav-item">Other Item</div>
  </nav>
  <div class="sprinkle-sidebar__main">
    <!-- main content -->
  </div>
</div>
```

### Split Pane

`.sprinkle-split` — Equal horizontal split. Add `--vertical` for stacked.

```html
<div class="sprinkle-split">
  <div>Left / Top pane</div>
  <div>Right / Bottom pane</div>
</div>
```

### Toolbar

`.sprinkle-toolbar` — Horizontal action bar with start/center/end slots.

```html
<div class="sprinkle-toolbar">
  <div class="sprinkle-toolbar__start"><button class="sprinkle-btn">Back</button></div>
  <div class="sprinkle-toolbar__center"><strong>Title</strong></div>
  <div class="sprinkle-toolbar__end">
    <button class="sprinkle-btn sprinkle-btn--primary">Save</button>
  </div>
</div>
```

### Tabs

`.sprinkle-tabs` — Tab bar with panels.

```html
<div class="sprinkle-tabs">
  <button class="sprinkle-tabs__tab sprinkle-tabs__tab--active" onclick="switchTab(0)">
    Tab 1
  </button>
  <button class="sprinkle-tabs__tab" onclick="switchTab(1)">Tab 2</button>
</div>
<div class="sprinkle-tabs__panel sprinkle-tabs__panel--active">Content 1</div>
<div class="sprinkle-tabs__panel">Content 2</div>
```

### Dialog / Modal

`.sprinkle-dialog` — Overlay dialog. Use `hidden` attribute to hide.

```html
<div class="sprinkle-dialog" hidden id="myDialog">
  <div class="sprinkle-dialog__backdrop" onclick="closeDialog()"></div>
  <div class="sprinkle-dialog__content">
    <div class="sprinkle-dialog__header">
      <span class="sprinkle-dialog__title">Title</span>
      <button class="sprinkle-dialog__close" onclick="closeDialog()">×</button>
    </div>
    <p>Dialog content here.</p>
    <div class="sprinkle-dialog__footer">
      <button class="sprinkle-btn sprinkle-btn--secondary" onclick="closeDialog()">Cancel</button>
      <button class="sprinkle-btn sprinkle-btn--primary" onclick="confirm()">Confirm</button>
    </div>
  </div>
</div>
```

### Collapsible

`.sprinkle-collapsible` — Expandable section. Add `--open` class to expand.

```html
<div class="sprinkle-collapsible sprinkle-collapsible--open">
  <button
    class="sprinkle-collapsible__header"
    onclick="this.parentElement.classList.toggle('sprinkle-collapsible--open')"
  >
    <span class="sprinkle-collapsible__chevron"></span>
    Section Title
  </button>
  <div class="sprinkle-collapsible__body">Expandable content here.</div>
</div>
```

### Canvas / SVG Container

`.sprinkle-canvas` — Container for canvas or SVG. Aspect ratio modifiers: `--16x9`, `--4x3`, `--1x1`.

```html
<div class="sprinkle-canvas sprinkle-canvas--16x9">
  <svg viewBox="0 0 800 450"><!-- chart --></svg>
</div>
```

### Container Queries

Wrap content in `.sprinkle-panel` for responsive container queries:

- Below 400px: sidebar stacks vertically, grids go single-column, splits stack, toolbar wraps
- Above 600px: sidebar nav at 240px, grids use auto-fit minmax(180px, 1fr)

## Key-Value List

`.sprinkle-kv-list` — Key-value pairs. Use `<dl>` with `<dt>`/`<dd>` (preferred) or `<ul>` with `<li>` containing `.key`/`.value` spans. The `<dl>` variant renders as a two-column grid with labels left, values right-aligned bold.

## Empty State

`.sprinkle-empty-state` — Centered empty state messaging.

---

## Multi-Action Lick Patterns

Sprinkles can send multiple distinct actions via `slicc.lick()`. The cone routes each action to the owning scoop.

**Button with action + data**:

```html
<button
  class="sprinkle-btn sprinkle-btn--primary"
  onclick="slicc.lick({action: 'save-section', data: {id: 'hero', content: getContent()}})"
>
  Save
</button>
```

**Toolbar with multiple actions**:

```html
<div class="sprinkle-toolbar">
  <div class="sprinkle-toolbar__start">
    <button class="sprinkle-btn" onclick="slicc.lick({action: 'run-audit'})">Run Audit</button>
  </div>
  <div class="sprinkle-toolbar__end">
    <button
      class="sprinkle-btn sprinkle-btn--secondary"
      onclick="slicc.lick({action: 'export-report'})"
    >
      Export
    </button>
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick({action: 'fix-all'})">
      Fix All
    </button>
  </div>
</div>
```

**Handling updates from the agent**:

```html
<script>
  slicc.on('update', function (data) {
    if (data.type === 'audit-results') {
      renderResults(data.results);
    } else if (data.type === 'status') {
      document.getElementById('status').textContent = data.message;
    }
  });

  // Restore state on reopen
  var saved = slicc.getState();
  if (saved) {
    renderResults(saved.results);
  }
</script>
```

---

## Design Guidelines

Panels should look like professional tools, not chatbot output. Follow these rules:

**No emojis in headings or labels.** Use badges, status lights, and semantic color to convey meaning — not 🔍 ❌ ✅ ⚠️ 📊 icons.

**No inline color styles.** Use the semantic variants (`--positive`, `--negative`, `--notice`, `--informative`) instead of hardcoded hex colors.

**Use tables for structured findings.** When presenting lists of issues, checks, or recommendations, use `.sprinkle-table` with severity badges in the first column — not bullet lists with emoji prefixes.

**Use status lights for pass/fail.** `sprinkle-status-light--positive` for passed checks, badges for severity levels (Critical, Warning, Advisory).

**Keep headings plain.** Use `sprinkle-body` with `font-weight:600` for section subheadings, `sprinkle-heading` for the page title. No emoji, no decorative punctuation.

**Use `sprinkle-kv-list` for stats.** Key-value pairs belong in a definition list, not stat cards (reserve stat cards for 3–4 top-level KPIs).

### Example: Audit/Report Panel Structure

```html
<title>Report Title</title>
<link rel="icon" href="clipboard-list" />
<div class="sprinkle-stack">
  <div>
    <h2 class="sprinkle-heading">Report Title</h2>
    <p class="sprinkle-detail">Context line — source, date</p>
  </div>

  <!-- Top-level KPIs -->
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

  <!-- Findings table with severity badges -->
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

  <!-- Passed checks with status lights -->
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

  <!-- Stats as key-value list -->
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

---

## Using Built-in Sprinkles

Built-in sprinkles ship at `/shared/sprinkles/`. They are full-document HTML apps with a **DATA CONTRACT** — a comment block at the top of the `<script>` section documenting the exact JSON format the sprinkle expects.

### Three-state protocol

Every built-in sprinkle has three view states: **empty** (URL input form), **loading** (spinner), and **ready** (full UI). The scoop controls transitions via `sprinkle send`:

1. **Immediately after opening**, push analyzing status so the user sees progress:

   ```bash
   sprinkle send <name> '{"status":"analyzing","url":"https://example.com"}'
   ```

2. **When analysis is complete**, push data in the format specified by the DATA CONTRACT:

   ```bash
   sprinkle send <name> '{"content":"...","rules":{...}}'
   ```

3. **If no page was specified** (scoop should ask the user for a URL):
   ```bash
   sprinkle send <name> '{"status":"empty"}'
   ```

### Scoop brief template

```
scoop_scoop("<sprinkle-name>")
feed_scoop("<sprinkle-name>", "You own the sprinkle '<sprinkle-name>'.
1. Run: read_file /workspace/skills/sprinkles/style-guide.md
2. Pick a Lucide icon name that matches the sprinkle's purpose. Add <link rel=\"icon\" href=\"<icon-name>\" /> to the .shtml. See sprinkles SKILL.md \"Sprinkle icon\" for examples.
3. Write the sprinkle to /shared/sprinkles/<sprinkle-name>/<sprinkle-name>.shtml — define the DATA CONTRACT at the top of the <script>.
4. Run: sprinkle open <sprinkle-name>
5. IMMEDIATELY push status: sprinkle send <sprinkle-name> '{\"status\":\"loading\",\"context\":\"<what>\"}'
6. Gather the data the user needs.
7. Push results to the sprinkle in the format specified by the DATA CONTRACT.
8. Stay ready — you will receive lick events when the user clicks buttons in the sprinkle.
9. When the user confirms an edit, attempt to apply it to the underlying source (see 'Applying Changes' below).
Do not send a completion message.")
```

The scoop creates and opens the sprinkle, pushes loading status, gathers real data, pushes results via `sprinkle send`, and handles lick events from the user.

---

## Applying Changes

Content-editing sprinkles should attempt to apply user-confirmed changes to the actual site. Sprinkle edits are not just local UI state — the scoop must try to write them back.

### When to apply

Apply after the user **confirms** a change — not on every lick. Typical trigger: `suggestion-applied` lick (user picked a fix from suggestions), or `apply-fix` lick (user clicked "Apply").

### Determining write access

The cone sets backend context in the scoop brief (option B). The scoop knows whether it has write access based on its instructions:

- **EDS site** (URL matches `*--*--*.aem.page|live`): use `aem get`, `aem put`, `aem preview` commands
- **No write access** (external site, unknown CMS): push `fix-error` explaining why

### EDS apply workflow (example)

```bash
# 1. Fetch current page HTML
aem get <eds-url> --output /scoops/<scoop-name>/page.html

# 2. Read and modify the HTML (e.g. update <title>, <meta>, headings)
#    Use edit_file or read_file + write_file

# 3. Write back
aem put <eds-url> /scoops/<scoop-name>/page.html

# 4. Trigger preview
aem preview <eds-url>
```

### Confirming back to the sprinkle

After the write succeeds, push confirmation so the sprinkle updates its UI:

```bash
sprinkle send <sprinkle-name> '{"action":"fix-applied","pageIndex":0,"category":"Title","value":"new title","path":"/page","previewUrl":"https://..."}'
```

The sprinkle only updates local state (score, checkmarks) after receiving `fix-applied` with the confirmed value.

If the write fails or write access is unavailable, push the error:

```bash
sprinkle send <sprinkle-name> '{"action":"fix-error","message":"Cannot apply — no write access to nationwide.co.uk"}'
```

### Sprinkle-side handlers

Sprinkles handle these update actions:

```javascript
slicc.on('update', function (data) {
  if (data.action === 'fix-applied') {
    // Update local data with confirmed value, then show toast
    applyFixToLocal(data.pageIndex, data.category, data.value);
    showToast('Applied: ' + data.path);
  }
  if (data.action === 'fix-error') {
    showToast('Error: ' + data.message, true);
  }
});
```

---

## Spectrum 2 Token Reference

Full-document sprinkles (`.shtml`) inherit S2 CSS custom properties from the parent page. Always use tokens — never hardcode hex values.

### Border Radius

| Token                 | Value  | Usage                                |
| --------------------- | ------ | ------------------------------------ |
| `--s2-radius-s`       | 4px    | Checkboxes, in-field buttons         |
| `--s2-radius-default` | 8px    | Most components, inputs, small cards |
| `--s2-radius-l`       | 10px   | Cards, panels, action boxes          |
| `--s2-radius-xl`      | 16px   | Dialogs, modals, wells               |
| `--s2-radius-pill`    | 9999px | **Buttons**, badges, avatars, tags   |

**Buttons MUST use `--s2-radius-pill`** (pill rounding). This is a core S2 convention.

### Backgrounds

| Token              | Usage                                        |
| ------------------ | -------------------------------------------- |
| `--s2-bg-base`     | Page/body background (gray-25)               |
| `--s2-bg-layer-1`  | Sidebar/panel background (gray-50)           |
| `--s2-bg-layer-2`  | Nested layer background (gray-75)            |
| `--s2-bg-elevated` | Cards, buttons, elevated surfaces (gray-100) |

**Never use `#fff` for backgrounds.** Use `var(--s2-bg-elevated)` for cards/buttons, `var(--s2-bg-base)` for page background.

### Text on Dark Backgrounds

Use `var(--s2-gray-25)` instead of `#fff` or `color: white`. S2 avoids pure white on dark backgrounds to prevent halation.

### Semantic Color Tints

For subtle tinted backgrounds (badges, hover states), use `color-mix`:

```css
background: color-mix(in srgb, var(--s2-positive) 10%, transparent); /* green tint */
background: color-mix(in srgb, var(--s2-negative) 8%, transparent); /* red tint */
background: color-mix(in srgb, var(--s2-notice) 10%, transparent); /* amber tint */
background: color-mix(in srgb, var(--s2-accent) 6%, transparent); /* blue tint */
```

### Shadows

| Token                   | Usage                   |
| ----------------------- | ----------------------- |
| `--s2-shadow-container` | Subtle card shadow      |
| `--s2-shadow-elevated`  | Menus, tooltips, modals |

### Spacing

| Token              | Value |
| ------------------ | ----- |
| `--s2-spacing-100` | 8px   |
| `--s2-spacing-200` | 12px  |
| `--s2-spacing-300` | 16px  |
| `--s2-spacing-400` | 24px  |
| `--s2-spacing-500` | 32px  |
| `--s2-spacing-600` | 40px  |
