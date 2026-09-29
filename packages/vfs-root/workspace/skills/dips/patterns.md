# Dip patterns

10 copy-adapt `shtml` widgets. Design rules + card structure: `SKILL.md`.

> **Every example:** (1) S2 tokens / `light-dark()` — no hard-coded themes; (2) no `height`/`max-height`/`min-height`/`overflow:auto|scroll` on dip containers (iframe auto-sizes). **Exception:** `<canvas>` needs pixel dimensions for the drawing buffer.

## 1. Drag-on-canvas

Control points on canvas → live output. `slicc.lick({action:'use-value',data:{value:…}})` to commit.

```shtml
<canvas id="c"></canvas>
<script>
  const W=640,H=260,dpr=window.devicePixelRatio||1;
  cv.width=W*dpr; cv.height=H*dpr; cv.style.height=H+'px'; ctx.scale(dpr,dpr);
</script>
```

Easing curves, gradients, crop, timeline scrub.

## 2. Animated step loop

Async loop + speed slider. Bars: `align-items:flex-end`, no fixed height.

```shtml
<div id="bars" style="display:flex;align-items:flex-end;gap:3px"></div>
<input type="range" id="speed" min="10" max="200" value="80">
<script>const delay=()=>new Promise(r=>setTimeout(r,210-speed.value));</script>
```

Sorting viz, pipelines, simulations.

## 3. Keystroke → live output

`oninput` transforms. Escape HTML before highlighting.

```shtml
<input id="pattern" oninput="run()">
<textarea id="target" oninput="run()"></textarea>
<div id="out" style="font-family:var(--s2-font-mono)"></div>
```

Regex testers, JSON path, CSS selectors.

## 4. Slider → DOM reflow

Range drives rendered elements (not charts):

```shtml
<input type="range" id="base" min="12" max="24" value="16" oninput="render()">
<div id="scale"></div>
```

Design tokens, spacing, animation timing.

## 5. Multi-slider → computed summary

Multiple sliders feed a formula → metric cards in `display:grid`:

```shtml
<div id="controls"></div>
<div id="results" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px"></div>
```

Pricing, ROI, capacity models.

## 6. Cascading sliders

Each stage feeds next — funnel viz.

Sales funnels, drop-off, referral chains.

## 7. Mode picker → visual palette

Select + slider → swatches/variants.

Color pickers, token generators.

## 8. Any-field → all-fields sync

Shared value; `updating` flag prevents `oninput` re-entrancy:

```javascript
let updating = false;
function setAll() {
  if (updating) return;
  updating = true;
  /* sync */ updating = false;
}
```

Unit/base converters, encoders.

## 9. Stacked bar + threshold

N sliders → proportional bar → over/under budget.

Latency budgets, sprint capacity, page weight.

## 10. Paste → structured tree

Textarea → recursive DOM tree, collapse/expand.

JSON explorers, log parsers, AST browsers.
