---
name: migrate-header
description: Migrate a website header/navigation into an AEM Edge Delivery Services header block with nav.plain.html. Handles single-row and multi-section headers, dropdowns, mega menus, and mobile patterns.
allowed-tools: browser,read_file,write_file,edit_file,bash,javascript
---

# Migrate Header to EDS

Migrate a website's header/navigation into the EDS header block pattern.
Produces `nav.plain.html` + customized `header.css`. The header JS is
typically pre-built in the EDS repo — you customize CSS only.

## HARD CONSTRAINTS

1. **Output is `nav.plain.html`** — NOT a regular block `.plain.html`.
2. **Block name is `header`** — CSS/JS at `blocks/header/header.css|.js`.
3. **If `blocks/header/` exists in the repo, keep the existing JS.**
   Only generate `nav.plain.html` and customize `header.css`.
4. **CSS specificity: ALL rules must be `.header.block` scoped.**
   NOT `.header` — must be `.header.block` to prevent global overrides.
5. **NEVER inline CSS or JS in the preview.** Use the EDS framework.
6. **NEVER pre-decorate HTML.** No `.section`, `.block`, `data-block-name`.

---

## Parameters (from cone's feed_scoop prompt)

- `sourceUrl` — URL of the source page
- `projectPath` — EDS project path (e.g., `/shared/vibemigrated`)
- `bounds` — bounding box of the header region
- `notes` — decomposition notes (e.g., "two-tier purple header")

---

## Step 1: Capture Source Header

Navigate to the source page and extract the header's content:

```bash
playwright-cli tab-new {sourceUrl}
```

The cone dismissed overlays (cookie banners, consent dialogs) during
Phase 1.5 and set consent cookies. Since all tabs share the same browser
session, overlays should NOT appear when you navigate here. If you do
see an overlay, click its accept/dismiss button via `eval`.

**Always wrap `eval` calls in IIFEs** to avoid variable redeclaration
errors across multiple calls.

Use `eval` to extract the header HTML. Note: some sites use `<nav>` instead
of `<header>` for navigation. Check with `eval` first to confirm the right
element:

```bash
playwright-cli eval "(() => {
  const h = document.querySelector('header');
  const n = document.querySelector('nav');
  return JSON.stringify({ header: !!h, nav: !!n, headerTag: h?.tagName, navId: n?.id });
})()"
```

Extract all header content in one comprehensive call:

```bash
playwright-cli eval "(() => {
  const nav = document.querySelector('header') || document.querySelector('nav');
  if (!nav) return JSON.stringify({ error: 'no header/nav found' });
  const logo = nav.querySelector('img');
  const links = [...nav.querySelectorAll('a')].map(a => ({ href: a.href, text: a.textContent.trim() }));
  const styles = getComputedStyle(nav);
  return JSON.stringify({
    html: nav.outerHTML.slice(0, 5000),
    logo: logo ? { src: logo.src, alt: logo.alt } : null,
    links: links.slice(0, 50),
    tokens: { bg: styles.backgroundColor, color: styles.color, height: styles.height, fontSize: styles.fontSize }
  });
})()"
```

**Screenshot the source header NOW** — reuse for all visual iterations.
Use snapshot + ref-based screenshot for a tight crop:

```bash
playwright-cli snapshot
# Find the ref for the header/nav element (e.g., e3)
playwright-cli screenshot e3 --max-width=1440 --filename {projectPath}/.migration/source-header.png
```

**Close the source tab** after extraction:
```bash
playwright-cli tab-close
```

After closing, playwright-cli has no active tab. Steps 2–5 do not use the
browser. You will select a new tab in Step 6b.

---

## HARD RULE: Draft-First Workflow

**Write nav.plain.html within 7 minutes of starting.** Do NOT spend more
than 7 minutes on header analysis before writing the initial files.

- Use placeholder items for complex mega menu content. Note gaps in report.
- Do NOT recreate icon fonts or SVG icons from scratch. Use text/emoji.
- Extract the 5 most impactful header tokens (background color, nav font
  size, logo height, nav gap, section padding) before writing the first CSS.
  Iterate toward exact values during visual verification.

---

## Step 2: Analyze Header Structure

Examine the extracted HTML and screenshot to determine the header type:

### Single-Row Header
**Indicators:**
- Logo, navigation, and utility links on the same horizontal level
- Single background color across the entire header
- No visual separation between sections

### Multi-Section Header
**Indicators:**
- Multiple distinct horizontal rows stacked vertically
- Separate logo area from navigation
- Announcement/promo bar above or below nav
- Utility links in a separate row
- Different background colors for different sections

Also detect dropdown types for each nav item:
- **Simple dropdown:** nested `<ul>` contains only `<li>` with `<a>` links
- **Mega dropdown:** nested content includes headings (`<h1>`-`<h6>`),
  paragraphs (`<p>`), images, or rich content blocks

---

## Step 3: Install Header Block

Check if the repo already has a header block:

```
read_file({ "path": "{projectPath}/blocks/header/header.js" })
read_file({ "path": "{projectPath}/blocks/header/header.css" })
```

**CRITICAL: Read header.js to understand the JS contract.** The nav.plain.html
structure MUST match what the JS expects:

- If the JS uses **index-based section assignment** (e.g.,
  `const classes = ['brand', 'sections', 'tools']` and assigns by
  `children[0]`, `children[1]`, `children[2]`), do NOT add `section-metadata`
  divs — they would count as extra children and throw off the indexing.
- If the JS uses **section-metadata Style values**, use the multi-section
  format with metadata divs.
- Count how many child `<div>`s the JS expects and match exactly.

If `blocks/header/` exists, **keep the existing JS**. You only customize CSS.

If `blocks/header/` does NOT exist, create both files. The JS should:
- Load `nav.plain.html` as a fragment via `getMetadata('nav')`
- Build sections based on section-metadata Style values
- Handle hamburger toggle for mobile
- Handle dropdown open/close (hover on desktop, click on mobile)
- Support keyboard navigation (arrow keys, Escape)

---

## Step 4: Generate nav.plain.html

Write to `{projectPath}/drafts/nav.plain.html`.

### Single-Row Format

```html
<div>
  <p><a href="/"><img src="/drafts/images/logo.png" alt="Company"></a></p>
  <ul>
    <li><a href="/products">Products</a>
      <ul>
        <li><a href="/products/a">Product A</a></li>
        <li><a href="/products/b">Product B</a></li>
      </ul>
    </li>
    <li><a href="/solutions">Solutions</a></li>
    <li><a href="/about">About</a></li>
  </ul>
  <p><a href="/login">Login</a> | <a href="/signup">Sign Up</a></p>
  <div class="section-metadata">
    <div><div>Style</div><div>main-nav</div></div>
    <div><div>Mobile Style</div><div>accordion</div></div>
  </div>
</div>
```

**Structure:**
- Logo: `<p><a><img></a></p>` (first element)
- Navigation: `<ul>` with nested `<li>` for dropdowns
- Utility: `<p>` with pipe-separated links (last element before metadata)
- Single section-metadata with Style + Mobile Style

### Multi-Section Format

```html
<div>
  <p><img src="/drafts/images/logo.png" alt="Company"></p>
  <div class="section-metadata">
    <div><div>Style</div><div>brand</div></div>
  </div>
</div>
<div>
  <p>Free shipping on orders over $50 <a href="/promo">Shop Now</a></p>
  <div class="section-metadata">
    <div><div>Style</div><div>top-bar</div></div>
  </div>
</div>
<div>
  <ul>
    <li><a href="/products">Products</a>
      <ul>
        <li><a href="/products/a">Product A</a></li>
      </ul>
    </li>
    <li><a href="/about">About</a></li>
  </ul>
  <div class="section-metadata">
    <div><div>Style</div><div>main-nav</div></div>
    <div><div>Mobile Style</div><div>slide-in</div></div>
  </div>
</div>
<div>
  <ul>
    <li><a href="/login">Login</a></li>
    <li><a href="/cart">Cart</a></li>
  </ul>
  <div class="section-metadata">
    <div><div>Style</div><div>utility</div></div>
  </div>
</div>
```

**Structure:**
- Each section is a separate `<div>` with its own section-metadata
- Section Style values: `brand`, `top-bar`, `main-nav`, `utility`
- Mobile Style only on `main-nav` section

### Section Styles Reference

| Style | Purpose | Typical Content |
|-------|---------|-----------------|
| `brand` | Logo/company identity | Image, company name |
| `top-bar` | Announcements, promo | Text, promo links |
| `main-nav` | Primary navigation | `<ul>` with dropdowns |
| `utility` | User actions | Login, search, cart, language |

### Mobile Style Reference

| Mobile Style | Behavior |
|-------------|----------|
| `accordion` | Submenus expand in place (default) |
| `slide-in` | Submenus slide from right with back button |
| `fullscreen` | Submenus take full viewport with fade |

### Content Transformation Rules

When converting source HTML to nav.plain.html:
- **Remove** all classes, inline styles, data attributes
- **Keep** only HTML structure, text content, and href attributes
- **Logo:** wrap in `<p><a><img></a></p>`, download image to `/drafts/images/`
  using `fs.fetchToFile(url, path)`. Do NOT use `fs.writeFile()` for images —
  it corrupts binary data by coercing bytes to UTF-8.
- **Nav links:** clean `<ul><li><a>` hierarchy, preserve dropdown nesting
- **Mega menus:** convert columns to `<li>` items, normalize headings to `<h3>`
- **Utility:** convert to `<ul>` list or pipe-separated `<p>` links
- **Announcements:** wrap in `<p>` with inline links

### Mega Menu Transformation

Source:
```html
<div class="mega-menu">
  <div class="mega-column">
    <h4>Category</h4>
    <p>Description text</p>
    <a href="/cta">Learn More</a>
  </div>
</div>
```

Becomes:
```html
<ul>
  <li>
    <h3>Category</h3>
    <p>Description text</p>
    <a href="/cta">Learn More</a>
  </li>
</ul>
```

---

## Step 5: Customize Header CSS

Edit `{projectPath}/blocks/header/header.css`.

**ALL rules MUST use `.header.block` specificity:**

```css
/* ❌ WRONG — global styles can override */
.header .header-nav a { color: inherit; }

/* ✅ CORRECT — protected from overrides */
.header.block .header-nav a { color: inherit; }
```

**Key custom properties to adjust:**

```css
.header.block {
  /* Layout */
  --header-background: #1a0a3e;       /* match source bg */
  --header-section-padding: 0.5rem 1rem;
  --header-max-width: 1400px;

  /* Navigation */
  --header-nav-gap: 2rem;
  --header-nav-font-size: 1rem;
  --header-nav-font-weight: 500;

  /* Dropdowns */
  --header-dropdown-background: #fff;
  --header-dropdown-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  --header-dropdown-padding: 1.5rem;

  /* Mobile */
  --header-mobile-menu-background: #fff;
}

/* Section-specific overrides */
.header.block .header-top-bar {
  background: #f5f5f5;
  font-size: 0.875rem;
}

.header.block .header-brand img {
  max-height: 40px;
}
```

Extract actual values from the source page's computed styles.

**`aria-expanded` desktop behavior:** Standard header.js sets
`aria-expanded="true"` on the nav element when on desktop. Your desktop
CSS MUST handle both states. If you only style `[aria-expanded="true"]` for
mobile menu expansion, that style will also apply on desktop — causing the
mobile layout to appear on desktop.

**Required scoping pattern:**

```css
/* Mobile: expanded menu takes full width */
@media (width < 900px) {
  .header.block nav[aria-expanded='true'] {
    display: grid;
    grid-template: 'brand' auto 'sections' 1fr 'tools' auto / 1fr;
  }
}

/* Desktop: MUST override mobile expanded styles */
@media (width >= 900px) {
  .header.block nav,
  .header.block nav[aria-expanded='true'] {
    display: grid;
    grid-template:
      'brand . tools' {topRowHeight}
      'sections sections sections' {navRowHeight}
      / auto 1fr auto;
  }
}
```

The key: the desktop `@media (width >= 900px)` block MUST explicitly include
`nav[aria-expanded='true']` to override the mobile expanded layout.

**Multi-tier headers:** If the source has two rows (e.g., logo+utility on
top, nav on bottom), the existing CSS may be flex-based for single-row.
You may need to replace it entirely with the Grid template above. This is
a larger change than "tweaking tokens" — acknowledge that multi-tier headers
may require a near-complete CSS rewrite.

---

## Step 6: Preview and Verify

### 6a. Create Preview Page

Read head.html from the project:
```
read_file({ "path": "{projectPath}/head.html" })
```

Write `{projectPath}/drafts/header-preview.html`:

```html
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="nav" content="/drafts/nav">
  <meta name="footer" content="/drafts/footer">
  {PASTE <script> AND <link> TAGS FROM head.html}
  <style>html, body { overflow: auto !important; }</style>
</head>
<body>
  <header></header>
  <main>
    <div><h1>Header Preview</h1><p>Content below header for context.</p></div>
  </main>
  <footer></footer>
</body>
</html>
```

The EDS header block will automatically load `nav.plain.html` via the
`<meta name="nav">` tag and render the full header.

### 6b. Serve with EDS Project Mode

```bash
serve --entry drafts/header-preview.html --project {projectPath}
```

The `serve` command opens the preview tab AND sets it as playwright-cli's
current target. All subsequent commands automatically target this tab.

### 6c. Verify EDS Framework

```bash
playwright-cli eval "JSON.stringify({ hlx: !!window.hlx, codeBasePath: window.hlx?.codeBasePath, bodyAppear: document.body.classList.contains('appear'), headerBlock: !!document.querySelector('.header.block'), navSections: document.querySelectorAll('.header-section').length })"
```

**Required:** `hlx: true`, `bodyAppear: true`, `headerBlock: true`.
If `headerBlock` is false, the header fragment didn't load — check that
`nav.plain.html` exists at `{projectPath}/drafts/nav.plain.html` and
the `<meta name="nav">` points to `/drafts/nav`.

---

## Step 7: Visual Verification (Max 5 Iterations)

Header target: **90% visual similarity** (lower than blocks due to
interactive states). Max **5 iterations**.

**Font rendering note:** Adobe Fonts (Typekit) validates the requesting
domain. On `localhost`, Typekit returns empty CSS — fonts will show
fallbacks (Georgia, Times New Roman). This is expected and NOT a bug
to fix. Do NOT waste iterations trying to match font rendering. Focus
on layout, spacing, colors, and structure. Fonts will render correctly
when deployed to a whitelisted production domain.

**Source screenshot:** You already captured this in Step 1. Read it from:
`{projectPath}/.migration/source-header.png`
Do NOT navigate back to the source page. Reuse for every iteration.

For thin headers (<150px tall), also use `eval`-based measurements for
precision — screenshots may be too small for reliable pixel comparison:
```bash
playwright-cli eval "(() => {
  const h = document.querySelector('header');
  const r = h.getBoundingClientRect();
  const logo = h.querySelector('img');
  const lr = logo ? logo.getBoundingClientRect() : null;
  return JSON.stringify({ totalHeight: r.height, logoHeight: lr?.height, logoWidth: lr?.width });
})()"
```

**Before the first iteration**, take a snapshot to find the header ref:
```bash
playwright-cli snapshot
# Find the ref for the header element (e.g., e2) — note it for all iterations
```

For each iteration:
1. **Screenshot the preview header** by ref (reuse across iterations):
   ```bash
   playwright-cli screenshot e2 --max-width=1440 --filename {projectPath}/.migration/preview-header-iter{N}.png
   ```
2. **Compare** source (from Step 1) and preview: focus on background color, logo size, nav spacing, layout
3. **Fix:** Batch ALL CSS fixes for this iteration into a SINGLE `edit_file`
   call. Do not make separate edits for each property. Edit `header.css`
   custom properties only.
4. **Reload:** `playwright-cli goto <your-preview-url>`

**Common header-specific fixes:**
- Background color mismatch → `--header-background`
- Logo too large/small → `.header.block .header-brand img { max-height }`
- Nav link spacing → `--header-nav-gap`
- Font size/weight → `--header-nav-font-size`, `--header-nav-font-weight`
- Dropdown position → `--header-dropdown-padding`, box-shadow
- Section padding → `--header-section-padding`

**Stop conditions:**
- After iteration 5: finalize
- If improvement < 3%: accept and stop

---

## Step 8: Write Report

**Write the report in TWO passes** to ensure a report exists even if visual
iterations don't complete (timeout, error, etc.):

**Pass 1 — Write immediately after Step 6c passes** (before visual iterations):
Write with `"status": "partial"` and the `edsVerification` data. This
guarantees the cone gets a report even if Step 7 never finishes.

**Pass 2 — Update after Step 7 completes** (after visual iterations):
Update with final `status`, `visualVerification`, and `designTokens`.

Write to `{projectPath}/.migration/reports/header-report.json`:

```json
{
  "blockName": "header",
  "sourceUrl": "{sourceUrl}",
  "timestamp": "<ISO 8601>",
  "status": "<success|partial|failed>",
  "headerType": "<single-row|multi-section>",
  "sections": ["brand", "main-nav", "utility"],
  "mobileStyle": "accordion",
  "dropdownTypes": { "Products": "mega", "About": "simple" },
  "files": {
    "css": "blocks/header/header.css",
    "js": "blocks/header/header.js",
    "plainHtml": "drafts/nav.plain.html",
    "previewHtml": "drafts/header-preview.html"
  },
  "images": [
    { "source": "https://...", "local": "/drafts/images/logo.png" }
  ],
  "edsVerification": {
    "hlx": true,
    "headerBlock": true,
    "navSections": 3
  },
  "visualVerification": {
    "iterationsUsed": 3,
    "previewWorked": true,
    "iterations": [
      { "iteration": 1, "changes": "...", "gaps": ["..."] }
    ],
    "finalAssessment": "..."
  },
  "designTokens": {
    "--header-background": "#1a0a3e",
    "--header-nav-font-size": "0.875rem"
  },
  "issues": ["..."]
}
```

**Status thresholds:** success (>85%), partial (50-85%), failed (<50%)

Then `send_message` to the cone with: status, header type, iteration count,
report path, any issues.

**Close the preview tab** to avoid tab clutter:

```bash
playwright-cli tab-close
```
