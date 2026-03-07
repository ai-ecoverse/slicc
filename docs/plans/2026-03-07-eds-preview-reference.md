# EDS Preview & Migration Reference — From vibemigration Deep Dive

Reference document for the SKILL.md rewrite. Based on complete reading of
vibemigration sandbox skills, EDS boilerplate, overlay detection, and capture-and-diff.

---

## 1. How EDS Pages Render

### The Load Sequence
1. Browser loads `.plain.html` content (wrapped by `aem up` into full HTML)
2. `head.html` is injected into `<head>` — contains:
   ```html
   <script nonce="aem" src="/scripts/aem.js" type="module"></script>
   <script nonce="aem" src="/scripts/scripts.js" type="module"></script>
   <link rel="stylesheet" href="/styles/styles.css"/>
   ```
3. `aem.js` runs `setup()` — determines `codeBasePath` from script URL
4. `scripts.js` runs `loadPage()`:
   - `loadEager()` → decorateMain → load first section's blocks
   - `loadLazy()` → loadHeader (fetches nav.plain.html) → load remaining sections → loadFooter (fetches footer.plain.html)
   - `loadDelayed()` → analytics after 3s

### codeBasePath
Determined from the script src URL. If `scripts.js` is at `/scripts/scripts.js`,
then `codeBasePath = ''`. All block/style/icon loading uses this prefix:
- `${codeBasePath}/blocks/{name}/{name}.js`
- `${codeBasePath}/blocks/{name}/{name}.css`
- `${codeBasePath}/icons/{name}.svg`

### Fragment Loading
Header block loads nav via: `fetch('/drafts/nav.plain.html')` (path from `<meta name="nav">`)
Footer block loads footer via: `fetch('/drafts/footer.plain.html')` (path from `<meta name="footer">`)

---

## 2. .plain.html Format

### Rules
- Extension MUST be `.plain.html`
- Contains ONLY content structure — NO `<html>`, `<head>`, `<body>`, `<script>` tags
- `aem up` wraps it automatically with head.html contents

### Block Content Model
```html
<div class="block-name">           <!-- Block with class = block name -->
  <div>                            <!-- Row -->
    <div>Column content</div>      <!-- Cell -->
    <div>Column content</div>      <!-- Cell -->
  </div>
  <div>                            <!-- Row 2 -->
    <div>Column content</div>
  </div>
</div>
```

### Section Metadata
```html
<div class="section-metadata">
  <div><div>style</div><div>dark-background</div></div>
</div>
```

### Page Metadata (at end of main)
```html
<div class="metadata">
  <div><div>nav</div><div>/drafts/nav</div></div>
  <div><div>footer</div><div>/drafts/footer</div></div>
  <div><div>title</div><div>Page Title</div></div>
</div>
```

---

## 3. Project Structure (aem up --html-folder drafts)

```
repo-root/
  head.html                  ← script + style includes
  blocks/{name}/{name}.js|css ← block code
  scripts/aem.js             ← EDS core (DO NOT modify)
  scripts/scripts.js         ← site initialization
  styles/styles.css          ← base styles
  drafts/                    ← --html-folder content
    nav.plain.html           ← header fragment
    footer.plain.html        ← footer fragment
    {page}.plain.html        ← page content
    block-samples/           ← block test pages
      {block}.plain.html
    images/                  ← downloaded images
```

---

## 4. vibemigration Sandbox — Block Migration Workflow

### 6 Steps
1. **Subagent captures**: `analyze-source-component.js` → component.png, component.html,
   computed-styles.json, image-manifest.json, images/
2. **Subagent matches**: searches Block Collection for closest match
3. **Subagent extracts tokens**: design tokens from computed-styles.json
4. **Main agent generates**: blocks/{name}/{name}.js + .css
5. **Main agent reviews content**: edit (NOT rewrite) the draft .plain.html
6. **Visual diff loop**: capture-and-diff.js (max 3 iterations)

### capture-and-diff.js Output
```json
{
  "capture": { "screenshot", "boundingBox", "computedStyles" },
  "diff": { "similarityScore", "regions" (3x3 grid), "suggestions" },
  "cssGaps": [ { "property", "source", "rendered", "priority" } ],
  "contentVerification": { "hash", "snapshotPath" }
}
```

CSS gap priorities: padding=9, fontSize=8, backgroundColor=8, color=7, margin=7

### Hard Rules
- NEVER more than 3 capture-and-diff iterations
- NEVER write custom Playwright scripts (use capture-and-diff.js only)
- NEVER put `<html>/<head>/<body>/<script>` in .plain.html
- Use Edit for surgical .plain.html changes, not Write
- If improvement < 3% from last iteration, STOP

---

## 5. vibemigration Sandbox — Header Migration Workflow

### Key Differences from Blocks
- Fixed output: always `nav.plain.html` + copy header.js/header.css from skill
- Detect single-row vs multi-section header
- CSS specificity: all rules must be `.header.block`-scoped
- Target 90% similarity (not 95%)
- Max 5 iterations (not 3)

### Section Styles
- `brand` — logo area
- `top-bar` — announcement bar
- `main-nav` — primary navigation (+ Mobile Style: accordion|slide-in|fullscreen)
- `utility` — login/signup/search

---

## 6. Overlay Detection (Three-Tier Pipeline)

### Flow
1. **Triage (Haiku)**: screenshot → "are there overlays?" → if no, exit
2. **Heuristics**: known vendor selectors (OneTrust, Cookiebot, Intercom, Zendesk, Drift)
   + generic patterns ([class*="cookie"], fixed elements with high z-index >20% viewport)
3. **Full LLM (Sonnet)**: screenshot + accessibility tree → precise selectors

### Actions
- `click` — dismiss button (200ms delay)
- `remove` — element.remove() (fallback)

### Known Vendors
| Vendor | Banner Selector | Dismiss Selector |
|--------|----------------|-----------------|
| OneTrust | `#onetrust-consent-sdk` | `#onetrust-accept-btn-handler` |
| Cookiebot | `#CybotCookiebotDialog` | `#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll` |
| CookieConsent | `.cc-window` | `.cc-btn.cc-dismiss` |
| Intercom | `#intercom-container` | `.intercom-launcher` |
| Zendesk | `#launcher` | `[data-testid="launcher"]` |
| Drift | `#drift-widget` | `.drift-widget-close-icon` |

### Integration Point
Called BEFORE page preparation (fix fixed elements, trigger lazy loading)
and BEFORE screenshot + visual tree capture.

---

## 7. Slicc-Specific: Preview SW + EDS Mode

### The Problem
EDS uses root-relative paths (`/scripts/aem.js`, `/blocks/hero/hero.js`).
The preview SW scope is `/preview/`. Pages must be under `/preview/` for the
SW to control them. Root-relative requests from controlled pages ARE
intercepted by the SW (per spec).

### EDS Project Mode
`browser serve` with `edsProject: true`:
1. Sends `set-eds-project-root` to SW via postMessage
2. Opens page at `/preview/{project-path}/drafts/{page}.html`
3. SW intercepts root-relative requests → resolves against project root
4. `/scripts/aem.js` → VFS `{projectRoot}/scripts/aem.js`

### What Scoops Need to Know
Since we don't have `aem up` wrapping .plain.html automatically, scoops must:
1. Read `head.html` from the repo
2. Create a full HTML wrapper page for preview:
   ```html
   <html><head>
     {contents of head.html — with paths adjusted}
   </head><body>
     <header></header>
     <main>{.plain.html content}</main>
     <footer></footer>
   </body></html>
   ```
3. Save as `drafts/{block}-preview.html` (NOT as .plain.html)
4. Serve with `edsProject: true`
5. The EDS scripts will bootstrap, decorate blocks, load fragments

### Three Path Contexts
1. **Production EDS** (.plain.html): `/drafts/images/hero.jpg` (root-relative to project)
2. **Slicc preview** (wrapper HTML): paths resolve via SW's EDS project mode
3. **VFS absolute** (for tool operations): `/shared/{repo}/drafts/images/hero.jpg`

### The Scrolling Issue
Slicc sets `html, body { overflow: hidden }` which leaks into preview tabs.
Workaround: add `html, body { overflow: auto !important; }` to brand.css.
