# Playground Sprinkle Patterns

Reusable code patterns for building playground sprinkles.

## State + updateAll Skeleton

**Note**: The renderer auto-hoists all declared functions (`function foo()` and `var foo = function`) to `window` scope. You can still add explicit `window.updateAll = updateAll;` for clarity, but it's no longer required.

**Critical**: Use `_ready` guard to suppress licks during initialization/state-restore. Without this, the sprinkle fires a lick on load, the scoop starts processing, and user interactions fire more licks before the scoop finishes — the scoop gets stuck in processing state forever.

```javascript
var _ready = false; // suppress licks until initialization is complete
var state = {
  spacing: 12,
  radius: 8,
  palette: 'neutral',
  shadow: true
};

function updateAll() {
  // 1. Read control values into state
  state.spacing = parseInt(document.getElementById('spacing').value);
  state.radius = parseInt(document.getElementById('radius').value);
  // ...

  // 2. Update value displays
  document.getElementById('spacing-val').textContent = state.spacing + 'px';

  // 3. Render preview (if applicable)
  renderPreview();

  // 4. Generate and send prompt (only after init)
  if (_ready) {
    var prompt = generatePrompt();
    debouncedLick(prompt);
  }

  // 5. Persist state
  slicc.setState(state);
}

// Optional: explicit hoist (renderer auto-hoists all declared functions)
window.updateAll = updateAll;
```

## Debounce Helper

```javascript
var _debounceTimer;
function debouncedLick(prompt) {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(function() {
    slicc.lick({ action: 'prompt-updated', data: prompt });
  }, 500);
}
```

## State Persistence

```javascript
// Restore on load — sets controls from saved state WITHOUT firing licks
var saved = slicc.getState();
if (saved) {
  Object.assign(state, saved);
  document.getElementById('spacing').value = state.spacing;
  document.getElementById('radius').value = state.radius;
  // ... restore other controls
  updateAll(); // updates UI + preview, but _ready=false so no lick fires
}
_ready = true; // NOW user interactions will send licks
```

## Prompt Generation

Generate natural-language prompts that describe only non-default values:

```javascript
function generatePrompt() {
  var parts = [];
  if (state.spacing !== 12) parts.push(state.spacing + 'px spacing');
  if (state.radius !== 8) parts.push(state.radius + 'px border radius');
  if (state.palette !== 'neutral') parts.push(state.palette + ' color palette');
  if (!state.shadow) parts.push('no shadow');

  if (parts.length === 0) return 'Use default settings.';
  return 'Update the component with: ' + parts.join(', ') + '.';
}
```

## Chip Selection (Single)

```html
<div class="sprinkle-chips" id="palette-chips">
  <button class="sprinkle-chip active" onclick="selectChip(this, 'neutral')">Neutral</button>
  <button class="sprinkle-chip" onclick="selectChip(this, 'warm')">Warm</button>
  <button class="sprinkle-chip" onclick="selectChip(this, 'cool')">Cool</button>
</div>
```

```javascript
function selectChip(el, value) {
  var container = el.parentElement;
  var chips = container.querySelectorAll('.sprinkle-chip');
  for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
  el.classList.add('active');
  state.palette = value;
  updateAll();
}
```

## Chip Selection (Multi)

```javascript
function toggleChip(el, value) {
  el.classList.toggle('active');
  // Rebuild array from active chips
  var chips = el.parentElement.querySelectorAll('.sprinkle-chip.active');
  state.selected = [];
  for (var i = 0; i < chips.length; i++) {
    state.selected.push(chips[i].dataset.value);
  }
  updateAll();
}
```

## Range Slider with Live Value

```html
<div class="sprinkle-range">
  <div class="sprinkle-range__header">
    <span class="label">Spacing</span>
    <span class="value" id="spacing-val">12px</span>
  </div>
  <input type="range" id="spacing" min="0" max="48" value="12" oninput="updateAll()">
</div>
```

## Toggle with Label

```html
<label class="sprinkle-toggle">
  <input type="checkbox" checked onchange="updateAll()">
  <span class="label">Enable shadow</span>
</label>
```

## Custom CSS

Write `<style>` blocks directly in your `.shtml` for custom layouts. They work in both CLI and extension modes.

```html
<style>
  .node { fill: var(--s2-accent); cursor: pointer; }
  .node:hover { fill: var(--s2-informative); }
  .preview-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
</style>
```

Use `var(--s2-*)` tokens for theme consistency.

## Sidebar + Main Layout

For sprinkles with controls on one side and preview on the other:

```html
<div class="sprinkle-sidebar">
  <div class="sprinkle-sidebar__aside">
    <!-- controls -->
    <div class="sprinkle-stack">
      <div class="sprinkle-range">...</div>
      <div class="sprinkle-chips">...</div>
    </div>
  </div>
  <div class="sprinkle-sidebar__main">
    <!-- preview area -->
    <div id="preview"></div>
  </div>
</div>
```

In the narrow sidebar view this stacks vertically; in expanded full-page mode the sidebar gets 280px.

## Tab Switching

For sprinkles with multiple panels:

```javascript
function switchTab(btn, panelId) {
  var tabs = btn.parentElement.parentElement;
  var buttons = tabs.querySelectorAll('.sprinkle-tabs__tab');
  var panels = tabs.querySelectorAll('.sprinkle-tabs__panel');
  for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove('active');
  for (var i = 0; i < panels.length; i++) panels[i].classList.remove('active');
  btn.classList.add('active');
  document.getElementById(panelId).classList.add('active');
}
```

## Receiving Agent Results

```javascript
slicc.on('update', function(data) {
  // data is whatever the agent sent via: sprinkle send <name> '<json>'
  if (data.html) {
    document.getElementById('preview').innerHTML = data.html;
  }
  if (data.status) {
    document.getElementById('status').textContent = data.status;
  }
});
```
