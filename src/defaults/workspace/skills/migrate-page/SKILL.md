---
name: migrate-page
description: Migrate a web page to AEM Edge Delivery Services. Extracts page structure, decomposes into blocks, generates EDS-compatible code, and verifies with visual comparison.
allowed-tools: migrate_page,browser,read_file,write_file,edit_file,bash
---

# EDS Page Migration

Migrate a web page into AEM Edge Delivery Services: extract structure,
decompose into blocks, generate EDS-compatible code per block, and verify
each with visual comparison.

## Triggers

"migrate this page", "convert to EDS", "create EDS blocks from URL".
User provides a URL and a GitHub repo (owner/repo).

## Four Phases

1. **Extraction** — call `migrate_page` tool
2. **Decomposition** — classify visual tree into fragments/sections/blocks
3. **Block Generation** — one scoop per block, parallel
4. **Assembly** — collect results, build page, commit

---

## Phase 1: Extraction

```json
{ "url": "https://example.com/page", "repo": "owner/repo-name" }
```

This clones the repo to `/shared/{repo-name}/`, creates a migration branch,
navigates to the URL, and produces artifacts in `/shared/{repo-name}/.migration/`:

| Artifact | Purpose |
|----------|---------|
| `screenshot.png` | Full-page screenshot for decomposition |
| `visual-tree.json` | Spatial hierarchy (bounds, backgrounds, selectors) — for decomposition ONLY |
| `brand.json` | Fonts, colors, spacing |
| `metadata.json` | Title, description, OG tags |
| `block-inventory.json` | Existing blocks in the EDS project |

---

## Phase 2: Decomposition

Read `visual-tree.json` and `screenshot.png`. The visual tree is used ONLY
for decomposition (identifying what regions exist and classifying them). It
is NOT used for content extraction — scoops extract content from the live
page in Phase 3.

### Visual Tree Format

```
{id} [{role/tag}] [{CxR}] [{bg:type}] @{x},{y} {w}x{h} "{text}"
```

Hierarchy via 2-space indentation. `{id}` is a positional identifier
(e.g., `rc1c2`). `[CxR]` = columns x rows layout. `[bg:type]` =
background signal.

### Classification Rules

**THE TYPING TEST:** Can an author create this in Word/Google Docs?
- YES → `default-content`
- NO → `block`

**Layout rule:** `[CxR]` with C >= 2 → MUST be `block`.

**Background rule:** Background transitions signal section boundaries.

**Reserved names:** NEVER use "header" or "footer" as block names.

### Three Fragments

Every page decomposes into exactly 3 fragments:
1. `/nav` — header/navigation
2. `/{page-path}` — main content
3. `/footer` — page footer

### Output

Write `decomposition.json` to `/shared/{repo-name}/.migration/`:

```json
{
  "url": "https://example.com/page",
  "fragments": [
    {
      "path": "/nav",
      "children": [
        { "type": "block", "name": "nav-bar", "id": "rc1",
          "bounds": { "x": 0, "y": 0, "width": 1440, "height": 80 } }
      ]
    },
    {
      "path": "/page",
      "children": [
        { "type": "section", "style": "highlight", "children": [
          { "type": "block", "name": "hero", "id": "rc2c1" },
          { "type": "default-content", "id": "rc2c2" }
        ]},
        { "type": "block", "name": "cards", "id": "rc3" }
      ]
    },
    {
      "path": "/footer",
      "children": [
        { "type": "block", "name": "footer-links", "id": "rc4" }
      ]
    }
  ]
}
```

---

## Phase 3: Block Generation (Parallel Scoops)

Create one scoop per **block**. **Do NOT drop scoops** — keep them alive
for user review and debugging. Never call `drop_scoop` during migration.

**`default-content` items do NOT get scoops.** They are simple prose
(headings, paragraphs, lists, images) that the cone writes directly
during Phase 4 assembly. The cone extracts default-content text from
the source page and writes it inline in the assembled .plain.html.

```
scoop_scoop({ "name": "hero-block" })
feed_scoop({ "name": "hero-block-scoop", "prompt": "<FULL PROMPT BELOW>" })
```

### CRITICAL: What to Include in the Scoop Prompt

Scoops have NO access to the cone's conversation. The prompt must be
completely self-contained. Include ALL of the following:

1. Block name, source URL, visual tree ID, bounds
2. The EDS project path: `/shared/{repo-name}/`
3. The FULL content of `head.html` (read it first with `read_file`)
4. The image path convention (documented below)
5. The preview scaffolding instructions (documented below)
6. The .plain.html format rules
7. The visual verification loop
8. The report schema

### Scoop Prompt Template

````
You are migrating a single visual component into an AEM Edge Delivery
Services block.

## Source

- Block name: {blockName}
- Source URL: {sourceUrl}
- Visual tree ID: {id}
- Bounds: x={x}, y={y}, width={w}, height={h}
- EDS project: /shared/{repo-name}/

## Step 1: Extract Content from Source Page

The visual tree is for decomposition only — it does NOT contain the
actual content you need. You MUST navigate to the source page and
extract content directly:

```json
{{ "action": "navigate", "url": "{sourceUrl}" }}
```

Then use `evaluate` to extract the component's content:

```json
{{ "action": "evaluate", "expression": "..." }}
```

Extract: headings, paragraphs, links (href + text), image URLs (src + alt),
button text, any structured data. Use the CSS selector from the visual tree
or a selector you identify from the DOM.

## Step 2: Download Images

Download all images from the source component to `/shared/{repo-name}/drafts/images/`:

For each image URL found in Step 1, use the JavaScript tool or browser
evaluate to fetch the image and save it:

```javascript
const resp = await fetch('https://source-site.com/image.jpg');
const bytes = new Uint8Array(await resp.arrayBuffer());
await fs.writeFile('/shared/{repo-name}/drafts/images/image.jpg', bytes);
```

Image paths in .plain.html files use root-relative paths:
`/drafts/images/image.jpg`

## Step 3: Write .plain.html Content

Write to `/shared/{repo-name}/drafts/{blockName}.plain.html`

### .plain.html Format — STRICT RULES

The .plain.html file contains ONLY content structure:

```html
<div>
  <div class="{blockName}">
    <div>
      <div><picture><img src="/drafts/images/hero.jpg" alt="Hero"></picture></div>
      <div><h2>Heading</h2><p>Description</p></div>
    </div>
    <div>
      <div><picture><img src="/drafts/images/card.jpg" alt="Card"></picture></div>
      <div><h3>Card Title</h3><p>Card text</p></div>
    </div>
  </div>
</div>
```

**NEVER include in .plain.html:**
- `<html>`, `<head>`, `<body>` tags
- `<script>` or `<style>` tags
- Inline styles
- Any wrapper outside the content

**Structure:**
- Outer `<div>` = section wrapper
- `<div class="{blockName}">` = block container (class = block name)
- Each child `<div>` of the block = a row
- Each child `<div>` of a row = a cell
- Cells contain plain HTML: `<h2>`, `<p>`, `<a>`, `<picture><img>`, `<ul>`

**Images:** Wrap in `<picture>` tags. Use root-relative paths.
In EDS project mode, the preview service worker automatically resolves
root-relative paths like `/drafts/images/hero.jpg` against the project
root in VFS. Do NOT use `/preview/shared/...` or `/shared/...` absolute
paths in .plain.html — those are VFS paths, not EDS paths.

Root-relative image paths:
`/drafts/images/filename.jpg`

## Step 4: Write Block CSS

Write to `/shared/{repo-name}/blocks/{blockName}/{blockName}.css`

```css
.{blockName} {{
  --block-bg: #value;
  --block-text: #value;
  --block-padding: value;
  --block-gap: value;

  background: var(--block-bg);
  color: var(--block-text);
  padding: var(--block-padding);
}}

.{blockName} h2 {{
  font-family: var(--heading-font-family, sans-serif);
}}

@media (width >= 900px) {{
  .{blockName} > div > div {{
    display: flex;
    gap: var(--block-gap);
  }}
}}
```

Extract design tokens from the source (colors, spacing, typography).
Scope ALL styles under `.{blockName}`. Use CSS custom properties.

## Step 5: Write Block JS

Write to `/shared/{repo-name}/blocks/{blockName}/{blockName}.js`

```js
export default async function decorate(block) {{
  const rows = [...block.children];
  rows.forEach((row) => {{
    const cells = [...row.children];
    // Restructure cells as needed
  }});
}}
```

The function receives the block `<div>` after EDS converts authored
content into nested divs. Restructure the DOM for the desired layout.

## Step 6: Preview with EDS Framework

This is the critical step. You need to create a **preview wrapper page**
that loads the EDS framework so your block gets properly decorated.

### 6a. Read head.html

The repo's `head.html` contains the EDS bootstrap:

{HEAD_HTML_CONTENT}

### 6b. Create Preview Wrapper Page

Write to `/shared/{repo-name}/drafts/{blockName}-preview.html`
(NOT .plain.html — this is a full HTML page for preview only):

```html
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="nav" content="/drafts/nav">
  <meta name="footer" content="/drafts/footer">
  {PASTE ALL <script> AND <link> TAGS FROM head.html HERE}
  <style>html, body {{ overflow: auto !important; }}</style>
</head>
<body>
  <header></header>
  <main>
    {PASTE THE CONTENT OF YOUR .plain.html FILE HERE}
  </main>
  <footer></footer>
</body>
</html>
```

**Key points:**
- Paste the `<script>` and `<link>` tags EXACTLY as they appear in `head.html`
  (including `nonce` attributes if present)
- Add `<meta name="nav">` and `<meta name="footer">` for fragment loading
- Add `overflow: auto !important` to fix SLICC scrolling
- Paste the .plain.html content inside `<main>`
- `<header>` and `<footer>` are empty — EDS fills them from fragments

**Note:** Block previews may show empty headers/footers if the nav/footer
scoops haven't completed yet. This is expected — focus on the block itself.
- `<header>` and `<footer>` are empty — EDS fills them from fragments

### 6c. Serve with EDS Project Mode

```json
{{ "action": "serve", "directory": "/shared/{repo-name}",
   "entry": "drafts/{blockName}-preview.html", "edsProject": true }}
```

The `edsProject: true` flag tells the preview service worker to resolve
root-relative paths (`/scripts/aem.js`, `/styles/styles.css`,
`/blocks/{blockName}/{blockName}.js`) from the VFS project directory.

## Step 7: Visual Verification (Max 3 Iterations)

For each iteration:

1. **Screenshot the source component:**
   Navigate to the source URL, then screenshot the component region.

2. **Screenshot the preview:**
   Screenshot the preview tab from Step 6c.

3. **Compare:** Read both screenshots. Identify the top 2-3 CSS gaps:
   - Padding/margin differences (highest priority)
   - Font size/weight/family differences
   - Background color/gradient differences
   - Layout/flex direction differences

4. **Fix:** Make surgical CSS edits. Do NOT rewrite entire files.
   After editing CSS, reload the preview tab and re-screenshot.

**Stop conditions:**
- After iteration 3: finalize regardless
- If improvement < 3% from last iteration: accept and stop

## Step 8: Write Report

Write JSON report to `/shared/{repo-name}/.migration/reports/{blockName}-report.json`:

```json
{{
  "blockName": "{blockName}",
  "sourceUrl": "{sourceUrl}",
  "timestamp": "<ISO 8601>",
  "status": "success|partial|failed",
  "files": {{
    "css": "blocks/{blockName}/{blockName}.css",
    "js": "blocks/{blockName}/{blockName}.js",
    "plainHtml": "drafts/{blockName}.plain.html",
    "previewHtml": "drafts/{blockName}-preview.html"
  }},
  "images": [
    {{ "source": "https://...", "local": "/drafts/images/file.jpg" }}
  ],
  "visualVerification": {{
    "iterationsUsed": 2,
    "previewWorked": true,
    "iterations": [
      {{ "iteration": 1, "changes": "...", "gaps": ["..."] }},
      {{ "iteration": 2, "changes": "...", "gaps": ["..."] }}
    ],
    "finalAssessment": "..."
  }},
  "contentModel": {{
    "rows": 2,
    "description": "Hero with image left, text+CTA right"
  }},
  "designTokens": {{
    "--block-bg": "#1a1a2e",
    "--block-text": "#ffffff"
  }},
  "issues": ["..."]
}}
```

**ALL reports MUST use this exact schema.** Do not add extra top-level keys
or rename fields.

Then `send_message` to the cone with: block name, status, iteration count,
report path, any blocking issues.
````

### Header Block — Special Case

For the nav/header block, the scoop prompt should include these
differences from the standard block prompt:

- Output is `drafts/nav.plain.html` (not `drafts/{blockName}.plain.html`)
- Block CSS/JS goes to `blocks/header/header.css` and `blocks/header/header.js`
- If the repo already has `blocks/header/`, use the existing header block
  code and only generate `nav.plain.html`
- Detect single-row vs multi-section header from the source page
- Use section-metadata with Style values: `brand`, `top-bar`, `main-nav`, `utility`
- CSS specificity: all rules scoped under `.header.block` (not just `.header`)
- Target 90% visual similarity (not 95%)

### Footer Block — Special Case

- Output is `drafts/footer.plain.html`
- Block CSS/JS goes to `blocks/footer/footer.css` and `blocks/footer/footer.js`
- If the repo already has `blocks/footer/`, use existing code

---

## Phase 4: Assembly

After all scoops complete, collect results and assemble the full page.

**Do NOT drop scoops.** Keep them alive for user review.

### 1. Read Reports

Read all reports from `/shared/{repo-name}/.migration/reports/`.
Check status of each block. Note any failures or issues.

### 2. Generate brand.css

Read `.migration/brand.json`. Write `/shared/{repo-name}/styles/brand.css`:

```css
:root {
  --heading-font-family: "extracted-font", serif;
  --body-font-family: "extracted-font", sans-serif;
  --background-color: #fff;
  --text-color: #1a1a2e;
  --link-color: #0066cc;
  --link-hover-color: #004499;
  --section-padding: 64px 24px;
  --nav-height: 80px;
}

/* Fix SLICC preview scrolling */
html, body { overflow: auto !important; }
```

### 3. Assemble Page Content

Write the main page to `/shared/{repo-name}/drafts/{page-path}.plain.html`.

Combine all blocks from the decomposition into a single .plain.html:

```html
<div>
  <div class="hero">
    <div>
      <div><picture><img src="/drafts/images/hero.jpg" alt="Hero"></picture></div>
      <div><h2>Hero Heading</h2><p>Hero text</p></div>
    </div>
  </div>
</div>
<div>
  <div class="cards">
    <div>
      <div><picture><img src="/drafts/images/card1.jpg" alt="Card"></picture></div>
      <div><h3>Card Title</h3><p>Card text</p></div>
    </div>
  </div>
</div>
<div>
  <div class="metadata">
    <div><div>nav</div><div>/drafts/nav</div></div>
    <div><div>footer</div><div>/drafts/footer</div></div>
    <div><div>title</div><div>Page Title</div></div>
  </div>
</div>
```

**Rules:**
- Each section is a top-level `<div>`
- Blocks inside sections use `<div class="blockname">`
- The **metadata block** at the end points to nav and footer fragments
- Section dividers are implicit (each top-level div is a section)
- Images use `/drafts/images/` paths

### 4. Create Full Preview Page

Write `/shared/{repo-name}/drafts/{page-path}-preview.html` — a full
HTML page for previewing the assembled result. Same pattern as block
preview: `head.html` contents + metadata + main content + header/footer.

Serve with:
```json
{ "action": "serve", "directory": "/shared/{repo-name}",
  "entry": "drafts/{page-path}-preview.html", "edsProject": true }
```

### 5. Git Commit

```bash
git add blocks/ styles/brand.css drafts/
git commit -m "feat: migrate {page-path} from {source-domain}"
```

### 6. Final Summary

Report to the user:
- Number of blocks migrated
- Visual verification results per block
- Any issues or gaps
- How to preview: the URL of the served preview page
- Path to all reports in `.migration/reports/`

---

## Reference: Four Content Models

1. **Standalone** — One-off (hero, blockquote): single row, mixed cells
2. **Collection** — Repeating items (cards, carousel): rows = items,
   cells = item parts (image, title, description)
3. **Configuration** — Key-value pairs (blog listing config): 2-column,
   col1 = key, col2 = value. Only for API-driven content.
4. **Auto-Blocked** — Authors write standard content, pattern detection
   creates block (tabs, accordion). Rare in migration.

Use Standalone or Collection for most blocks. NEVER use Configuration
for static content.

## Reference: Quality Criteria

| Criterion | Target |
|-----------|--------|
| Block visual similarity | >= 85% acceptable, >= 95% ideal |
| Header visual similarity | >= 85% (interactive states differ) |
| Max iterations per block | 3 |
| Max iterations for header | 5 |
| .plain.html format | NO html/head/body/script tags |
| CSS scoping | All rules under .blockname |
| Header CSS scoping | All rules under .header.block |
| Responsive | At least one breakpoint (900px) |
| Images | <picture><img> with alt text |
| Report schema | Exact schema, no extra keys |
