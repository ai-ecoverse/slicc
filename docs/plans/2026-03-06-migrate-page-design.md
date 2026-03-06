# Design: `migrate-page` — Single-Page EDS Migration in slicc

## Summary

A shell command + skill combination that enables fully automated single-page
migration to AEM Edge Delivery Services within slicc. The command handles
mechanical extraction (screenshot, DOM, brand, metadata). Parallel scoops,
each guided by a migration skill, handle the creative work (block code
generation + visual verification). The cone orchestrates: clone, decompose,
delegate, assemble, commit.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | Single-page only | Highest value, most tractable |
| Approach | Command-driven | Command automates mechanical parts, agent handles creative parts |
| Flow | One-shot | User runs one command, system handles everything |
| Output target | Existing EDS repo | User provides `--repo owner/repo` |
| VFS location | `/shared/<repo-name>/` | Convention-based, accessible by all scoops |
| Preview | slicc preview SW | EDS rendering is 100% client-side; replaces `aem up` |
| Visual verification | Claude vision | Screenshots compared by the agent; replaces pixelmatch |
| Parallelism | One scoop per block | Full generation + visual iteration per scoop |
| Shared project | `/shared/<repo-name>/` | Scoops write to non-overlapping block subdirectories |

## Components

### 1. Shell Command — `migrate-page`

**File:** `src/shell/supplemental-commands/migrate-page-command.ts`

**Usage:**

```
migrate-page <url> --repo <owner/repo>
```

**Responsibilities (mechanical only):**

1. Parse arguments (URL, repo)
2. Clone repo to `/shared/<repo-name>/` via isomorphic-git (skip if already cloned)
3. Create branch `migrate/<page-slug>` (slug derived from URL path)
4. Navigate to URL via BrowserAPI
5. Take full-page screenshot → `/shared/<repo-name>/.migration/screenshot.png`
6. Run visual tree extraction JS via `evaluate()` →
   `/shared/<repo-name>/.migration/visual-tree.json`
7. Extract brand signals (fonts, colors, spacing) via `evaluate()` →
   `/shared/<repo-name>/.migration/brand.json`
8. Extract page metadata (title, OG, description) via `evaluate()` →
   `/shared/<repo-name>/.migration/metadata.json`
9. Inventory existing blocks in the EDS project →
   `/shared/<repo-name>/.migration/block-inventory.json`
10. Return structured summary with file paths to the agent

**Dependencies:** BrowserAPI (navigate, screenshot, evaluate), VirtualFS
(file storage), isomorphic-git (clone, branch).

**No new npm packages required.**

### 2. Migration Skill — `SKILL.md`

**File:** `src/defaults/workspace/skills/migrate-page/SKILL.md`

Bundled as a default skill, automatically loaded into every agent's system
prompt. Teaches the agent:

- How to interpret visual tree + screenshot for page decomposition
- EDS content model: sections, blocks, default content, table-based markup
- Block code generation patterns: CSS decoration, JS decoration logic
- Visual verification methodology: screenshot source → screenshot preview →
  compare → adjust (up to 3 iterations)
- Page assembly rules
- Brand CSS variable mapping
- Quality criteria for generated blocks

The skill also instructs the cone on orchestration: how to create scoops,
delegate block work, collect results, and assemble the final page.

### 3. Extraction Scripts — In-Page JavaScript

Ported from vibemigration's Playwright worker. Run inside the target page
via `BrowserAPI.evaluate()`.

**Visual tree builder:**
- Walks the DOM recursively
- Captures per-node: tag, classes, ID, CSS selector, bounding box,
  background color (computed), text content (truncated)
- Produces structured JSON tree
- Includes background enrichment (common ancestor walk, cascade dedup)

**Brand extractor:**
- Scans computed styles across the page
- Extracts: font families, font sizes, font weights, color palette,
  spacing values, border radii
- Maps to CSS custom property conventions

**Metadata extractor:**
- Title, description, canonical URL
- Open Graph and Twitter Card tags
- JSON-LD structured data

### 4. Block Inventory Scanner

Reads the cloned EDS project structure to find existing blocks:
- Scans `/shared/<repo-name>/blocks/` directories
- Reads each block's CSS/JS to understand capabilities
- Produces inventory JSON so the agent can reuse existing blocks
  instead of generating duplicates

## Data Flow

```
User: migrate-page https://example.com/about --repo owner/eds-site

PHASE 1 — Extraction (shell command, mechanical)
  ├─ git clone owner/eds-site → /shared/eds-site/
  ├─ git checkout -b migrate/about
  ├─ browser.navigate("https://example.com/about")
  ├─ browser.screenshot({fullPage: true}) → .migration/screenshot.png
  ├─ browser.evaluate(visualTreeJS) → .migration/visual-tree.json
  ├─ browser.evaluate(brandExtractJS) → .migration/brand.json
  ├─ browser.evaluate(metadataJS) → .migration/metadata.json
  ├─ scanBlocks() → .migration/block-inventory.json
  └─ Returns: extraction summary + file paths

PHASE 2 — Decomposition (cone agent, guided by skill)
  ├─ Reads screenshot + visual-tree.json + block-inventory.json
  ├─ Decomposes page into fragments → sections → blocks
  ├─ Identifies N unique blocks to generate
  └─ Stores decomposition → .migration/decomposition.json

PHASE 3 — Block Migration (parallel scoops, one per block)
  ├─ Cone creates N scoops via scoop_scoop()
  ├─ Cone feeds each scoop via feed_scoop() with:
  │   ├─ Block name and CSS selector
  │   ├─ Source page URL
  │   ├─ Screenshot region for this block
  │   ├─ EDS project path (/shared/eds-site/)
  │   └─ Full migration skill instructions
  │
  └─ Each scoop (in parallel):
      ├─ Generate block CSS → /shared/eds-site/blocks/{name}/{name}.css
      ├─ Generate block JS → /shared/eds-site/blocks/{name}/{name}.js
      ├─ Create test page HTML with just this block
      ├─ browser.serve("/shared/eds-site/") → open preview tab
      ├─ Screenshot source component (original page, specific selector)
      ├─ Screenshot preview (preview tab)
      ├─ Compare visually (Claude vision)
      ├─ If not satisfactory → adjust CSS/JS → re-screenshot (max 3 iterations)
      └─ Signal completion via send_message

PHASE 4 — Assembly (cone agent)
  ├─ Collect results from all scoops
  ├─ Generate brand.css with CSS variables → /shared/eds-site/styles/brand.css
  ├─ Generate page content HTML (EDS format with block tables)
  │   → /shared/eds-site/<path>/index.html
  ├─ git add all changes
  ├─ git commit on migrate/<page-slug> branch
  └─ Report summary: blocks generated, preview instructions
```

## Directory Structure

```
/shared/eds-site/                    ← cloned EDS repo
  ├─ .migration/                     ← extraction artifacts (gitignored)
  │   ├─ screenshot.png              ← full-page screenshot
  │   ├─ visual-tree.json            ← DOM structure with bounds/backgrounds
  │   ├─ brand.json                  ← extracted fonts, colors, spacing
  │   ├─ metadata.json               ← title, OG, structured data
  │   ├─ block-inventory.json        ← existing blocks in the project
  │   └─ decomposition.json          ← page → fragments → sections → blocks
  ├─ blocks/
  │   ├─ hero/                       ← generated by hero-migrator scoop
  │   │   ├─ hero.css
  │   │   └─ hero.js
  │   ├─ cards/                      ← generated by cards-migrator scoop
  │   │   ├─ cards.css
  │   │   └─ cards.js
  │   └─ ...
  ├─ styles/
  │   ├─ styles.css                  ← existing (may be modified)
  │   └─ brand.css                   ← generated brand variables
  ├─ scripts/
  │   ├─ aem.js                      ← existing EDS library
  │   └─ scripts.js                  ← existing decoration pipeline
  └─ <page-path>/
      └─ index.html                  ← generated page content (EDS format)
```

## Preview Architecture

### Why `aem up` Is Not Needed

EDS rendering is 100% client-side. `aem.js` / `scripts.js`:
1. Scan the loaded DOM for block divs
2. Load `blocks/{name}/{name}.js` and `.css` via standard `import()` / `fetch()`
3. Call the block's default export to decorate the DOM

No special server endpoints. `aem up` is a file server + live reload +
content proxy. slicc's preview service worker is a file server.

### How Preview Works in slicc

1. `browser serve "/shared/eds-site/"` opens a tab at `/preview/index.html`
2. The preview service worker intercepts all `/preview/*` requests
3. It reads files from VFS and serves them with correct MIME types
4. `aem.js` loads at `/preview/scripts/aem.js`
5. Block CSS/JS load at `/preview/blocks/{name}/{name}.css|js`
6. The full EDS decoration pipeline runs in the browser tab

### Visual Verification Loop

Replaces vibemigration's pixelmatch-based capture-and-diff:

1. Agent screenshots the source component via
   `browser screenshot({selector: ".source-block"})`
2. Agent screenshots the preview via
   `browser screenshot({targetId: previewTab})`
3. Agent compares both screenshots using Claude's vision
4. Claude understands semantic differences ("nav links missing",
   "spacing too wide") not just pixel diffs
5. Agent adjusts block CSS/JS based on visual understanding
6. Repeat up to 3 iterations per block

This is more powerful than pixelmatch because the agent understands
what it's looking at.

## What Gets Ported from vibemigration

| Component | Source | Destination in slicc |
|-----------|--------|---------------------|
| Visual tree extraction JS | Playwright worker `/decompose` | In-page script via `evaluate()` |
| Brand extraction JS | Playwright worker `/brand` | In-page script via `evaluate()` |
| Background enrichment | Common ancestor walk + cascade dedup | Part of visual tree script |
| Decomposition methodology | Claude prompt in Playwright worker | Migration skill (SKILL.md) |
| Block generation patterns | Claude Code sandbox skills | Migration skill (SKILL.md) |
| Visual iteration loop | capture-and-diff.js + pixelmatch | Claude vision + browser screenshots |

## What Does NOT Get Ported

- Cloudflare workers infrastructure (orchestrator, crawler, processor, etc.)
- Site-wide crawling and analysis
- WebSocket real-time progress
- Block fingerprinting across pages
- DA upload (can add later as a separate step)
- Monitoring and analytics
- Language detection
- React Spectrum S2 UI

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Preview SW doesn't serve EDS correctly | Test with a known EDS project; fall back to push-and-preview via `aem.page` URL |
| Visual tree extraction misses dynamic content | Add wait-for-idle logic before extraction; handle SPAs |
| Multiple scoops writing to `/shared/` concurrently | Block subdirectories don't overlap; no file conflicts |
| Token cost with parallel scoops | User confirmed tokens are not a concern; quality is priority |
| isomorphic-git clone performance for large repos | Shallow clone (`--depth 1`) for initial setup |
| CORS when fetching source page assets | slicc's fetch proxy handles cross-origin requests |
| EDS project structure varies across repos | Block inventory scanner adapts to what's present |

## Future Extensions

These are explicitly out of scope but natural follow-ups:

- `migrate-page commit --push` — push to remote and return preview URL
- `migrate-page da-upload` — upload to Document Authoring API
- Site-wide analysis via `migrate-site` command
- Custom tab UI for migration progress visualization
- Block reuse detection across pages
