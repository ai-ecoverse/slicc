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

Dips are inline `shtml` code blocks in chat that hydrate into sandboxed interactive widgets. **Ephemeral** — no state persistence, no `readFile`. Only `slicc.lick()` is available for agent communication.

**Use them generously.** A dip is the right answer any time a response could benefit from visualization, interaction, or a moment of delight. Don't reserve them for "complex" tasks — a slider that lets the user feel a number, a chart that beats a paragraph of stats, a button that's faster than typing "yes" all earn their keep.

| Reach for a dip when …                                 | Reach for a sprinkle when …                                     |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| The answer would land better as a widget than as prose | The user needs a persistent dashboard / editor / multi-page app |
| The user is choosing, confirming, or tuning a value    | The UI must survive across turns or sessions                    |
| You want a chart, animation, or interactive demo       | You need `readFile`, `screenshot`, or any persistent state      |
| The result deserves a bit of fun                       | The interaction is long-running                                 |

For a gallery of 10 ready-to-adapt patterns (drag-on-canvas, slider→DOM reflow, paste→tree, ...) read the companion file: `read_file /workspace/skills/dips/patterns.md`.

## Card structure

Always wrap interactive content in `.sprinkle-action-card` for visual containment. Don't output bare HTML — cards need a visible boundary.

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

When the user clicks a button, you receive the lick as a message. Respond conversationally, with another dip, or by spawning a scoop.

### Use existing components inside cards

- **Progress** → `.sprinkle-progress-bar` with `--progress` CSS variable. Not raw colored divs.
- **Status indicators** → `.sprinkle-status-light` with `--positive` / `--negative` / `--notice` variants.
- **Stats** → `.sprinkle-stat-card` grid.
- **Tables** → `.sprinkle-table` with `.sprinkle-badge` for severity.
- **Badges** → `.sprinkle-badge` variants (`--positive`, `--negative`, `--notice`, `--informative`).

Multiple cards in one message: each is a separate `.sprinkle-action-card`. The iframe padding handles spacing. Don't wrap multiple cards in a single container.

## Pre-styled form elements

Inside dips, bare HTML form elements are pre-styled to match S2:

- `<input type="range">` — 4px track, 18px accent thumb.
- `<input type="text">`, `<textarea>` — S2 layer-2 background, accent focus ring.
- `<select>` — S2 styled with focus ring.
- `<button>` — pill-rounded, 28px height, hover state. Use `.sprinkle-btn--primary` class for the accent fill.
- `<canvas>` — full-width, rounded corners.
- `<mark>` — accent-tinted highlight.

No custom CSS needed for basic widgets. Just write bare HTML.

## Color palette for charts

Use these classes on chart elements, diagram nodes, or badges. Two or three colors per visualization, not six. Assign by meaning, not by sequence.

| Class       | Use for                 |
| ----------- | ----------------------- |
| `.c-purple` | Primary category, AI/ML |
| `.c-teal`   | Success, growth         |
| `.c-coral`  | Secondary category      |
| `.c-pink`   | Tertiary category       |
| `.c-gray`   | Neutral, structural     |
| `.c-blue`   | Informational           |
| `.c-amber`  | Warning, in-progress    |
| `.c-red`    | Error, critical         |
| `.c-green`  | Success, complete       |

## Layout & viewport

Dips render in the chat column. They are **single-column by design** — don't author multi-column or sidebar+main layouts. The chat column is narrow on iOS / Sliccstart and on the extension side panel; multi-column dips break visually in those floats. If you need multi-column, use a sprinkle and let the user pop it to full-screen.

## Cheap interactions via `agent`

When a dip's lick handler needs to do real work (lookup, transformation, generation) but the cone or owning scoop should NOT be woken up, route the lick to a one-shot `agent` call.

The flow:

1. Dip emits a lick: `slicc.lick({action: 'compute', input: ...})`.
2. The lick reaches the cone (or scoop) as a message.
3. Instead of replying conversationally, the receiver shells out to `agent` with a tight allow-list and a self-contained prompt.
4. `agent` returns the answer on stdout. The receiver writes the result back to the dip via a follow-up dip or via `sprinkle send` (if the dip was the entry point to a sprinkle flow).

```bash
# Inside a feed_scoop reply to a dip lick:
result=$(agent /tmp "curl,jq" "Fetch <url>, return field 'price' as a number.")
# Render a fresh dip with `result` inline.
```

`agent` is the right tool here because it has **no handoff**: ephemeral scoops don't notify the cone on completion, so a busy cone or sprinkle-owning scoop isn't pre-empted by every dip click. See `/workspace/skills/delegation/SKILL.md` for the full `agent` reference.

## Design rules

- Use S2 CSS variables for all colors (`var(--s2-content-default)`, `var(--s2-bg-layer-2)`, ...).
- Round all displayed numbers: `Math.round()`, `.toFixed(2)`, `.toLocaleString()`.
- Set `step` on range sliders for clean values.
- Show errors inline (not `alert()`).
- Sentence case always — never Title Case or ALL CAPS.
- One root `render()` / `calc()` function triggered by all inputs.
- Call `render()` on load with defaults so the widget is immediately interactive.

## Don't

- Don't hardcode hex colors — use S2 CSS variables.
- Don't build custom progress bars — use `.sprinkle-progress-bar`.
- Don't build custom status dots — use `.sprinkle-status-light`.
- Don't use numbered headings (1. File Operations) inside cards — the `__header` IS the heading.
- Don't put prose / markdown headings between cards — let cards stand alone.

## Lick patterns

```javascript
// Explicit "send to agent" button.
slicc.lick({ action: 'use-config', config: getCurrentConfig() });

// Lick on threshold crossing.
if (total > budget) {
  slicc.lick({ action: 'over-budget', total, budget, breakdown });
}

// Lick on completion.
slicc.lick({ action: 'sort-complete', algorithm: algo, comparisons: n });
```

The agent receives the lick as a structured message and can respond with prose, another dip, or spawn a scoop.
