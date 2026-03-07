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

### Scoop Delegation Pattern

**Before creating scoops**, read `head.html` from the repo:

```
read_file({ "path": "/shared/{repo-name}/head.html" })
```

Each scoop has a `migrate-block` skill in its workspace that defines the
complete block migration process. The cone's job is to pass **parameters**,
not relay process instructions. The skill is the source of truth.

### feed_scoop Prompt Template

```
You are migrating a single block to EDS.

## Parameters
- Block name: {blockName}
- Source URL: {sourceUrl}
- Visual tree ID: {id}
- Bounds: x={x}, y={y}, width={w}, height={h}
- EDS project: /shared/{repo-name}/
- Notes: {any decomposition notes — e.g., "this is a 3-column card grid"}

## head.html Content
{PASTE THE FULL CONTENT OF head.html HERE}

## Instructions
Read and execute the migrate-block skill at:
/scoops/{scoop-folder}/workspace/skills/migrate-block/SKILL.md

Follow every step exactly. Your preview MUST use head.html content.
Do NOT inline CSS or JS as a substitute for the EDS framework.
```

**This is ~20 lines.** The skill file (~300 lines) is the authoritative
process definition. The cone passes parameters; the skill defines steps.

### Header Scoop — Uses Dedicated Skill

The header/navigation block uses the `migrate-header` skill (NOT
`migrate-block`). The feed_scoop prompt for the header scoop:

```
You are migrating the website header/navigation to EDS.

## Parameters
- Source URL: {sourceUrl}
- EDS project: /shared/{repo-name}/
- Bounds: x={x}, y={y}, width={w}, height={h}
- Notes: {decomposition notes — e.g., "two-tier purple header with mega menus"}

## head.html Content
{PASTE THE FULL CONTENT OF head.html HERE}

## Instructions
Read and execute the migrate-header skill at:
/scoops/{scoop-folder}/workspace/skills/migrate-header/SKILL.md

This is a HEADER migration, not a regular block. Follow the header skill
exactly — it handles nav.plain.html generation, section-metadata styles,
dropdown detection, and header-specific CSS patterns.
```

### Footer Scoop — Uses migrate-block Skill

The footer uses the standard `migrate-block` skill with this addition:

```
- Special: This is the FOOTER block. Output footer.plain.html, not {blockName}.plain.html.
  See "Footer Block — Special Case" in the migrate-block skill.
```

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

### Step 4.2: Generate brand.css — MANDATORY

Read `.migration/brand.json`. Write `/shared/{repo-name}/styles/brand.css`:

```css
:root {
  /* Typography — from brand.json fonts */
  --heading-font-family: "{brand.fonts.heading}", serif;
  --body-font-family: "{brand.fonts.body}", sans-serif;

  /* Colors — from brand.json colors */
  --background-color: {brand.colors.background};
  --text-color: {brand.colors.text};
  --link-color: {brand.colors.link};
  --link-hover-color: {brand.colors.linkHover};

  /* Spacing — from brand.json spacing */
  --section-padding: {brand.spacing.sectionPadding};
  --nav-height: {brand.spacing.navHeight};
}

/* Fix SLICC preview scrolling */
html, body { overflow: auto !important; }
```

Replace all `{brand.*}` placeholders with actual values from `brand.json`.
This file MUST be created — blocks reference these variables.

### Step 4.3: Update styles.css — MANDATORY

Read `/shared/{repo-name}/styles/styles.css`. Update the `:root` CSS
variables to match the brand values from `brand.json`. The boilerplate
has default values (e.g., `--link-color: #035fe6`) that must be replaced
with the source site's actual values.

Also add an import for brand.css at the top of styles.css if not present:
```css
@import url('brand.css');
```

### Step 4.4: Assemble Page Content — MANDATORY

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

### Step 4.5: Create Full Preview Page — MANDATORY

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
  "entry": "drafts/{page-path}-preview.html", "edsProject": true }
```

Take a screenshot of the full assembled page and save to
`.migration/preview-assembled.png`.

### Step 4.6: Git Commit — MANDATORY

```bash
git add blocks/ styles/ drafts/
git commit -m "feat: migrate {page-path} from {source-domain}"
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
