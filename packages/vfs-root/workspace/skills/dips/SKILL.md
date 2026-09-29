---
name: dips
description: |
  Use this whenever a response could benefit from richer visualization, guided
  interaction, or a touch of fun — pickers, calculators, sliders, mini
  explorers, charts, animated demos, choose-your-own-adventure prompts,
  anything that lands better as a hydrating widget than as plain prose. Dips
  are ephemeral `shtml` code blocks rendered inline in chat (no state
  persistence, lick-only). Reach for them generously: every interactive moment
  the user gets is a moment they don't have to type a clarifying message. For
  persistent dashboards, editors, or multi-page apps use sprinkles instead.
allowed-tools: bash
---

# Dips

Inline `shtml` → sandboxed widgets. **Ephemeral** — no persistence, no `readFile`. Only `slicc.lick(event)`; pack `{ action, data: { ... } }`.

| Dip when …                   | Sprinkle when …                       |
| ---------------------------- | ------------------------------------- |
| Widget beats prose           | Persistent dashboard/editor           |
| Choosing, confirming, tuning | Survives across turns                 |
| Chart, animation, demo       | Needs `readFile`, `screenshot`, state |
| Bit of fun                   | Long-running                          |

Patterns gallery: `read_file /workspace/skills/dips/patterns.md`.

## Card structure

Wrap in `.sprinkle-action-card`:

```shtml
<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">Title <span class="sprinkle-badge sprinkle-badge--notice">Status</span></div>
  <div class="sprinkle-action-card__body">Description text</div>
  <div class="sprinkle-action-card__actions">
    <button class="sprinkle-btn sprinkle-btn--secondary" onclick="slicc.lick('cancel')">Cancel</button>
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick('confirm')">Confirm</button>
  </div>
</div>
```

Components: `.sprinkle-progress-bar` (`--progress`), `.sprinkle-status-light`, `.sprinkle-stat-card`, `.sprinkle-table`, `.sprinkle-badge` (`--positive`, `--negative`, `--notice`, `--informative`). Multiple cards: separate `.sprinkle-action-card` each; host adds spacing — no custom card margins.

## Forms & sizing

Bare form elements are pre-styled to match S2: range (4px track, 18px thumb), text/textarea (layer-2 bg, accent focus; `rows` ok — no `overflow:auto` or fixed height), select, button (pill, 28px; `.sprinkle-btn--primary` for accent), canvas (full-width, rounded), mark (accent highlight). No custom CSS for basics.

Iframe auto-sizes via `ResizeObserver`. **Never** `height`/`max-height`/`min-height`/`overflow:auto|scroll` on containers. Exception: `<canvas>` needs pixel `width`/`height`. Long content → sprinkle.

## Theme

Inherits parent S2 tokens; `.theme-light` toggles on iframe `<html>`. Use `var(--s2-*)` or `light-dark()` — not `@media (prefers-color-scheme)`. See `/workspace/skills/sprinkles/style-guide.md`.

## Chart colors

| Class       | Use             |
| ----------- | --------------- |
| `.c-purple` | Primary, AI/ML  |
| `.c-teal`   | Success, growth |
| `.c-coral`  | Secondary       |
| `.c-pink`   | Tertiary        |
| `.c-gray`   | Neutral         |
| `.c-blue`   | Info            |
| `.c-amber`  | Warning         |
| `.c-red`    | Error           |
| `.c-green`  | Complete        |

Two–three colors per viz, by meaning.

## Layout

Single-column only. Multi-column → sprinkle.

## `agent` for cheap work

Dip lick → cone shells `agent` with tight allow-list; stdout → follow-up dip.

```bash
result=$(agent "$TMPDIR" "curl,jq" "Fetch <url>, return field 'price' as a number.")
```

No handoff — ephemeral scoops don't notify cone. See `/workspace/skills/delegation/SKILL.md`.

## Design rules

- S2 tokens for colors; round numbers; `step` on sliders; inline errors; sentence case.
- One root `render()`/`calc()`; call on load with defaults.

## Don't

- Hex colors, `@media (prefers-color-scheme)`, fixed heights/scrollers (except canvas).
- Custom progress/status dots.
- Numbered headings inside cards.
- Prose between cards.

## Lick patterns

```javascript
slicc.lick({ action: 'use-config', data: { config: getCurrentConfig() } });
if (total > budget) slicc.lick({ action: 'over-budget', data: { total, budget, breakdown } });
slicc.lick({ action: 'sort-complete', data: { algorithm: algo, comparisons: n } });
```

`slicc.lick(eventOrAction)` accepts a plain string (`'cancel'`) or `{ action, data? }`. **Always pack extra fields in `data: { ... }`** — cone reads `event.data`; top-level extras get dropped or misfolded. Agent receives the lick and can reply with prose, another dip, or spawn a scoop.
