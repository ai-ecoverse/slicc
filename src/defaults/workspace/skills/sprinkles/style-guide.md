# Sprinkle Component Reference

Use these CSS classes in `.shtml` sprinkles. Do NOT write custom CSS — these components cover all common UI patterns.

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

## Key-Value List
`.sprinkle-kv-list` — Key-value pairs. Use `<dl>` with `<dt>`/`<dd>` (preferred) or `<ul>` with `<li>` containing `.key`/`.value` spans. The `<dl>` variant renders as a two-column grid with labels left, values right-aligned bold.

## Empty State
`.sprinkle-empty-state` — Centered empty state messaging.

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
