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
- `headHtmlContent` — full content of `head.html`
- `bounds` — bounding box of the header region
- `notes` — decomposition notes (e.g., "two-tier purple header")

---

## Step 1: Capture Source Header

Navigate to the source page and extract the header's content:

```json
{ "action": "navigate", "url": "{sourceUrl}" }
```

The cone dismissed overlays (cookie banners, consent dialogs) during
Phase 1.5 and set consent cookies. Since all tabs share the same browser
session, overlays should NOT appear when you navigate here. If you do
see an overlay, click its accept/dismiss button via `evaluate`.

Use `evaluate` to extract the header HTML, including:
- Logo (image URL, alt text, link href)
- Navigation links (text, href, nested dropdowns)
- Utility links (login, search, cart, language selector)
- Announcement/promo bar text (if present)
- Background colors for each header section

```json
{ "action": "evaluate", "expression": "document.querySelector('header').outerHTML" }
```

Also screenshot the header:
```json
{ "action": "screenshot", "selector": "header",
  "path": "{projectPath}/.migration/source-header.png" }
```

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

```json
{ "action": "evaluate", "expression": "..." }
```

Read `{projectPath}/blocks/header/header.js` and `header.css`. If they
exist, **keep the existing JS** — it handles fragment loading, section
building, dropdown behavior, hamburger menu, and keyboard navigation.
You only need to customize the CSS.

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

---

## Step 6: Preview and Verify

### 6a. Create Preview Page

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

### 6b. Serve Preview

```json
{ "action": "serve", "directory": "{projectPath}",
  "entry": "drafts/header-preview.html", "edsProject": true }
```

### 6c. Verify EDS Framework

```json
{ "action": "evaluate", "expression": "JSON.stringify({ hlx: !!window.hlx, codeBasePath: window.hlx?.codeBasePath, bodyAppear: document.body.classList.contains('appear'), headerBlock: !!document.querySelector('.header.block'), navSections: document.querySelectorAll('.header-section').length })" }
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

For each iteration:
1. Screenshot the source header
2. Screenshot the preview header (`selector: "header"`)
3. Compare: focus on background color, logo size, nav spacing, layout
4. Fix: edit `header.css` custom properties — surgical changes only

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
