# Playground Sprinkle Templates

Complete `.shtml` examples the agent can adapt. Each follows the state/updateAll/debounce pattern.

## A. Design Playground

Interactive design controls for exploring visual options (spacing, radius, colors, shadows).

```html
<title>Design Playground</title>
<div class="sprinkle-stack" data-sprinkle-title="Design Playground">

  <h2 class="sprinkle-heading">Design Playground</h2>
  <p class="sprinkle-detail">Adjust controls to explore design options</p>

  <div class="sprinkle-divider"></div>

  <div class="sprinkle-range">
    <div class="sprinkle-range__header">
      <span class="label">Border Radius</span>
      <span class="value" id="radius-val">8px</span>
    </div>
    <input type="range" id="radius" min="0" max="32" value="8" oninput="updateAll()">
  </div>

  <div class="sprinkle-range">
    <div class="sprinkle-range__header">
      <span class="label">Spacing</span>
      <span class="value" id="spacing-val">16px</span>
    </div>
    <input type="range" id="spacing" min="4" max="48" value="16" oninput="updateAll()">
  </div>

  <div class="sprinkle-range">
    <div class="sprinkle-range__header">
      <span class="label">Font Size</span>
      <span class="value" id="font-val">14px</span>
    </div>
    <input type="range" id="font-size" min="10" max="24" value="14" oninput="updateAll()">
  </div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Color Palette</p>
    <div class="sprinkle-chips" id="palette-chips">
      <button class="sprinkle-chip active" onclick="selectChip(this,'neutral')">Neutral</button>
      <button class="sprinkle-chip" onclick="selectChip(this,'warm')">Warm</button>
      <button class="sprinkle-chip" onclick="selectChip(this,'cool')">Cool</button>
      <button class="sprinkle-chip" onclick="selectChip(this,'vibrant')">Vibrant</button>
    </div>
  </div>

  <label class="sprinkle-color">
    <input type="color" id="accent" value="#6366f1" onchange="updateAll()">
    <span class="label">Accent Color</span>
  </label>

  <label class="sprinkle-toggle">
    <input type="checkbox" id="shadow" checked onchange="updateAll()">
    <span class="label">Drop shadow</span>
  </label>

  <label class="sprinkle-toggle">
    <input type="checkbox" id="hover" checked onchange="updateAll()">
    <span class="label">Hover effect</span>
  </label>

  <div class="sprinkle-divider"></div>

  <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Preview</p>
  <div id="preview" class="sprinkle-card" style="padding:var(--s2-spacing-200);text-align:center">
    <p style="margin:0">Sample component</p>
  </div>

  <div id="result" class="sprinkle-empty-state" style="display:none"></div>
</div>

<script>
var _ready = false;
var state = { radius: 8, spacing: 16, fontSize: 14, palette: 'neutral', accent: '#6366f1', shadow: true, hover: true };
var defaults = Object.assign({}, state);

var _debounceTimer;
function debouncedLick(prompt) {
  if (!_ready) return;
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(function() {
    slicc.lick({ action: 'prompt-updated', data: prompt });
  }, 500);
}

function selectChip(el, value) {
  var chips = el.parentElement.querySelectorAll('.sprinkle-chip');
  for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
  el.classList.add('active');
  state.palette = value;
  updateAll();
}

function updateAll() {
  state.radius = parseInt(document.getElementById('radius').value);
  state.spacing = parseInt(document.getElementById('spacing').value);
  state.fontSize = parseInt(document.getElementById('font-size').value);
  state.accent = document.getElementById('accent').value;
  state.shadow = document.getElementById('shadow').checked;
  state.hover = document.getElementById('hover').checked;

  document.getElementById('radius-val').textContent = state.radius + 'px';
  document.getElementById('spacing-val').textContent = state.spacing + 'px';
  document.getElementById('font-val').textContent = state.fontSize + 'px';

  var preview = document.getElementById('preview');
  preview.style.borderRadius = state.radius + 'px';
  preview.style.padding = state.spacing + 'px';
  preview.style.fontSize = state.fontSize + 'px';
  preview.style.boxShadow = state.shadow ? '0 4px 12px rgba(0,0,0,.15)' : 'none';
  preview.style.borderLeft = '3px solid ' + state.accent;

  var parts = [];
  if (state.radius !== defaults.radius) parts.push(state.radius + 'px border radius');
  if (state.spacing !== defaults.spacing) parts.push(state.spacing + 'px spacing');
  if (state.fontSize !== defaults.fontSize) parts.push(state.fontSize + 'px font size');
  if (state.palette !== defaults.palette) parts.push(state.palette + ' color palette');
  if (state.accent !== defaults.accent) parts.push('accent color ' + state.accent);
  if (state.shadow !== defaults.shadow) parts.push(state.shadow ? 'with shadow' : 'no shadow');
  if (state.hover !== defaults.hover) parts.push(state.hover ? 'with hover effect' : 'no hover effect');

  if (parts.length > 0) debouncedLick('Update the design: ' + parts.join(', ') + '.');
  slicc.setState(state);
}
window.updateAll = updateAll;

slicc.on('update', function(data) {
  var el = document.getElementById('result');
  if (data.html) { el.innerHTML = data.html; el.style.display = 'block'; }
  if (data.status) { el.textContent = data.status; el.style.display = 'block'; }
});

var saved = slicc.getState();
if (saved) {
  Object.assign(state, saved);
  document.getElementById('radius').value = state.radius;
  document.getElementById('spacing').value = state.spacing;
  document.getElementById('font-size').value = state.fontSize;
  document.getElementById('accent').value = state.accent;
  document.getElementById('shadow').checked = state.shadow;
  document.getElementById('hover').checked = state.hover;
  var chips = document.querySelectorAll('#palette-chips .sprinkle-chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('active', chips[i].textContent.toLowerCase() === state.palette);
  }
  updateAll();
}
_ready = true;
</script>
```

## B. Data Explorer

Configure data queries with table/column selection, aggregation, and filters.

```html
<title>Data Explorer</title>
<div class="sprinkle-stack" data-sprinkle-title="Data Explorer">

  <h2 class="sprinkle-heading">Data Explorer</h2>
  <p class="sprinkle-detail">Build a query by selecting options</p>

  <div class="sprinkle-divider"></div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Data Source</p>
    <div class="sprinkle-row">
      <input type="text" class="sprinkle-text-field" style="flex:1" id="source" placeholder="/path/to/data.csv" oninput="updateAll()">
    </div>
  </div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Query Type</p>
    <div class="sprinkle-chips" id="query-chips">
      <button class="sprinkle-chip active" onclick="selectChip(this,'select','queryType')">Select</button>
      <button class="sprinkle-chip" onclick="selectChip(this,'aggregate','queryType')">Aggregate</button>
      <button class="sprinkle-chip" onclick="selectChip(this,'join','queryType')">Join</button>
    </div>
  </div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Aggregation</p>
    <div class="sprinkle-select" style="width:100%">
      <select id="aggregation" style="width:100%" onchange="updateAll()">
        <option value="none">None</option>
        <option value="count">COUNT</option>
        <option value="sum">SUM</option>
        <option value="avg">AVG</option>
        <option value="max">MAX</option>
        <option value="min">MIN</option>
      </select>
    </div>
  </div>

  <div class="sprinkle-range">
    <div class="sprinkle-range__header">
      <span class="label">Row Limit</span>
      <span class="value" id="limit-val">100</span>
    </div>
    <input type="range" id="limit" min="10" max="1000" step="10" value="100" oninput="updateAll()">
  </div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Filter</p>
    <input type="text" class="sprinkle-text-field" style="width:100%" id="filter" placeholder="e.g. total > 50" oninput="updateAll()">
  </div>

  <div class="sprinkle-divider"></div>

  <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Generated Query</p>
  <pre class="sprinkle-code" id="query-preview">-- configure options above</pre>

  <div id="result" style="display:none"></div>
</div>

<script>
var _ready = false;
var state = { source: '', queryType: 'select', aggregation: 'none', limit: 100, filter: '' };
var defaults = Object.assign({}, state);

var _debounceTimer;
function debouncedLick(prompt) {
  if (!_ready) return;
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(function() {
    slicc.lick({ action: 'prompt-updated', data: prompt });
  }, 500);
}

function selectChip(el, value, field) {
  var chips = el.parentElement.querySelectorAll('.sprinkle-chip');
  for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
  el.classList.add('active');
  state[field] = value;
  updateAll();
}

function updateAll() {
  state.source = document.getElementById('source').value;
  state.aggregation = document.getElementById('aggregation').value;
  state.limit = parseInt(document.getElementById('limit').value);
  state.filter = document.getElementById('filter').value;

  document.getElementById('limit-val').textContent = state.limit;

  var preview = '';
  if (state.queryType === 'select') {
    preview = 'SELECT *\nFROM ' + (state.source || 'table') + '\n';
    if (state.filter) preview += 'WHERE ' + state.filter + '\n';
    preview += 'LIMIT ' + state.limit;
  } else if (state.queryType === 'aggregate') {
    var fn = state.aggregation !== 'none' ? state.aggregation.toUpperCase() + '(*)' : 'COUNT(*)';
    preview = 'SELECT ' + fn + '\nFROM ' + (state.source || 'table') + '\n';
    if (state.filter) preview += 'WHERE ' + state.filter;
  } else {
    preview = 'SELECT *\nFROM ' + (state.source || 'table_a') + '\nJOIN table_b ON ...\n';
    if (state.filter) preview += 'WHERE ' + state.filter + '\n';
    preview += 'LIMIT ' + state.limit;
  }
  document.getElementById('query-preview').textContent = preview;

  var parts = [];
  if (state.source) parts.push('from ' + state.source);
  parts.push(state.queryType + ' query');
  if (state.aggregation !== 'none') parts.push(state.aggregation + ' aggregation');
  if (state.filter) parts.push('filtered by: ' + state.filter);
  if (state.limit !== 100) parts.push('limit ' + state.limit + ' rows');

  debouncedLick('Write a query: ' + parts.join(', ') + '.');
  slicc.setState(state);
}
window.updateAll = updateAll;

slicc.on('update', function(data) {
  if (data.query) document.getElementById('query-preview').textContent = data.query;
  var el = document.getElementById('result');
  if (data.html) { el.innerHTML = data.html; el.style.display = 'block'; }
});

var saved = slicc.getState();
if (saved) {
  Object.assign(state, saved);
  document.getElementById('source').value = state.source;
  document.getElementById('aggregation').value = state.aggregation;
  document.getElementById('limit').value = state.limit;
  document.getElementById('filter').value = state.filter;
  var chips = document.querySelectorAll('#query-chips .sprinkle-chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('active', chips[i].textContent.toLowerCase() === state.queryType);
  }
  updateAll();
}
_ready = true;
</script>
```

## C. Concept Map

SVG-based concept mapping with knowledge-level tagging.

```html
<title>Concept Map</title>
<div class="sprinkle-stack" data-sprinkle-title="Concept Map">

  <h2 class="sprinkle-heading">Concept Map</h2>
  <p class="sprinkle-detail">Map relationships between concepts</p>

  <div class="sprinkle-divider"></div>

  <div class="sprinkle-canvas" style="min-height:200px">
    <svg id="map-svg" viewBox="0 0 300 200" style="width:100%;height:200px;background:var(--s2-bg-base)"></svg>
    <div class="sprinkle-canvas__toolbar">
      <button class="sprinkle-btn sprinkle-btn--secondary" style="font-size:var(--s2-font-size-50)" onclick="zoomIn()">+</button>
      <button class="sprinkle-btn sprinkle-btn--secondary" style="font-size:var(--s2-font-size-50)" onclick="zoomOut()">&minus;</button>
    </div>
  </div>

  <div class="sprinkle-row">
    <input type="text" class="sprinkle-text-field" style="flex:1" id="node-name" placeholder="Concept name">
    <button class="sprinkle-btn sprinkle-btn--primary" onclick="addNode()">Add</button>
  </div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Knowledge Level</p>
    <div class="sprinkle-chips" id="level-chips">
      <button class="sprinkle-chip active" onclick="selectLevel(this,'know')">Know</button>
      <button class="sprinkle-chip" onclick="selectLevel(this,'fuzzy')">Fuzzy</button>
      <button class="sprinkle-chip" onclick="selectLevel(this,'unknown')">Unknown</button>
    </div>
  </div>

  <details class="sprinkle-collapsible">
    <summary>Concepts</summary>
    <div id="node-list" class="sprinkle-stack" style="gap:var(--s2-spacing-50)"></div>
  </details>

  <button class="sprinkle-btn sprinkle-btn--primary" style="width:100%" onclick="applyMap()">Apply</button>
</div>

<script>
var state = { nodes: [], selectedNode: null, level: 'know', zoom: 1 };
var levelColors = { know: '#22c55e', fuzzy: '#f59e0b', unknown: '#ef4444' };

function selectLevel(el, value) {
  var chips = el.parentElement.querySelectorAll('.sprinkle-chip');
  for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
  el.classList.add('active');
  state.level = value;
  if (state.selectedNode !== null) {
    state.nodes[state.selectedNode].level = value;
    renderMap();
    slicc.setState(state);
  }
}

function addNode() {
  var input = document.getElementById('node-name');
  var name = input.value.trim();
  if (!name) return;
  state.nodes.push({ name: name, level: state.level, x: 150 + (Math.random() - 0.5) * 100, y: 100 + (Math.random() - 0.5) * 60 });
  input.value = '';
  renderMap();
  slicc.setState(state);
}

function selectNode(idx) {
  state.selectedNode = idx;
  state.level = state.nodes[idx].level;
  var chips = document.querySelectorAll('#level-chips .sprinkle-chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('active', chips[i].textContent.toLowerCase() === state.level);
  }
  renderMap();
}

function removeNode(idx) {
  state.nodes.splice(idx, 1);
  if (state.selectedNode === idx) state.selectedNode = null;
  renderMap();
  slicc.setState(state);
}

function zoomIn() { state.zoom = Math.min(state.zoom + 0.2, 3); renderMap(); }
function zoomOut() { state.zoom = Math.max(state.zoom - 0.2, 0.4); renderMap(); }

function renderMap() {
  var svg = document.getElementById('map-svg');
  var vw = 300 / state.zoom, vh = 200 / state.zoom;
  var ox = (300 - vw) / 2, oy = (200 - vh) / 2;
  svg.setAttribute('viewBox', ox + ' ' + oy + ' ' + vw + ' ' + vh);

  var html = '';
  for (var i = 0; i < state.nodes.length; i++) {
    var n = state.nodes[i];
    var selected = state.selectedNode === i;
    var r = selected ? 22 : 18;
    html += '<circle cx="' + n.x + '" cy="' + n.y + '" r="' + r + '" fill="' + levelColors[n.level] + '" opacity="0.8" stroke="' + (selected ? '#fff' : 'none') + '" stroke-width="2" style="cursor:pointer" onclick="selectNode(' + i + ')"/>';
    html += '<text x="' + n.x + '" y="' + (n.y + r + 12) + '" text-anchor="middle" fill="currentColor" font-size="10">' + n.name + '</text>';
  }
  svg.innerHTML = html;

  var list = document.getElementById('node-list');
  var lhtml = '';
  for (var j = 0; j < state.nodes.length; j++) {
    var nd = state.nodes[j];
    lhtml += '<div class="sprinkle-row" style="justify-content:space-between"><span class="sprinkle-detail">';
    lhtml += '<span class="sprinkle-badge sprinkle-badge--subtle" style="--s2-accent-content:' + levelColors[nd.level] + '">' + nd.level + '</span> ';
    lhtml += nd.name + '</span>';
    lhtml += '<button class="sprinkle-btn sprinkle-btn--secondary" style="font-size:var(--s2-font-size-50);padding:2px 8px" onclick="removeNode(' + j + ')">x</button></div>';
  }
  list.innerHTML = lhtml || '<p class="sprinkle-detail">No concepts added yet</p>';
}

function applyMap() {
  var know = [], fuzzy = [], unknown = [];
  for (var i = 0; i < state.nodes.length; i++) {
    var n = state.nodes[i];
    if (n.level === 'know') know.push(n.name);
    else if (n.level === 'fuzzy') fuzzy.push(n.name);
    else unknown.push(n.name);
  }
  var parts = [];
  if (know.length) parts.push('I understand: ' + know.join(', '));
  if (fuzzy.length) parts.push("I'm fuzzy on: " + fuzzy.join(', '));
  if (unknown.length) parts.push("I don't know: " + unknown.join(', '));
  if (parts.length === 0) return;
  slicc.lick({ action: 'prompt-updated', data: parts.join('. ') + '. Explain the relationships and fill my gaps.' });
}

slicc.on('update', function(data) {
  if (data.nodes) { state.nodes = data.nodes; renderMap(); slicc.setState(state); }
});

var saved = slicc.getState();
if (saved) { Object.assign(state, saved); }
renderMap();
</script>
```

## D. Document Critique

Configure document review parameters and receive structured feedback.

```html
<title>Document Critique</title>
<div class="sprinkle-stack" data-sprinkle-title="Document Critique">

  <h2 class="sprinkle-heading">Document Critique</h2>
  <p class="sprinkle-detail">Configure review parameters</p>

  <div class="sprinkle-divider"></div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Document Path</p>
    <div class="sprinkle-row">
      <input type="text" class="sprinkle-text-field" style="flex:1" id="doc-path" placeholder="/path/to/document" oninput="updateAll()">
      <button class="sprinkle-btn sprinkle-btn--primary" onclick="loadDoc()">Load</button>
    </div>
  </div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Focus Areas</p>
    <div class="sprinkle-chips" id="focus-chips">
      <button class="sprinkle-chip active" data-value="clarity" onclick="toggleChip(this)">Clarity</button>
      <button class="sprinkle-chip active" data-value="tone" onclick="toggleChip(this)">Tone</button>
      <button class="sprinkle-chip" data-value="structure" onclick="toggleChip(this)">Structure</button>
      <button class="sprinkle-chip" data-value="grammar" onclick="toggleChip(this)">Grammar</button>
      <button class="sprinkle-chip" data-value="accuracy" onclick="toggleChip(this)">Accuracy</button>
    </div>
  </div>

  <div class="sprinkle-range">
    <div class="sprinkle-range__header">
      <span class="label">Strictness</span>
      <span class="value" id="strict-val">Medium</span>
    </div>
    <input type="range" id="strictness" min="1" max="3" value="2" oninput="updateAll()">
  </div>

  <label class="sprinkle-toggle">
    <input type="checkbox" id="suggestions" checked onchange="updateAll()">
    <span class="label">Include suggestions</span>
  </label>

  <div class="sprinkle-divider"></div>

  <div id="results"></div>
</div>

<script>
var _ready = false;
var state = { docPath: '', focus: ['clarity', 'tone'], strictness: 2, suggestions: true };
var strictLabels = { 1: 'Lenient', 2: 'Medium', 3: 'Strict' };

var _debounceTimer;
function debouncedLick(prompt) {
  if (!_ready) return;
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(function() {
    slicc.lick({ action: 'prompt-updated', data: prompt });
  }, 500);
}

function toggleChip(el) {
  el.classList.toggle('active');
  state.focus = [];
  var chips = document.querySelectorAll('#focus-chips .sprinkle-chip.active');
  for (var i = 0; i < chips.length; i++) state.focus.push(chips[i].dataset.value);
  updateAll();
}

function loadDoc() {
  var path = document.getElementById('doc-path').value.trim();
  if (path) slicc.lick({ action: 'load-document', data: path });
}

function updateAll() {
  state.docPath = document.getElementById('doc-path').value;
  state.strictness = parseInt(document.getElementById('strictness').value);
  state.suggestions = document.getElementById('suggestions').checked;

  document.getElementById('strict-val').textContent = strictLabels[state.strictness];

  if (state.docPath && state.focus.length > 0) {
    var prompt = 'Critique this document focusing on ' + state.focus.join(' and ');
    prompt += ', strictness level: ' + strictLabels[state.strictness].toLowerCase();
    if (state.suggestions) prompt += ', include improvement suggestions';
    prompt += '.';
    debouncedLick(prompt);
  }
  slicc.setState(state);
}
window.updateAll = updateAll;

slicc.on('update', function(data) {
  var el = document.getElementById('results');
  if (data.html) el.innerHTML = data.html;
});

var saved = slicc.getState();
if (saved) {
  Object.assign(state, saved);
  document.getElementById('doc-path').value = state.docPath;
  document.getElementById('strictness').value = state.strictness;
  document.getElementById('suggestions').checked = state.suggestions;
  var chips = document.querySelectorAll('#focus-chips .sprinkle-chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('active', state.focus.indexOf(chips[i].dataset.value) >= 0);
  }
  updateAll();
}
_ready = true;
</script>
```

## E. Diff Review

Configure code diff review parameters.

```html
<title>Diff Review</title>
<div class="sprinkle-stack" data-sprinkle-title="Diff Review">

  <h2 class="sprinkle-heading">Diff Review</h2>
  <p class="sprinkle-detail">Configure diff review parameters</p>

  <div class="sprinkle-divider"></div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">File A</p>
    <input type="text" class="sprinkle-text-field" style="width:100%" id="file-a" placeholder="/path/to/file-a" oninput="updateAll()">
  </div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">File B</p>
    <input type="text" class="sprinkle-text-field" style="width:100%" id="file-b" placeholder="/path/to/file-b" oninput="updateAll()">
  </div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Review Focus</p>
    <div class="sprinkle-chips" id="review-chips">
      <button class="sprinkle-chip active" data-value="bugs" onclick="toggleChip(this)">Bugs</button>
      <button class="sprinkle-chip" data-value="style" onclick="toggleChip(this)">Style</button>
      <button class="sprinkle-chip" data-value="performance" onclick="toggleChip(this)">Performance</button>
      <button class="sprinkle-chip" data-value="security" onclick="toggleChip(this)">Security</button>
    </div>
  </div>

  <label class="sprinkle-toggle">
    <input type="checkbox" id="verbose" onchange="updateAll()">
    <span class="label">Verbose output</span>
  </label>

  <button class="sprinkle-btn sprinkle-btn--primary" style="width:100%" onclick="runReview()">Review</button>

  <div class="sprinkle-divider"></div>

  <div id="results"></div>
</div>

<script>
var state = { fileA: '', fileB: '', focus: ['bugs'], verbose: false };

function toggleChip(el) {
  el.classList.toggle('active');
  state.focus = [];
  var chips = document.querySelectorAll('#review-chips .sprinkle-chip.active');
  for (var i = 0; i < chips.length; i++) state.focus.push(chips[i].dataset.value);
  updateAll();
}

function updateAll() {
  state.fileA = document.getElementById('file-a').value;
  state.fileB = document.getElementById('file-b').value;
  state.verbose = document.getElementById('verbose').checked;
  slicc.setState(state);
}
window.updateAll = updateAll;

function runReview() {
  if (!state.fileA || !state.fileB) return;
  var prompt = 'Review changes between ' + state.fileA + ' and ' + state.fileB;
  prompt += ', focusing on ' + state.focus.join(' and ');
  if (state.verbose) prompt += ', provide verbose explanations';
  prompt += '.';
  slicc.lick({ action: 'prompt-updated', data: prompt });
}

slicc.on('update', function(data) {
  var el = document.getElementById('results');
  if (data.html) el.innerHTML = data.html;
});

var saved = slicc.getState();
if (saved) {
  Object.assign(state, saved);
  document.getElementById('file-a').value = state.fileA;
  document.getElementById('file-b').value = state.fileB;
  document.getElementById('verbose').checked = state.verbose;
  var chips = document.querySelectorAll('#review-chips .sprinkle-chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('active', state.focus.indexOf(chips[i].dataset.value) >= 0);
  }
}
</script>
```

## F. Code Map

Explore codebase architecture with configurable depth and file filters.

```html
<title>Code Map</title>
<div class="sprinkle-stack" data-sprinkle-title="Code Map">

  <h2 class="sprinkle-heading">Code Map</h2>
  <p class="sprinkle-detail">Explore codebase architecture</p>

  <div class="sprinkle-divider"></div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">Root Path</p>
    <input type="text" class="sprinkle-text-field" style="width:100%" id="root-path" placeholder="/workspace/src" oninput="updateAll()">
  </div>

  <div class="sprinkle-range">
    <div class="sprinkle-range__header">
      <span class="label">Depth</span>
      <span class="value" id="depth-val">3</span>
    </div>
    <input type="range" id="depth" min="1" max="6" value="3" oninput="updateAll()">
  </div>

  <div>
    <p class="sprinkle-detail" style="margin-bottom:var(--s2-spacing-50)">File Types</p>
    <div class="sprinkle-chips" id="type-chips">
      <button class="sprinkle-chip active" data-value=".ts" onclick="toggleChip(this)">.ts</button>
      <button class="sprinkle-chip" data-value=".js" onclick="toggleChip(this)">.js</button>
      <button class="sprinkle-chip" data-value=".py" onclick="toggleChip(this)">.py</button>
      <button class="sprinkle-chip" data-value=".rs" onclick="toggleChip(this)">.rs</button>
      <button class="sprinkle-chip" data-value=".go" onclick="toggleChip(this)">.go</button>
    </div>
  </div>

  <label class="sprinkle-toggle">
    <input type="checkbox" id="deps" checked onchange="updateAll()">
    <span class="label">Show dependencies</span>
  </label>

  <button class="sprinkle-btn sprinkle-btn--primary" style="width:100%" onclick="analyze()">Analyze</button>

  <div class="sprinkle-divider"></div>

  <div id="results"></div>
</div>

<script>
var state = { rootPath: '', depth: 3, fileTypes: ['.ts'], showDeps: true };

function toggleChip(el) {
  el.classList.toggle('active');
  state.fileTypes = [];
  var chips = document.querySelectorAll('#type-chips .sprinkle-chip.active');
  for (var i = 0; i < chips.length; i++) state.fileTypes.push(chips[i].dataset.value);
  updateAll();
}

function updateAll() {
  state.rootPath = document.getElementById('root-path').value;
  state.depth = parseInt(document.getElementById('depth').value);
  state.showDeps = document.getElementById('deps').checked;
  document.getElementById('depth-val').textContent = state.depth;
  slicc.setState(state);
}
window.updateAll = updateAll;

function analyze() {
  if (!state.rootPath) return;
  var prompt = 'Analyze architecture of ' + state.rootPath;
  prompt += ' at depth ' + state.depth;
  if (state.fileTypes.length) prompt += ', focusing on ' + state.fileTypes.join(', ') + ' files';
  if (state.showDeps) prompt += ', include dependency analysis';
  prompt += '.';
  slicc.lick({ action: 'prompt-updated', data: prompt });
}

slicc.on('update', function(data) {
  var el = document.getElementById('results');
  if (data.html) el.innerHTML = data.html;
});

var saved = slicc.getState();
if (saved) {
  Object.assign(state, saved);
  document.getElementById('root-path').value = state.rootPath;
  document.getElementById('depth').value = state.depth;
  document.getElementById('deps').checked = state.showDeps;
  var chips = document.querySelectorAll('#type-chips .sprinkle-chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('active', state.fileTypes.indexOf(chips[i].dataset.value) >= 0);
  }
  updateAll();
}
</script>
```
