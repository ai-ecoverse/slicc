# Sprinkle Component Reference

Use these CSS classes in `.shtml` sprinkles. For patterns not covered by the built-in components, you can write custom `<style>` blocks directly in your `.shtml` file — they work in both CLI and extension modes.

## Cards
`.sprinkle-card` — Card with shadow (hover elevates).
`.sprinkle-stat-card` — Stat card with `.value` + `.label` children.

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
  <input type="text" class="sprinkle-text-field" style="flex:1" placeholder="https://example.com">
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

## Layout
`.sprinkle-grid` — Auto-fit responsive grid.
`.sprinkle-stack` — Vertical stack with gap.
`.sprinkle-row` — Horizontal flex row, centered.
`.sprinkle-heading` — Section heading.
`.sprinkle-body` — Body text.
`.sprinkle-detail` — Small secondary text.
`.sprinkle-divider` — Subtle separator line. Add `--medium` for thicker.

## Split Layout
`.sprinkle-split` — Horizontal split panes with a draggable-style handle. Add `--vertical` for top/bottom split.
```html
<div class="sprinkle-split">
  <div class="sprinkle-split__pane sprinkle-split__pane--sidebar">
    <!-- sidebar content (220px default, 280px when expanded) -->
  </div>
  <div class="sprinkle-split__handle"></div>
  <div class="sprinkle-split__pane">
    <!-- main content -->
  </div>
</div>
```
Use `sprinkle-split__pane--sidebar` on the fixed-width pane. The other pane flexes to fill.

## Tabs
`.sprinkle-tabs` — Nested tab group within a sprinkle. Wire tab switching in script.
```html
<div class="sprinkle-tabs">
  <div class="sprinkle-tabs__bar">
    <button class="sprinkle-tabs__tab active" onclick="switchTab(this,'panel1')">Tab 1</button>
    <button class="sprinkle-tabs__tab" onclick="switchTab(this,'panel2')">Tab 2</button>
  </div>
  <div class="sprinkle-tabs__panel active" id="panel1">Content 1</div>
  <div class="sprinkle-tabs__panel" id="panel2">Content 2</div>
</div>
```
```javascript
function switchTab(btn, panelId) {
  var tabs = btn.parentElement.parentElement;
  var buttons = tabs.querySelectorAll('.sprinkle-tabs__tab');
  var panels = tabs.querySelectorAll('.sprinkle-tabs__panel');
  for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove('active');
  for (var i = 0; i < panels.length; i++) panels[i].classList.remove('active');
  btn.classList.add('active');
  document.getElementById(panelId).classList.add('active');
  updateAll();
}
```

## Sidebar Layout
`.sprinkle-sidebar` — Fixed sidebar + flexible main area. Add `--right` for right-side sidebar.
```html
<div class="sprinkle-sidebar">
  <div class="sprinkle-sidebar__aside">
    <!-- controls, navigation -->
  </div>
  <div class="sprinkle-sidebar__main">
    <!-- main content / preview -->
  </div>
</div>
```

## Custom CSS
You can write `<style>` blocks in your `.shtml` file for custom classes. They are extracted and injected into the sandbox automatically — works in both CLI and extension modes.
```html
<style>
  .my-node { fill: var(--s2-accent); stroke: var(--s2-border-default); }
  .my-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
</style>
<div class="my-grid">...</div>
```
Use `var(--s2-*)` tokens in custom CSS for theme consistency.

## Key-Value List
`.sprinkle-kv-list` — Key-value pairs. Use `<dl>` with `<dt>`/`<dd>` (preferred) or `<ul>` with `<li>` containing `.key`/`.value` spans. The `<dl>` variant renders as a two-column grid with labels left, values right-aligned bold.

## Empty State
`.sprinkle-empty-state` — Centered empty state messaging.

## Range Slider
`.sprinkle-range` — Range slider with header label and live value display.
```html
<div class="sprinkle-range">
  <div class="sprinkle-range__header">
    <span class="label">Spacing</span>
    <span class="value" id="spacing-val">12px</span>
  </div>
  <input type="range" id="spacing" min="0" max="48" value="12" oninput="updateAll()">
</div>
```

## Chip Selector
`.sprinkle-chips` — Wrap container for pill-shaped chip buttons.
`.sprinkle-chip` — Individual chip. Add `active` class or `sprinkle-chip--active` for selected state.
```html
<div class="sprinkle-chips">
  <button class="sprinkle-chip active" onclick="selectChip(this,'a')">Option A</button>
  <button class="sprinkle-chip" onclick="selectChip(this,'b')">Option B</button>
</div>
```

## Toggle Switch
`.sprinkle-toggle` — iOS-style toggle with label. Wrap a checkbox + label span.
```html
<label class="sprinkle-toggle">
  <input type="checkbox" checked onchange="updateAll()">
  <span class="label">Enable feature</span>
</label>
```

## Select Dropdown
`.sprinkle-select` — Styled dropdown wrapper. Put a `<select>` inside.
```html
<div class="sprinkle-select" style="width:100%">
  <select style="width:100%" onchange="updateAll()">
    <option value="a">Option A</option>
    <option value="b">Option B</option>
  </select>
</div>
```

## Color Swatch
`.sprinkle-color` — Color picker with label. Wrap `<input type="color">` + label span.
```html
<label class="sprinkle-color">
  <input type="color" value="#6366f1" onchange="updateAll()">
  <span class="label">Accent</span>
</label>
```

## Canvas Container
`.sprinkle-canvas` — Container for `<canvas>` or `<svg>` elements. Responsive width, optional toolbar.
```html
<div class="sprinkle-canvas">
  <svg viewBox="0 0 300 200" style="width:100%;height:200px"></svg>
  <div class="sprinkle-canvas__toolbar">
    <button class="sprinkle-btn sprinkle-btn--secondary">Zoom</button>
  </div>
</div>
```

## Code Block
`.sprinkle-code` — Monospace code display with horizontal scroll.
```html
<pre class="sprinkle-code">SELECT * FROM users LIMIT 10</pre>
```

## Preset Bar
`.sprinkle-presets` — Horizontally scrolling row of small preset buttons. Add `active` class for selected.
```html
<div class="sprinkle-presets">
  <button class="active" onclick="applyPreset('default')">Default</button>
  <button onclick="applyPreset('compact')">Compact</button>
  <button onclick="applyPreset('spacious')">Spacious</button>
</div>
```

## Textarea
`.sprinkle-textarea` — Multi-line text input. Use on `<textarea>`.
```html
<textarea class="sprinkle-textarea" placeholder="Describe your requirements..."></textarea>
```

## Collapsible
`.sprinkle-collapsible` — Styled `<details>/<summary>` disclosure widget.
```html
<details class="sprinkle-collapsible">
  <summary>Advanced Options</summary>
  <div class="sprinkle-stack">
    <!-- content here -->
  </div>
</details>
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
<div class="sprinkle-stack">
  <div>
    <h2 class="sprinkle-heading">Report Title</h2>
    <p class="sprinkle-detail">Context line — source, date</p>
  </div>

  <!-- Top-level KPIs -->
  <div class="sprinkle-grid">
    <div class="sprinkle-stat-card"><div class="value">A</div><div class="label">Grade</div></div>
    <div class="sprinkle-stat-card"><div class="value">12</div><div class="label">Passed</div></div>
    <div class="sprinkle-stat-card"><div class="value">0</div><div class="label">Issues</div></div>
  </div>

  <div class="sprinkle-divider"></div>

  <!-- Findings table with severity badges -->
  <h3 class="sprinkle-body" style="font-weight:600">Issues</h3>
  <table class="sprinkle-table">
    <thead><tr><th>Severity</th><th>Finding</th></tr></thead>
    <tbody>
      <tr>
        <td><span class="sprinkle-badge sprinkle-badge--negative">Critical</span></td>
        <td><strong>Title</strong><br><span class="sprinkle-detail">Description</span></td>
      </tr>
      <tr>
        <td><span class="sprinkle-badge sprinkle-badge--notice">Warning</span></td>
        <td><strong>Title</strong><br><span class="sprinkle-detail">Description</span></td>
      </tr>
    </tbody>
  </table>

  <div class="sprinkle-divider"></div>

  <!-- Passed checks with status lights -->
  <h3 class="sprinkle-body" style="font-weight:600">Passed checks</h3>
  <table class="sprinkle-table">
    <thead><tr><th>Status</th><th>Check</th></tr></thead>
    <tbody>
      <tr><td><span class="sprinkle-status-light sprinkle-status-light--positive">Pass</span></td><td>Check description</td></tr>
    </tbody>
  </table>

  <div class="sprinkle-divider"></div>

  <!-- Stats as key-value list -->
  <h3 class="sprinkle-body" style="font-weight:600">Stats</h3>
  <dl class="sprinkle-kv-list">
    <dt>Metric</dt><dd>Value</dd>
  </dl>

  <p class="sprinkle-detail" style="text-align:center;margin-top:var(--s2-spacing-200)">Footer note</p>
</div>
```
