---
name: migrate-page
description: Migrate a web page to AEM Edge Delivery Services. Extracts page structure, decomposes into blocks, generates EDS-compatible code, and verifies with visual comparison.
allowed-tools: migrate_page,browser,read_file,write_file,edit_file,bash
---

# EDS Page Migration

Migrate an entire web page into AEM Edge Delivery Services: extract structure, decompose into blocks, generate EDS-compatible code per block, and verify each with visual comparison.

## When to Use This Skill

Use when the user provides a URL and a GitHub repo and wants to migrate a full page (or major page sections) to EDS. Typical triggers: "migrate this page", "convert to EDS", "create EDS blocks from URL".

## Overview

The migration runs in four phases:

1. **Extraction** -- call `migrate_page` to capture page artifacts
2. **Decomposition** -- classify the visual tree into fragments, sections, blocks, and default content
3. **Block Generation** -- create a scoop per block, generate CSS/JS/HTML, verify visually
4. **Assembly** -- collect results, generate brand.css, build page HTML, commit

---

## Phase 1: Extraction

Call the `migrate_page` tool with the source URL and target repo:

```json
{ "url": "https://example.com/landing", "repo": "owner/repo-name" }
```

This clones the repo to `/shared/{repo-name}/`, creates a migration branch,
and produces extraction artifacts in `/shared/{repo-name}/.migration/`:

| Artifact | Description |
|----------|-------------|
| `screenshot.png` | Full-page screenshot of the source |
| `visual-tree.json` | Spatial hierarchy with bounds, backgrounds, selectors |
| `brand.json` | Extracted fonts, colors, spacing |
| `metadata.json` | Title, description, OG tags, JSON-LD |
| `block-inventory.json` | Existing blocks in the EDS project |

The visual tree is the primary input for decomposition.

### Image Handling

Download images from the source page to the EDS project and use **relative paths**.

1. **Download images** to `/shared/{repo-name}/images/` using the browser tool:
   ```json
   { "action": "evaluate", "expression": "..." }
   ```
   Or use the JavaScript tool to fetch and save images.

2. **Reference with relative paths** in block HTML:
   ```html
   <img src="./images/hero.jpg" alt="Hero">
   ```

3. **Preview with EDS mode**: serve the project with `edsProject: true` so root-relative paths (`/styles/`, `/scripts/`, `/blocks/`) resolve correctly — this emulates `aem up`:
   ```json
   { "action": "serve", "directory": "/shared/{repo-name}", "entry": "drafts/index.html", "edsProject": true }
   ```
   Content HTML and images go in the `drafts/` subfolder (like `aem up --html-folder drafts`).

**Do NOT use absolute VFS paths** like `/shared/{repo-name}/images/hero.jpg` in HTML `src` attributes — use paths relative to the EDS project root (e.g., `/drafts/images/hero.jpg`).

---

## Phase 2: Decomposition

Read `visual-tree.txt` and `screenshot.png` to classify every visual region.

### Visual Tree Format

Each line follows:

```
{id} [{role/tag}] [{CxR}] [{bg:type}] @{x},{y} {w}x{h} "{text}"
```

| Field | Meaning |
|-------|---------|
| `{id}` | Positional identifier (e.g., `rc1c2`) -- position in the DOM tree |
| `[role/tag]` | ARIA role or HTML tag if present |
| `[CxR]` | Layout descriptor -- columns x rows (e.g., `[4x1]` = 4 columns, 1 row). Only present on multi-column containers. |
| `[bg:type]` | Visual background: `[bg:color]`, `[bg:gradient]`, or `[bg:image]` |
| `@x,y` | Top-left position in pixels from page origin |
| `{w}x{h}` | Width and height in pixels |
| `"{text}"` | First 30 characters of text content |

Hierarchy is expressed by 2-space indentation per nesting level.

### EDS Document Structure

Every page decomposes into exactly **3 fragments**:

1. `/nav` -- header/navigation (typically `<header>`)
2. `/{page-path}` -- main content (typically `<main>`)
3. `/footer` -- footer (typically `<footer>`)

Each fragment contains an ordered sequence of **children**:

- **section**: visual grouping with optional styling (maps to `---` divider in EDS)
- **block**: structured component requiring a block table (Hero, Cards, Columns, etc.)
- **default-content**: simple prose that authors type directly (headings, paragraphs, lists)

Sections can nest blocks and default-content as children.

### Classification Rules

**THE TYPING TEST:** "Can an author create this by typing in Word/Google Docs?"

- YES --> `default-content`
- NO --> `block`

**Layout rule:** Any node with a `[CxR]` layout descriptor where C >= 2 MUST be classified as `block`. Multi-column arrangements cannot be created by typing in a document.

**Background rule:** Background transitions (`[bg:type]` changes) between adjacent nodes signal section boundaries.

**Block indicators:** `[CxR]` with C >= 2, grid layout, repeating cards, columns side-by-side, carousel, tabs, accordion, interactive widgets, navigation menu.

**Default-content indicators:** heading, paragraph, bulleted list, simple image, text links, prose flow.

**Reserved names:** Never use "header" or "footer" as block names. These are reserved EDS built-in blocks. Use descriptive alternatives: "nav-bar", "footer-links", "footer-content".

### Decomposition Output

Write `decomposition.json` to `/shared/{repo-name}/.migration/`:

```json
{
  "url": "https://example.com/landing",
  "title": "Landing Page",
  "viewport": { "width": 1440, "height": 900 },
  "fragments": [
    {
      "path": "/nav",
      "children": [
        {
          "type": "block",
          "name": "nav-bar",
          "id": "rc1",
          "bounds": { "x": 0, "y": 0, "width": 1440, "height": 80 },
          "confidence": 0.95
        }
      ]
    },
    {
      "path": "/landing",
      "children": [
        {
          "type": "section",
          "name": "Hero Section",
          "id": "rc2c1",
          "bounds": { "x": 0, "y": 80, "width": 1440, "height": 600 },
          "style": "highlight",
          "children": [
            { "type": "block", "name": "hero", "id": "rc2c1c1", "bounds": { "x": 0, "y": 80, "width": 1440, "height": 500 }, "confidence": 0.9 },
            { "type": "default-content", "name": "Intro Text", "id": "rc2c1c2", "bounds": { "x": 100, "y": 580, "width": 1240, "height": 100 }, "confidence": 0.85 }
          ]
        },
        {
          "type": "block",
          "name": "cards",
          "id": "rc2c2",
          "bounds": { "x": 0, "y": 700, "width": 1440, "height": 400 },
          "confidence": 0.95
        }
      ]
    },
    {
      "path": "/footer",
      "children": [
        { "type": "block", "name": "footer-links", "id": "rc3c1", "bounds": { "x": 0, "y": 1100, "width": 1440, "height": 200 }, "confidence": 0.9 }
      ]
    }
  ]
}
```

**Rules:**

1. Fragments have paths, not selectors -- identified by semantic role.
2. Copy IDs exactly from the visual tree. Do not invent or modify them.
3. Preserve visual order -- children array matches top-to-bottom page order.
4. Sections are optional -- if content lacks clear visual grouping, use blocks/default-content directly.
5. Confidence: 0.0-1.0 indicating classification certainty.
6. Style: optional section style hint (e.g., "highlight", "dark", "centered").

---

## Phase 3: Block Generation (Parallel Scoops)

For each block in `decomposition.json`, create a scoop and delegate block migration to it. Blocks can be processed in parallel.

### Creating Scoops

For each block, use `scoop_scoop` to create a dedicated scoop, then `feed_scoop` with a complete self-contained prompt.

```
scoop_scoop({ "name": "hero-block" })
feed_scoop({ "name": "hero-block", "message": "<full prompt below>" })
```

### Scoop Prompt Template

Feed each scoop a self-contained prompt. The scoop has no access to the cone's conversation, so include everything it needs.

````
You are migrating a single visual component into an AEM Edge Delivery Services block.

## Source Component

Block name: {blockName}
Source URL: {sourceUrl}
Visual tree ID: {id}
Bounds: {bounds}

Read the following files to understand the source component:
- /shared/{repo-name}/.migration/screenshot.png (full page -- focus on the region at y={bounds.y} to y={bounds.y + bounds.height})
- /shared/{repo-name}/.migration/visual-tree.json (DOM structure with selectors)
- /shared/{repo-name}/.migration/brand.json (fonts, colors, spacing)

IMPORTANT: Download source images to `/shared/{repo-name}/images/` and use relative paths (e.g., `./images/hero.jpg`). Do NOT use absolute VFS paths in HTML.

## EDS Block CSS Pattern

Write `blocks/{blockName}/{blockName}.css`:

```css
.{blockName} {{
  /* Design tokens extracted from source */
  --block-bg: #value;
  --block-text: #value;
  --block-accent: #value;
  --block-padding: value;
  --block-heading-size: value;
  --block-gap: value;

  background: var(--block-bg);
  color: var(--block-text);
  padding: var(--block-padding);
}}

.{blockName} h1,
.{blockName} h2 {{
  font-size: var(--block-heading-size);
  /* Override global heading styles if needed */
  font-family: var(--heading-font-family, sans-serif);
  font-style: normal;
}}

/* Responsive */
@media (width >= 900px) {{
  .{blockName} .{blockName}-wrapper {{
    display: flex;
    gap: var(--block-gap);
  }}
}}
```

Use CSS custom properties for all design tokens. Scope everything under `.{blockName}`. Include responsive breakpoints.

## EDS Block JS Pattern

Write `blocks/{blockName}/{blockName}.js`:

```js
export default async function decorate(block) {{
  // block is the <div> containing the authored content rows
  // Each direct child is a row, each child of a row is a cell

  const rows = [...block.children];

  // Example: restructure into semantic markup
  rows.forEach((row) => {{
    const cells = [...row.children];
    // Transform cells into the desired DOM structure
  }});

  // Add wrapper classes for styling hooks
  block.classList.add('{blockName}-wrapper');
}}
```

The `decorate` function receives the block `<div>` after EDS has converted the authored table into nested divs. Restructure the DOM to match the desired visual layout. Do NOT fetch external resources or add `<script>` tags.

## EDS Block Content Model

Write the test page at `/shared/{repo-name}/drafts/{blockName}.plain.html`:

The content model uses an HTML table structure that EDS converts to nested divs:

```html
<div>
  <div class="{blockName}">
    <div>
      <div><!-- Row 1, Cell 1: e.g., image --><img src="/drafts/images/hero.jpg" alt="description"></div>
      <div><!-- Row 1, Cell 2: e.g., text --><h2>Heading</h2><p>Description text</p></div>
    </div>
    <div>
      <div><!-- Row 2, Cell 1 --></div>
    </div>
  </div>
</div>
```

Rules:
- File extension MUST be `.plain.html`
- Contains ONLY `<div>` structure -- NO `<html>`, `<head>`, `<body>`, `<script>` tags
- Outer wrapper: `<div><div class="{blockName}">...</div></div>`
- Each direct child of the block div is a row; each child of a row is a cell
- Use root-relative image paths within the EDS project (e.g., `/drafts/images/hero.jpg`)
- Map source content (headings, text, images, links) into rows/columns

## Visual Verification Loop

After writing the block files and test page, verify visual parity. You have a maximum of **3 iterations**.

For each iteration:

1. **Serve the preview:**
   ```json
   browser({{ "action": "serve", "directory": "/shared/{repo-name}", "entry": "drafts/{blockName}.plain.html", "edsProject": true }})
   ```

2. **Screenshot the source component region:**
   ```json
   browser({{ "action": "screenshot", "selector": "...", "path": "/shared/{repo-name}/.migration/source-{blockName}.png" }})
   ```
   Or crop from the full-page screenshot based on bounds.

3. **Screenshot the preview:**
   ```json
   browser({{ "action": "screenshot", "path": "/shared/{repo-name}/.migration/preview-{blockName}.png" }})
   ```

4. **Compare visually:** Read both screenshots. Identify the top 2-3 CSS differences.

5. **Fix:** Make targeted CSS/JS edits. Do NOT rewrite entire files -- surgical changes only.

After iteration 3, finalize regardless of remaining differences. Report the final visual quality and any gaps.

## Output

When finished, use `send_message` to report back:
- Block name and files created
- Number of visual iterations used
- Remaining visual gaps (if any)
- Paths to all generated files
````

### Header Block Special Case

Headers require special handling because they render as the EDS `header` built-in block loading `/nav.plain.html`.

For header/navigation blocks:
- Output file is `nav.plain.html` (not a regular block)
- Block name in code is `header` (the EDS reserved name)
- Structure uses section-metadata divs for multi-section headers
- Must detect single-row vs multi-section layout

**Single-row header** (logo + nav + utility on one line):

```html
<div>
  <p><a href="/"><img src="./images/logo.png" alt="Company"></a></p>
  <ul>
    <li><a href="/products">Products</a>
      <ul>
        <li><a href="/products/a">Product A</a></li>
      </ul>
    </li>
    <li><a href="/about">About</a></li>
  </ul>
  <p><a href="/login">Login</a></p>
  <div class="section-metadata">
    <div><div>Style</div><div>main-nav</div></div>
  </div>
</div>
```

**Multi-section header** (stacked rows: brand, top-bar, main-nav, utility):

```html
<div>
  <p><img src="./images/logo.png" alt="Company"></p>
  <div class="section-metadata">
    <div><div>Style</div><div>brand</div></div>
  </div>
</div>
<div>
  <ul>
    <li><a href="/products">Products</a></li>
  </ul>
  <div class="section-metadata">
    <div><div>Style</div><div>main-nav</div></div>
  </div>
</div>
```

Section styles: `brand` (logo area), `top-bar` (announcements), `main-nav` (primary navigation), `utility` (login/search/cart).

---

## Phase 4: Assembly

After all scoops complete, collect their results and assemble the full page.

### 1. Generate brand.css

Extract brand-level design tokens from `page-metadata.json` and `computed-styles.json`. Write to `styles/brand.css`:

```css
:root {
  /* Typography */
  --heading-font-family: "Source Serif Pro", serif;
  --body-font-family: "Open Sans", sans-serif;
  --fixed-font-family: "Roboto Mono", monospace;

  /* Colors */
  --background-color: #ffffff;
  --text-color: #1a1a2e;
  --link-color: #0066cc;
  --link-hover-color: #004499;

  /* Spacing */
  --section-padding: 64px 24px;
  --nav-height: 80px;
}
```

### Brand CSS Variable Mapping

| Source Token | CSS Custom Property |
|-------------|-------------------|
| Heading font family | `--heading-font-family` |
| Body font family | `--body-font-family` |
| Monospace font family | `--fixed-font-family` |
| Page background | `--background-color` |
| Body text color | `--text-color` |
| Link color | `--link-color` |
| Link hover color | `--link-hover-color` |
| Section padding | `--section-padding` |
| Navigation height | `--nav-height` |

### 2. Generate Page HTML

Build the page document from the decomposition. Each fragment becomes a separate file.

All content files go in `drafts/` (like `aem up --html-folder drafts`):

**Main content** (`drafts/{page-path}.plain.html`):

```html
<div>
  <h1>Page Title</h1>
  <p>Intro paragraph -- this is default content.</p>
</div>
<div class="section-metadata">
  <div><div>Style</div><div>highlight</div></div>
</div>
---
<div>
  <div class="hero">
    <div>
      <div><img src="/drafts/images/hero-bg.jpg" alt="Hero"></div>
      <div><h2>Hero Heading</h2><p>Hero text</p><a href="/cta">Call to Action</a></div>
    </div>
  </div>
</div>
---
<div>
  <div class="cards">
    <div>
      <div><img src="/drafts/images/card1.jpg" alt="Card 1"></div>
      <div><h3>Card Title</h3><p>Card description</p></div>
    </div>
    <div>
      <div><img src="/drafts/images/card2.jpg" alt="Card 2"></div>
      <div><h3>Card Title</h3><p>Card description</p></div>
    </div>
  </div>
</div>
```

Sections are separated by `---`. Block content uses the table-as-divs pattern. Default content is plain HTML. Image paths are root-relative to the EDS project (e.g., `/drafts/images/hero.jpg`), which the preview SW resolves from VFS.

**Navigation** → `drafts/nav.plain.html`
**Footer** → `drafts/footer.plain.html`
**Images** → `drafts/images/` (downloaded from source page)

### 3. Git Commit

Create a migration branch and commit all artifacts:

```bash
git checkout -b migrate/{page-path}
git add blocks/ styles/brand.css drafts/
git commit -m "feat: migrate {page-path} from {source-domain}"
```

---

## Reference: EDS Block JS Pattern

```js
export default async function decorate(block) {
  // block = <div class="blockname"> with authored rows/cells as children
  // Each direct child div is a row
  // Each child of a row is a cell

  const rows = [...block.children];
  rows.forEach((row) => {
    const cells = [...row.children];
    // Restructure cells into semantic HTML
  });
}
```

The function is called once after EDS converts the authored content table into nested `<div>` elements. It must not return a value. Async is allowed for lazy-loading images or fetching data.

## Reference: EDS Block CSS Pattern

```css
/* Scope all styles under the block class */
.blockname {
  /* Define design tokens as custom properties */
  --block-bg: #1a1a2e;
  --block-text: #ffffff;
  --block-padding: 64px 24px;
  --block-gap: 24px;

  background: var(--block-bg);
  color: var(--block-text);
  padding: var(--block-padding);
}

/* Style children with block scope */
.blockname h2 {
  font-size: 2.5rem;
  font-family: var(--heading-font-family);
}

.blockname img {
  width: 100%;
  height: auto;
  border-radius: 8px;
}

/* Responsive: mobile-first, desktop override */
@media (width >= 900px) {
  .blockname > div {
    display: flex;
    gap: var(--block-gap);
  }

  .blockname > div > div {
    flex: 1;
  }
}
```

## Reference: Quality Criteria

| Criterion | Target |
|-----------|--------|
| Visual similarity per block | >= 85% acceptable, >= 95% ideal |
| Header visual similarity | >= 85% (interactive states differ) |
| Max iterations per block | 3 |
| CSS custom properties | All design tokens extracted from source |
| Responsive breakpoint | At least one (900px) |
| Block JS | Default export, async decorate function |
| Content model | Valid .plain.html with div structure |
| Accessibility | Alt text on images, semantic heading levels |
| Reserved names | Never use "header" or "footer" as block names |

## Philosophy: CSS-First Adaptation

Block migration follows a CSS-first approach:

1. **Extract design tokens** -- colors, spacing, typography from the source
2. **Preserve semantics** -- the HTML structure matters for authoring and accessibility
3. **Scope styles** -- everything under `.blockname`, using custom properties
4. **Iterate to visual parity** -- use screenshot comparison to close the gap

The goal is NOT pixel-perfect reproduction. The goal is faithful visual representation using EDS authoring patterns that content authors can maintain in Word/Google Docs.
