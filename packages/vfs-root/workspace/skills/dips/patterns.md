# Dip patterns

A gallery of 10 ready-to-adapt patterns for inline `shtml` widgets. Each pattern is a self-contained example you can copy and modify. See `SKILL.md` for the design rules, card structure, and pre-styled elements that apply to all of them.

## 1. Drag-on-canvas

Drag control points on `<canvas>` — live computed output.

```shtml
<canvas id="c"></canvas>
<div id="output" style="font-family:var(--s2-font-mono);font-size:12px;margin-top:8px"></div>
<button class="sprinkle-btn sprinkle-btn--primary" onclick="slicc.lick({action:'use-value',value:currentValue})">Use this value</button>
<script>
  const cv = document.getElementById('c');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = 640, H = 260;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.height = H + 'px';
  ctx.scale(dpr, dpr);
  // ... hit detection, drag handling, draw loop
</script>
```

**Use for**: easing curves, color gradients, graph layouts, image crop, timeline scrubbing.

## 2. Animated step loop

Async loop with speed slider — algorithm visualization.

```shtml
<div id="bars" style="display:flex;align-items:flex-end;gap:3px;height:160px"></div>
<div style="display:flex;gap:8px;align-items:center;margin-top:8px">
  <button onclick="run()">Run</button>
  <input type="range" id="speed" min="10" max="200" value="80">
  <span id="status" style="font-size:12px;color:var(--s2-content-secondary)">ready</span>
</div>
<script>
  let running = false;
  const delay = () => new Promise(r => setTimeout(r, 210 - speed.value));
  async function run() {
    if (running) return; running = true;
    // algorithm loop with await delay()
    running = false;
  }
</script>
```

**Use for**: sorting algorithms, data pipeline steps, simulation, process walkthroughs.

## 3. Keystroke → live output

`oninput` on text fields — instant transformation/matching.

```shtml
<input type="text" id="pattern" oninput="run()" placeholder="regex pattern">
<textarea id="target" rows="4" oninput="run()">sample text to match</textarea>
<div id="err" style="color:var(--s2-negative);font-size:11px"></div>
<div id="out" style="font-family:var(--s2-font-mono);font-size:12px;padding:10px;background:var(--s2-bg-layer-2);border-radius:8px;margin-top:8px"></div>
<script>
  function run() {
    try {
      const rx = new RegExp(pattern.value, 'gi');
      out.innerHTML = target.value
        .replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))
        .replace(rx, m => '<mark>' + m + '</mark>');
      err.textContent = '';
    } catch(e) { err.textContent = e.message; }
  }
</script>
```

**Use for**: regex testers, format validation, search preview, JSON path, CSS selector testers.

## 4. Slider → DOM reflow

Range slider drives visual output (rendered elements, not charts).

```shtml
<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
  <span style="font-size:12px;color:var(--s2-content-secondary);min-width:60px">Base size</span>
  <input type="range" id="base" min="12" max="24" value="16" step="1" oninput="render()">
  <span id="baseVal" style="font-family:var(--s2-font-mono);font-size:12px;min-width:30px">16</span>
</div>
<div id="scale"></div>
<script>
  function render() {
    const b = +base.value;
    baseVal.textContent = b;
    scale.innerHTML = [3,2,1,0,-1].map(exp => {
      const sz = (b * Math.pow(1.25, exp)).toFixed(1);
      return '<div style="font-size:' + sz + 'px;margin-bottom:4px">Sample — ' + sz + 'px</div>';
    }).join('');
  }
  render();
</script>
```

**Use for**: design token explorers, spacing visualizers, animation timing, grid configurators.

## 5. Multi-slider → computed summary

Multiple sliders feed a formula → metric cards.

```shtml
<div id="controls"></div>
<div id="results" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px"></div>
<script>
  function calc() {
    const v1 = +s1.value, v2 = +s2.value;
    s1out.textContent = v1.toLocaleString();
    s2out.textContent = v2.toLocaleString();
    const result = v1 * v2;
    results.innerHTML = '<div style="background:var(--s2-bg-layer-2);border-radius:8px;padding:12px;text-align:center">' +
      '<div style="font-size:11px;color:var(--s2-content-secondary)">Result</div>' +
      '<div style="font-size:22px;font-weight:700">' + result.toLocaleString() + '</div></div>';
  }
  calc();
</script>
```

**Use for**: pricing calculators, ROI estimators, capacity models, compound growth.

## 6. Cascading sliders

Each stage feeds the next — funnel visualization.

**Use for**: sales funnels, user journey drop-off, referral chains, pipeline modeling.

## 7. Mode picker → visual palette

Select + slider → generated set of visual elements (swatches, variants).

**Use for**: color pickers, design token generators, layout variant pickers.

## 8. Any-field → all-fields sync

Multiple inputs share a single source-of-truth value. Editing any field updates all others.

Use an `updating` flag to prevent `oninput` re-entrancy:

```javascript
let n = 255,
  updating = false;
function setAll() {
  if (updating) return;
  updating = true;
  dec.value = n;
  hex.value = n.toString(16).toUpperCase();
  updating = false;
}
```

**Use for**: unit converters (px/rem, kg/lb, °C/°F), base converters, encoding/decoding pairs.

## 9. Stacked bar + threshold

N sliders → proportional stacked bar → over/under budget indicator.

**Use for**: latency budgets, build timing, resource allocation, sprint capacity, page weight budgets.

## 10. Paste → structured tree

Textarea input → parsed recursive DOM tree with collapse/expand.

**Use for**: JSON explorers, config viewers, log parsers, schema inspectors, AST browsers.
