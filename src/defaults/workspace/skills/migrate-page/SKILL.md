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
| `overlay-recipe.json` | Overlay dismiss actions (from heuristic detection) |

---

## Phase 1.5: Dismiss Overlays — MANDATORY

The `migrate_page` tool runs heuristic overlay detection, but it may miss
custom overlays. You MUST verify the page is clean.

**Why this matters:** All tabs share the same browser session. When you
click "Accept All" on a cookie banner, the consent cookie is set and
persists. Scoops opening new tabs to the same URL will NOT see the banner.
But this only works if you CLICK the button — removing the DOM element
does NOT set the cookie.

### What Is an Overlay?

An overlay is any element sitting ON TOP of the main page content:

- **Full-width bars:** Cookie consent at bottom ("Accept All" / "Decline"),
  GDPR/CCPA notice, dismissible announcements
- **Centered modals:** Newsletter signup, login dialog, age gate, paywall —
  typically with a dark semi-transparent backdrop
- **Corner widgets:** Chat bubbles (Intercom, Zendesk), help buttons
- **Visual indicators:** Dark backdrop dimming the page, element floating
  with shadow, has X/close/accept/decline button, obscures page content

**NOT overlays:** Sticky navigation, inline content, embedded forms.

### Steps

1. **Look at the RAW screenshot** (taken before any page modifications):
   ```
   read_file({ "path": "/shared/{repo-name}/.migration/screenshot-raw.png" })
   ```
   This shows the page exactly as a visitor sees it — including overlays.
   Do NOT use `screenshot.png` (that's taken after page-prep which hides
   overlays by converting `position: fixed` to `relative`).

2. **If the raw screenshot is clean** — no overlays visible → proceed to Phase 2.

3. **If overlays are visible:**

   a. Navigate to the source page:
      ```json
      { "action": "new_tab", "url": "{sourceUrl}" }
      ```
   b. Take a snapshot to see the DOM:
      ```json
      { "action": "snapshot" }
      ```
   c. Find the **accept/dismiss button** and CLICK it (do NOT just remove
      the element — clicking sets the consent cookie which persists for
      scoops):
      ```json
      { "action": "evaluate", "expression": "document.querySelector('SELECTOR').click()" }
      ```
      Common selectors to try:
      - `#onetrust-accept-btn-handler` (OneTrust)
      - `#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll` (Cookiebot)
      - `[class*="accept"]`, `[class*="allow"]`, `[aria-label*="Accept"]`
      - `[aria-label*="close"]`, `[aria-label*="Close"]`, `.close-btn`
   d. Screenshot to confirm the overlay is gone
   e. If clicking didn't work (no button found), use `remove` as last resort:
      ```json
      { "action": "evaluate", "expression": "document.querySelectorAll('SELECTOR').forEach(e => e.remove())" }
      ```

**CRITICAL:** Always prefer `click` over `remove`. Clicking sets cookies
that persist across tabs. Removing just hides the element in this tab.

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

## Phase 2.5: Prepare Brand, Fonts, and Styles — BEFORE creating scoops

Scoops need the brand fully set up so their preview pages load with correct
fonts, colors, and spacing. Do ALL of this BEFORE Phase 3.

### 2.5a: Resolve Fonts

1. Read `.migration/brand.json` — check `fonts.sources.typekit` and
   `fonts.sources.googleFonts`
2. Resolve font delivery using this cascade (first match wins):

   **a. Source has Adobe Fonts (Typekit)?**
   If `fonts.sources.typekit` is not null → use the source's kit directly.
   The source's kit has the exact fonts the page uses and works in preview.
   Link: `https://use.typekit.net/{fonts.sources.typekit}.css`

   **b. Source has Google Fonts?**
   If `fonts.sources.googleFonts` has URLs → use those URLs directly.

   **c. Font in our fallback Typekit kit `cwm0xxe`?**
   Check: `https://typekit.com/api/v1/json/kits/cwm0xxe/published`
   (public API, no auth). If the font family appears → use kit `cwm0xxe`.
   Link: `https://use.typekit.net/cwm0xxe.css`

   **d. Font available on Google Fonts?**
   Check: `https://fonts.googleapis.com/css2?family={FontName}:wght@400;700&display=swap`
   If 200 OK → use that URL.

   **e. System font fallback**
   Use the extracted font name with generic fallback (serif/sans-serif).

### 2.5b: Update head.html

Read `/shared/{repo-name}/head.html`. Add font `<link>` tags BEFORE the
existing `<script>` tags based on the cascade result:

- Adobe Fonts: `<link rel="stylesheet" href="https://use.typekit.net/{projectId}.css">`
- Google Fonts: preconnects + `<link href="{url}" rel="stylesheet">`

Write the updated `head.html` back.

### 2.5c: Generate brand.css

Write `/shared/{repo-name}/styles/brand.css` with brand values from
`brand.json`:

```css
:root {
  --heading-font-family: "{resolved heading font}", serif;
  --body-font-family: "{resolved body font}", sans-serif;
  --background-color: {brand.colors.background};
  --text-color: {brand.colors.text};
  --link-color: {brand.colors.link};
  --link-hover-color: {brand.colors.linkHover};
  --section-padding: {brand.spacing.sectionPadding};
  --nav-height: {brand.spacing.navHeight};
}

html, body { overflow: auto !important; }
```

### 2.5d: Update styles.css with @import

Read `/shared/{repo-name}/styles/styles.css`. Add `@import url('brand.css');`
as the **VERY FIRST LINE** (CSS spec requires `@import` before all other
rules). Also update `:root` variables to match brand values.

Add a global EDS button reset after `:root`:

```css
main .button-container { display: inline; }
main a.button:any-link {
  background: none; border: none; border-radius: 0;
  color: var(--link-color); font-size: inherit; font-weight: inherit;
  padding: 0; margin: 0; text-decoration: underline; white-space: normal;
}
```

Write the updated `styles.css` back.

Now scoops will preview with correct fonts, colors, spacing, and button
behavior from the start.

---

## Phase 3: Block Generation (Parallel Scoops)

Create one scoop per **block**. **Do NOT drop scoops** — keep them alive
for user review and debugging. Never call `drop_scoop` during migration.

**`default-content` items do NOT get scoops.** They are simple prose
(headings, paragraphs, lists, images) that the cone writes directly
during Phase 4 assembly. The cone extracts default-content text from
the source page and writes it inline in the assembled .plain.html.

### PERFORMANCE: Batch All Scoop Operations

Scoop creation and feeding are the biggest time sinks because each tool
call requires an LLM turn. **Minimize the number of LLM turns** by
batching operations:

**Step 1 — Generate scoop configs via script** (1 tool call, NO LLM generation):

Use the JavaScript tool to generate all scoop prompts mechanically.
This avoids the cone spending tokens generating repetitive prompt text.

```javascript
const decomposition = JSON.parse(await fs.readFile('/shared/{repo-name}/.migration/decomposition.json', { encoding: 'utf-8' }));
const headHtml = await fs.readFile('/shared/{repo-name}/head.html', { encoding: 'utf-8' });
const script = await fs.readFile('/workspace/scripts/generate-scoop-prompts.js', { encoding: 'utf-8' });
eval(script);
// Optional: pass a model ID as 5th argument to use a different model for scoops
// e.g., 'claude-sonnet-4-6' for faster/cheaper block generation
const configs = generateScoopConfigs(decomposition, headHtml, '{sourceUrl}', '/shared/{repo-name}');
return JSON.stringify(configs);
```

This returns an array of `{ name, model, prompt }` objects — one per block.

**Step 2 — Create AND feed ALL scoops in a SINGLE response** (N tool calls, 1 LLM turn):

Take the configs from Step 1 and call `scoop_scoop` for each one.
DO NOT modify or regenerate the prompts — use them exactly as returned.
```
scoop_scoop({ "name": configs[0].name, "model": configs[0].model, "prompt": configs[0].prompt })
scoop_scoop({ "name": configs[1].name, "model": configs[1].model, "prompt": configs[1].prompt })
... one per config, all in ONE response
```

This reduces scoop setup to ~2 LLM turns (generate configs + create all).
The cone does NOT generate prompt text — the script does it mechanically.

### How the Script Works

The `generate-scoop-prompts.js` script handles all three block types:
- **Header blocks** (nav-bar, header, navigation, or /nav fragment) → uses `migrate-header` skill
- **Footer blocks** (footer, footer-links, footer-content, or /footer fragment) → uses `migrate-block` skill with footer special case
- **All other blocks** → uses `migrate-block` skill

Each generated prompt includes the block parameters, head.html content,
and instructions to read the appropriate skill. The cone does NOT need
to generate or modify any prompt text.

---

## Phase 4: Assembly — MANDATORY STEPS

After all scoops complete, the cone MUST execute ALL of the following steps.
Do not skip any. Phase 4 is not optional — it produces the final deliverables.

**Do NOT drop scoops.** Keep them alive for user review.

### Step 4.1: Read Reports

Read ALL reports from `/shared/{repo-name}/.migration/reports/`.
For each block, check:
- `status`: success/partial/failed
- `edsVerification`: did the EDS framework load?
- `issues`: any problems to address

List any missing reports — every block scoop MUST produce a report.

### Step 4.2: Verify Brand Setup

`brand.css`, `styles.css`, and `head.html` were already updated in
Phase 2.5. Verify they are correct:

- `styles/brand.css` exists with `:root` variables
- `styles/styles.css` has `@import url('brand.css');` as FIRST LINE
- `styles/styles.css` has the global button reset
- `head.html` has Typekit/Google Fonts `<link>` tags

If anything is missing (Phase 2.5 was skipped or failed), do it now:

### Step 4.3: Assemble Page Content — MANDATORY

Write the main page to `/shared/{repo-name}/drafts/{page-path}.plain.html`.

Read each block scoop's `.plain.html` file and combine them into sections
following the decomposition order:

```html
<div>
  <div class="hero">
    <!-- paste hero scoop's .plain.html block content -->
  </div>
</div>
<div>
  <div class="cards">
    <!-- paste cards scoop's .plain.html block content -->
  </div>
</div>
<div>
  <div class="metadata">
    <div><div>nav</div><div>/drafts/nav</div></div>
    <div><div>footer</div><div>/drafts/footer</div></div>
    <div><div>title</div><div>{page title from metadata.json}</div></div>
  </div>
</div>
```

**Rules:**
- Each section is a top-level `<div>`
- Blocks inside sections: `<div class="blockname">` with the content
  from the scoop's `.plain.html` (copy the block div, not the section wrapper)
- The **metadata block** MUST be the last section — points to nav/footer
- Section styles from decomposition → add `<div class="section-metadata">`
- Images use `/drafts/images/` root-relative paths
- Default-content items (from decomposition): extract from source page
  and write as plain HTML (headings, paragraphs, lists) in their section

### Step 4.4: Create Full Preview Page — MANDATORY

Write `/shared/{repo-name}/drafts/{page-path}-preview.html`:

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
    {PASTE THE CONTENT OF THE ASSEMBLED .plain.html}
  </main>
  <footer></footer>
</body>
</html>
```

Serve and verify:
```json
{ "action": "serve", "directory": "/shared/{repo-name}",
  "entry": "drafts/{page-path}-preview.html", "projectServe": true }
```

Wait for all blocks to load before screenshotting. The page has header
(fragment load) + multiple content blocks + footer (fragment load) — these
load asynchronously. Verify with:

```json
{ "action": "evaluate", "expression": "JSON.stringify({ blocks: document.querySelectorAll('[data-block-status=\"loaded\"]').length, appear: document.body.classList.contains('appear') })" }
```

Wait until all expected blocks show `status: "loaded"`. Then take the screenshot:
Save to `.migration/preview-assembled.png`.

### Step 4.5: Git Commit — MANDATORY

```bash
git add blocks/ styles/ drafts/
git commit -m "feat: migrate {page-path} from {source-domain}"
```

### Step 4.6: Detach Browser

Detach from the browser to remove the "debugging this browser" infobar:
```json
{ "action": "detach" }
```

### Step 4.7: Final Summary

Report to the user:
- Number of blocks migrated and their statuses
- Visual verification results per block (from reports)
- Brand.css and styles.css: what was updated
- Assembled page preview URL
- Any issues, gaps, or incomplete items
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
