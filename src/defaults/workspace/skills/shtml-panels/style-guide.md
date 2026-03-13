# SHTML Panel Component Reference

Use these CSS classes in `.shtml` panels. Do NOT write custom CSS — these components cover all common UI patterns.

## Cards
`.shtml-card` — Card with shadow (hover elevates).
`.shtml-stat-card` — Stat card with `.value` + `.label` children.

## Table
`.shtml-table` — Table with bold headers (no uppercase!), row hover, row dividers.

## Badges
`.shtml-badge` — Bold solid-fill badges.
- Color variants: `--positive`, `--negative`, `--notice`, `--informative`, `--accent`
- Styles: `--subtle` (tinted bg), `--outline` (stroke)
- Combine: `shtml-badge shtml-badge--subtle shtml-badge--positive`

## Status Light
`.shtml-status-light` — Dot + label. Variants: `--positive`/`--negative`/`--notice`/`--informative`.

## Buttons
`.shtml-btn` — Pill-rounded buttons.
- `--primary` — accent fill (CTA)
- `--secondary` — outline with hover
- `--negative` — red fill (destructive)
- Add `disabled` attribute for disabled state

`.shtml-btn-group` — Gap-spaced button group (each button keeps pill shape).

## Text Field
`.shtml-text-field` — Styled text input. Use on `<input type="text">`. Supports hover/focus states, placeholder styling. Combine with `.shtml-row` for inline input + button layouts:
```html
<div class="shtml-row">
  <input type="text" class="shtml-text-field" style="flex:1" placeholder="https://example.com">
  <button class="shtml-btn shtml-btn--primary">Go</button>
</div>
```

## Progress Bar
`.shtml-progress-bar` — Two modes:

**Simple** (no label):
```html
<div class="shtml-progress-bar" style="--progress: 75%"></div>
```
Auto-fills via `::after` pseudo-element. No children needed.

**With label**:
```html
<div class="shtml-progress-bar">
  <div class="shtml-progress-bar__header">
    <span class="label">Upload</span>
    <span class="value">75%</span>
  </div>
  <div class="shtml-progress-bar__track">
    <div class="fill" style="width: 75%"></div>
  </div>
</div>
```
The `.fill` child accepts inline `style="width: 75%"` or `data-value="75"`. Alternatively, omit `.fill` and set `--progress` on the container.

**Color variants** on container: `--positive` (green), `--negative` (red), `--notice` (orange), `--informative` (blue).
Inline `--fill-color` overrides the variant color.

## Meter
`.shtml-meter` — Same structure as progress bar but uses `.shtml-meter`, `__header`/`__track`.

**Simple**:
```html
<div class="shtml-meter" style="--value: 50%"></div>
```
Accepts `--value` or `--progress` for fill width.

**Variants**: `--positive`/`--notice`/`--negative` on container. Default color: informative (blue).

## Layout
`.shtml-grid` — Auto-fit responsive grid.
`.shtml-stack` — Vertical stack with gap.
`.shtml-row` — Horizontal flex row, centered.
`.shtml-heading` — Section heading.
`.shtml-body` — Body text.
`.shtml-detail` — Small secondary text.
`.shtml-divider` — Subtle separator line. Add `--medium` for thicker.

## Key-Value List
`.shtml-kv-list` — Key-value pairs. Use `<dl>` with `<dt>`/`<dd>` (preferred) or `<ul>` with `<li>` containing `.key`/`.value` spans. The `<dl>` variant renders as a two-column grid with labels left, values right-aligned bold.

## Empty State
`.shtml-empty-state` — Centered empty state messaging.

---

## Design Guidelines

Panels should look like professional tools, not chatbot output. Follow these rules:

**No emojis in headings or labels.** Use badges, status lights, and semantic color to convey meaning — not 🔍 ❌ ✅ ⚠️ 📊 icons.

**No inline color styles.** Use the semantic variants (`--positive`, `--negative`, `--notice`, `--informative`) instead of hardcoded hex colors.

**Use tables for structured findings.** When presenting lists of issues, checks, or recommendations, use `.shtml-table` with severity badges in the first column — not bullet lists with emoji prefixes.

**Use status lights for pass/fail.** `shtml-status-light--positive` for passed checks, badges for severity levels (Critical, Warning, Advisory).

**Keep headings plain.** Use `shtml-body` with `font-weight:600` for section subheadings, `shtml-heading` for the page title. No emoji, no decorative punctuation.

**Use `shtml-kv-list` for stats.** Key-value pairs belong in a definition list, not stat cards (reserve stat cards for 3–4 top-level KPIs).

### Example: Audit/Report Panel Structure

```html
<title>Report Title</title>
<div class="shtml-stack">
  <div>
    <h2 class="shtml-heading">Report Title</h2>
    <p class="shtml-detail">Context line — source, date</p>
  </div>

  <!-- Top-level KPIs -->
  <div class="shtml-grid">
    <div class="shtml-stat-card"><div class="value">A</div><div class="label">Grade</div></div>
    <div class="shtml-stat-card"><div class="value">12</div><div class="label">Passed</div></div>
    <div class="shtml-stat-card"><div class="value">0</div><div class="label">Issues</div></div>
  </div>

  <div class="shtml-divider"></div>

  <!-- Findings table with severity badges -->
  <h3 class="shtml-body" style="font-weight:600">Issues</h3>
  <table class="shtml-table">
    <thead><tr><th>Severity</th><th>Finding</th></tr></thead>
    <tbody>
      <tr>
        <td><span class="shtml-badge shtml-badge--negative">Critical</span></td>
        <td><strong>Title</strong><br><span class="shtml-detail">Description</span></td>
      </tr>
      <tr>
        <td><span class="shtml-badge shtml-badge--notice">Warning</span></td>
        <td><strong>Title</strong><br><span class="shtml-detail">Description</span></td>
      </tr>
    </tbody>
  </table>

  <div class="shtml-divider"></div>

  <!-- Passed checks with status lights -->
  <h3 class="shtml-body" style="font-weight:600">Passed checks</h3>
  <table class="shtml-table">
    <thead><tr><th>Status</th><th>Check</th></tr></thead>
    <tbody>
      <tr><td><span class="shtml-status-light shtml-status-light--positive">Pass</span></td><td>Check description</td></tr>
    </tbody>
  </table>

  <div class="shtml-divider"></div>

  <!-- Stats as key-value list -->
  <h3 class="shtml-body" style="font-weight:600">Stats</h3>
  <dl class="shtml-kv-list">
    <dt>Metric</dt><dd>Value</dd>
  </dl>

  <p class="shtml-detail" style="text-align:center;margin-top:var(--s2-spacing-200)">Footer note</p>
</div>
```
