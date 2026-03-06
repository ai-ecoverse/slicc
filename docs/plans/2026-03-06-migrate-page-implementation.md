# migrate-page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `migrate_page` tool + migration skill that enables fully automated single-page EDS migration within slicc.

**Architecture:** A dedicated tool handles mechanical extraction (git clone, browser navigation, screenshot, DOM extraction, brand/metadata collection, block inventory). A bundled SKILL.md teaches the agent decomposition, block generation, scoop delegation, visual verification, and assembly. Extraction scripts are ported from vibemigration and run in-page via `evaluate()`.

**Tech Stack:** TypeScript, BrowserAPI (CDP), VirtualFS (IndexedDB/LightningFS), isomorphic-git (GitCommands), vitest + fake-indexeddb for tests.

**Design adjustment:** The design document specifies a "shell command" but shell commands in slicc don't have access to BrowserAPI — they only get `ctx.fs` and `ctx.cwd`. Since this feature requires browser automation (screenshots, evaluate), it's implemented as a **tool** instead, following the existing pattern of `createBrowserTool(browser, fs)`. This aligns with slicc's philosophy: "Only create a dedicated tool if the capability cannot work through bash (like browser automation requiring screenshot binary data)."

**Source reference:** Extraction scripts are ported from vibemigration at `/Users/catalan/repos/ai/aemcoder/vibemigration`. Key source files:
- Visual tree: `chrome-extension/src/content/visual-tree.ts`, `css-selector.ts`, `layout-detection.ts`
- Brand: `chrome-extension/src/content/brand-extractor.ts`
- Metadata: `playwright-worker/src/actions/collect/collectors/metadata.ts`
- Page prep: `playwright-worker/src/actions/collect/page-prep.ts`
- Decomposition prompt: `playwright-worker/src/decomposition/prompt.ts`
- Block migration skills: `claude-code-sandbox/.claude/skills/sandbox-block-migration/SKILL.md`
- Header migration skill: `claude-code-sandbox/.claude/skills/sandbox-header-migration/SKILL.md`

---

## Task 1: Migration Module Structure + Types

**Files:**
- Create: `src/migration/types.ts`
- Create: `src/migration/index.ts`

**Step 1: Create directory**

```bash
ls src/
```

Verify `src/migration/` does not exist.

**Step 2: Create types**

Create `src/migration/types.ts`:

```typescript
/**
 * Types for the page migration system.
 *
 * Extraction scripts run in-page via evaluate() and return
 * JSON-serializable data matching these interfaces.
 */

export interface VisualNode {
  id: string;
  tag: string;
  selector: string;
  bounds: { x: number; y: number; width: number; height: number };
  background?: { type: 'color' | 'gradient' | 'image'; value: string };
  text?: string;
  role?: string;
  layout?: string;
  children: VisualNode[];
}

export interface VisualTreeResult {
  tree: VisualNode;
  text: string;
  nodeMap: Record<string, string>;
}

export interface BrandData {
  fonts: {
    body: string;
    heading: string;
    sizes: Record<string, { desktop: string; mobile: string }>;
  };
  colors: {
    background: string;
    text: string;
    link: string;
    linkHover: string;
    light: string;
    dark: string;
  };
  spacing: {
    sectionPadding: string;
    contentMaxWidth: string;
    navHeight: string;
  };
  favicons: Array<{ url: string; rel: string; sizes?: string }>;
}

export interface PageMetadata {
  title: string;
  description: string;
  canonical?: string;
  ogTags: Record<string, string>;
  twitterTags: Record<string, string>;
  jsonLd?: unknown[];
}

export interface BlockInventoryEntry {
  name: string;
  hasJs: boolean;
  hasCss: boolean;
  jsSize?: number;
  cssSize?: number;
}

export interface ExtractionResult {
  url: string;
  repo: string;
  projectPath: string;
  branch: string;
  files: {
    screenshot: string;
    visualTree: string;
    brand: string;
    metadata: string;
    blockInventory: string;
  };
  blockCount: number;
  pageSlug: string;
}
```

**Step 3: Create barrel export**

Create `src/migration/index.ts`:

```typescript
export type {
  VisualNode,
  VisualTreeResult,
  BrandData,
  PageMetadata,
  BlockInventoryEntry,
  ExtractionResult,
} from './types.js';
```

**Step 4: Verify typecheck**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors related to `src/migration/`

**Step 5: Commit**

```bash
git add src/migration/
git commit -m "feat(migration): add module structure and types"
```

---

## Task 2: Page Preparation Script

**Files:**
- Create: `src/migration/scripts/page-prep-script.ts`
- Create: `src/migration/scripts/page-prep-script.test.ts`

The page prep script runs in-page to fix fixed-position elements and trigger lazy loading. This ensures the full page content is visible for extraction.

**Step 1: Write test**

Create `src/migration/scripts/page-prep-script.test.ts`:

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { PAGE_PREP_SCRIPT } from './page-prep-script.js';

describe('PAGE_PREP_SCRIPT', () => {
  it('is valid JavaScript', () => {
    expect(() => new Function(PAGE_PREP_SCRIPT)).not.toThrow();
  });

  it('converts fixed elements to relative', async () => {
    document.body.innerHTML = `
      <div id="nav" style="position: fixed; top: 0;">Nav</div>
      <div id="content">Content</div>
    `;
    const result = await eval(`(async () => { ${PAGE_PREP_SCRIPT} })()`);
    const parsed = JSON.parse(result);
    expect(parsed.fixedElementsConverted).toBe(1);
    expect(
      document.getElementById('nav')?.style.position
    ).toBe('relative');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/migration/scripts/page-prep-script.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/migration/scripts/page-prep-script.ts`. Port from vibemigration's
`playwright-worker/src/actions/collect/page-prep.ts` — the `fixFixedElements`
and `triggerLazyLoading` functions. Adapt to be a self-contained async IIFE
that returns JSON.

```typescript
/**
 * In-page script that prepares a page for extraction.
 *
 * Runs via BrowserAPI.evaluate(). Returns JSON string with stats.
 *
 * Ported from: vibemigration/playwright-worker/src/actions/collect/page-prep.ts
 */
export const PAGE_PREP_SCRIPT = `
(async () => {
  // Fix fixed-position elements
  let fixedCount = 0;
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    const style = window.getComputedStyle(el);
    if (style.position === 'fixed') {
      el.style.position = 'relative';
      fixedCount++;
    }
  }

  // Trigger lazy loading by scrolling through the page
  const viewportHeight = window.innerHeight;
  const totalHeight = document.body.scrollHeight;
  const steps = Math.ceil(totalHeight / viewportHeight);

  for (let i = 0; i <= steps; i++) {
    window.scrollTo(0, i * viewportHeight);
    await new Promise(r => setTimeout(r, 100));
  }
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 500));

  return JSON.stringify({
    fixedElementsConverted: fixedCount,
    totalHeight,
    stepsScrolled: steps,
  });
})()
`;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/migration/scripts/page-prep-script.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/migration/scripts/
git commit -m "feat(migration): add page preparation script"
```

---

## Task 3: Metadata Extraction Script

**Files:**
- Create: `src/migration/scripts/metadata-script.ts`
- Create: `src/migration/scripts/metadata-script.test.ts`

**Step 1: Write test**

Create `src/migration/scripts/metadata-script.test.ts`:

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { METADATA_EXTRACT_SCRIPT } from './metadata-script.js';

describe('METADATA_EXTRACT_SCRIPT', () => {
  it('is valid JavaScript', () => {
    expect(() => new Function(METADATA_EXTRACT_SCRIPT)).not.toThrow();
  });

  it('extracts title and meta tags', () => {
    document.title = 'Test Page';
    document.head.innerHTML = `
      <meta name="description" content="A test page">
      <meta property="og:title" content="OG Title">
      <meta property="og:image" content="https://example.com/img.png">
      <meta name="twitter:card" content="summary">
      <link rel="canonical" href="https://example.com/test">
    `;
    const result = JSON.parse(eval(METADATA_EXTRACT_SCRIPT));
    expect(result.title).toBe('Test Page');
    expect(result.description).toBe('A test page');
    expect(result.canonical).toBe('https://example.com/test');
    expect(result.ogTags['og:title']).toBe('OG Title');
    expect(result.twitterTags['twitter:card']).toBe('summary');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/migration/scripts/metadata-script.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `src/migration/scripts/metadata-script.ts`. Port from vibemigration's
`playwright-worker/src/actions/collect/collectors/metadata.ts`.

```typescript
/**
 * In-page script that extracts page metadata.
 *
 * Runs via BrowserAPI.evaluate(). Returns JSON string.
 *
 * Ported from: vibemigration/playwright-worker/src/actions/collect/collectors/metadata.ts
 */
export const METADATA_EXTRACT_SCRIPT = `
(() => {
  const ogTags = {};
  const twitterTags = {};

  document.querySelectorAll('meta').forEach(meta => {
    const property = meta.getAttribute('property') || '';
    const name = meta.getAttribute('name') || '';
    const content = meta.getAttribute('content') || '';

    if (property.startsWith('og:')) ogTags[property] = content;
    if (name.startsWith('twitter:') || property.startsWith('twitter:')) {
      twitterTags[name || property] = content;
    }
  });

  const canonical = document.querySelector('link[rel="canonical"]');
  const description = document.querySelector(
    'meta[name="description"]'
  );

  const jsonLdScripts = document.querySelectorAll(
    'script[type="application/ld+json"]'
  );
  const jsonLd = [];
  jsonLdScripts.forEach(script => {
    try { jsonLd.push(JSON.parse(script.textContent || '')); }
    catch { /* skip invalid */ }
  });

  return JSON.stringify({
    title: document.title || '',
    description: description?.getAttribute('content') || '',
    canonical: canonical?.getAttribute('href') || null,
    ogTags,
    twitterTags,
    jsonLd: jsonLd.length > 0 ? jsonLd : undefined,
  });
})()
`;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/migration/scripts/metadata-script.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/migration/scripts/metadata-script.*
git commit -m "feat(migration): add metadata extraction script"
```

---

## Task 4: Visual Tree Extraction Script

**Files:**
- Create: `src/migration/scripts/visual-tree-script.ts`
- Create: `src/migration/scripts/visual-tree-script.test.ts`

This is the largest extraction script. It ports three modules from vibemigration:
- `chrome-extension/src/content/css-selector.ts` — unique CSS selector generation
- `chrome-extension/src/content/layout-detection.ts` — multi-column grid detection
- `chrome-extension/src/content/visual-tree.ts` — DOM walker with bounds, backgrounds, text

All three must be inlined into a single IIFE string since it runs via `evaluate()`.

**Step 1: Write test**

Create `src/migration/scripts/visual-tree-script.test.ts`:

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { VISUAL_TREE_SCRIPT } from './visual-tree-script.js';

describe('VISUAL_TREE_SCRIPT', () => {
  it('is valid JavaScript', () => {
    expect(() => new Function(VISUAL_TREE_SCRIPT)).not.toThrow();
  });

  it('produces tree with expected structure', () => {
    document.body.innerHTML = `
      <header id="nav">
        <nav><a href="/">Home</a></nav>
      </header>
      <main id="content">
        <section>
          <h1>Hello World</h1>
          <p>Some content here</p>
        </section>
      </main>
      <footer id="footer">Footer</footer>
    `;

    // Mock getBoundingClientRect (jsdom returns zeros)
    Element.prototype.getBoundingClientRect = function() {
      return { x: 0, y: 0, width: 1200, height: 100,
               top: 0, right: 1200, bottom: 100, left: 0, toJSON() {} };
    };

    const result = JSON.parse(eval(VISUAL_TREE_SCRIPT));
    expect(result).toHaveProperty('tree');
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('nodeMap');
    expect(result.tree).toHaveProperty('tag');
    expect(result.tree).toHaveProperty('selector');
    expect(result.tree).toHaveProperty('bounds');
    expect(result.tree).toHaveProperty('children');
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/migration/scripts/visual-tree-script.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `src/migration/scripts/visual-tree-script.ts`. This is a large file (~400 lines).

Port from vibemigration and inline into a single IIFE. The source files to
port from:
- `/Users/catalan/repos/ai/aemcoder/vibemigration/chrome-extension/src/content/css-selector.ts`
  → `getCssSelector(element)` function
- `/Users/catalan/repos/ai/aemcoder/vibemigration/chrome-extension/src/content/layout-detection.ts`
  → `detectLayout(boxes)` function
- `/Users/catalan/repos/ai/aemcoder/vibemigration/chrome-extension/src/content/visual-tree.ts`
  → `captureVisualTree(minWidth)` main function, plus:
  → `buildVisualNode(element, minWidth)` — recursive DOM walker
  → `collapseSingleChildren(node)` — tree optimization
  → `assignPositionalIds(node, prefix, nodeMap)` — ID assignment
  → `formatTreeAsText(node, depth, nodeId, rootBackground)` — text output
  → `parseRgb(color)`, `rgbToLab(rgb)`, `deltaE(c1, c2)` — color comparison

Structure of the exported string:

```typescript
/**
 * In-page script that builds a visual tree of the DOM.
 *
 * Returns JSON with:
 * - tree: hierarchical VisualNode structure
 * - text: indented text representation for LLM consumption
 * - nodeMap: positional ID → CSS selector mapping
 *
 * Ported from: vibemigration/chrome-extension/src/content/visual-tree.ts
 *              vibemigration/chrome-extension/src/content/css-selector.ts
 *              vibemigration/chrome-extension/src/content/layout-detection.ts
 */
export const VISUAL_TREE_SCRIPT = `
(() => {
  // === CSS Selector Generation ===
  // Port getCssSelector(element) from css-selector.ts
  function getCssSelector(element) {
    // ... Chrome DevTools algorithm for unique CSS selectors ...
  }

  // === Layout Detection ===
  // Port detectLayout(boxes) from layout-detection.ts
  function detectLayout(children) {
    // ... Analyzes bounding boxes for grid patterns ...
  }

  // === Color Comparison (CIELAB) ===
  function parseRgb(color) { /* ... */ }
  function rgbToLab(rgb) { /* ... */ }
  function deltaE(c1, c2) { /* ... */ }

  // === Visual Tree Builder ===
  function buildVisualNode(element, minWidth) {
    // ... Recursive DOM walker ...
  }

  function collapseSingleChildren(node) {
    // ... Bottom-up tree optimization ...
  }

  function assignPositionalIds(node, prefix, nodeMap) {
    // ... Maps selectors to positional IDs ...
  }

  function formatTreeAsText(node, depth, nodeId, rootBg) {
    // ... Indented text output for LLM ...
  }

  // === Main Entry Point ===
  function captureVisualTree(minWidth = 900) {
    const nodeMap = {};
    const root = buildVisualNode(document.body, minWidth);
    collapseSingleChildren(root);
    assignPositionalIds(root, 'r', nodeMap);
    const text = formatTreeAsText(root, 0, 'r', root.background);
    return { tree: root, text, nodeMap };
  }

  return JSON.stringify(captureVisualTree());
})()
`;
```

**Implementation note for the executing agent:** Read the three source files
from vibemigration COMPLETELY. The visual-tree.ts is ~300 lines, css-selector.ts
is ~100 lines, layout-detection.ts is ~50 lines. Inline all functions into the
IIFE string, converting TypeScript types to plain JavaScript. Key adaptations:
- Remove all `import` statements (everything is inlined)
- Remove TypeScript type annotations
- Remove `export` keywords
- Ensure all function references are available in the IIFE scope
- The IIFE must return `JSON.stringify(captureVisualTree())`

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/migration/scripts/visual-tree-script.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/migration/scripts/visual-tree-script.*
git commit -m "feat(migration): add visual tree extraction script"
```

---

## Task 5: Brand Extraction Script

**Files:**
- Create: `src/migration/scripts/brand-script.ts`
- Create: `src/migration/scripts/brand-script.test.ts`

**Step 1: Write test**

Create `src/migration/scripts/brand-script.test.ts`:

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { BRAND_EXTRACT_SCRIPT } from './brand-script.js';

describe('BRAND_EXTRACT_SCRIPT', () => {
  it('is valid JavaScript', () => {
    expect(() => new Function(BRAND_EXTRACT_SCRIPT)).not.toThrow();
  });

  it('extracts font and color data', () => {
    document.body.innerHTML = `
      <h1 style="font-family: Serif; font-size: 48px;">Title</h1>
      <p style="font-family: Sans; font-size: 16px;">Text</p>
      <a href="#" style="color: blue;">Link</a>
    `;
    const result = JSON.parse(eval(BRAND_EXTRACT_SCRIPT));
    expect(result).toHaveProperty('fonts');
    expect(result).toHaveProperty('colors');
    expect(result).toHaveProperty('spacing');
    expect(result).toHaveProperty('favicons');
    expect(result.fonts).toHaveProperty('body');
    expect(result.fonts).toHaveProperty('heading');
    expect(result.colors).toHaveProperty('background');
    expect(result.colors).toHaveProperty('text');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/migration/scripts/brand-script.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `src/migration/scripts/brand-script.ts`. Port from vibemigration's
`chrome-extension/src/content/brand-extractor.ts`.

Key functions to port:
- `extractBrandData()` — main entry point
- Font detection: most common font family in `<p>` elements (body) and
  `<h1>,<h2>,<h3>` elements (heading)
- Font sizes: maps h1-h6 to EDS tiers (xxl, xl, l, m, s, xs) with desktop
  values extracted from computed styles and EDS mobile defaults
- Color extraction: background, text, link, link:hover colors from computed
  styles. Light/dark section backgrounds via luminance analysis
  (`luminance = 0.299*R + 0.587*G + 0.114*B`)
- Spacing: section padding, content max-width, nav height from computed styles
- Favicons: `<link rel*="icon">` tags with absolute URL resolution

```typescript
/**
 * In-page script that extracts brand data (fonts, colors, spacing).
 *
 * Ported from: vibemigration/chrome-extension/src/content/brand-extractor.ts
 */
export const BRAND_EXTRACT_SCRIPT = `
(() => {
  function luminance(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  function parseRgbValues(color) {
    const m = color.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  function getMostCommonFont(selector) {
    const counts = {};
    document.querySelectorAll(selector).forEach(el => {
      const family = getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/['"]/g, '');
      counts[family] = (counts[family] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }

  // ... (port remaining extraction logic from brand-extractor.ts) ...

  const result = extractBrandData();
  return JSON.stringify(result);
})()
`;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/migration/scripts/brand-script.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/migration/scripts/brand-script.*
git commit -m "feat(migration): add brand extraction script"
```

---

## Task 6: Block Inventory Scanner

**Files:**
- Create: `src/migration/block-inventory.ts`
- Create: `src/migration/block-inventory.test.ts`

Unlike the in-page scripts, this runs on slicc's VFS (not in the browser).

**Step 1: Write test**

Create `src/migration/block-inventory.test.ts`:

```typescript
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/virtual-fs.js';
import { scanBlockInventory } from './block-inventory.js';

describe('scanBlockInventory', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-block-inv-${dbCounter++}`,
      wipe: true,
    });
  });

  it('returns empty array when blocks/ does not exist', async () => {
    await vfs.mkdir('/project', { recursive: true });
    const result = await scanBlockInventory(vfs, '/project');
    expect(result).toEqual([]);
  });

  it('scans block directories for JS and CSS files', async () => {
    await vfs.mkdir('/project/blocks/hero', { recursive: true });
    await vfs.mkdir('/project/blocks/cards', { recursive: true });
    await vfs.writeFile('/project/blocks/hero/hero.js', 'export default function() {}');
    await vfs.writeFile('/project/blocks/hero/hero.css', '.hero { color: red; }');
    await vfs.writeFile('/project/blocks/cards/cards.css', '.cards { display: grid; }');

    const result = await scanBlockInventory(vfs, '/project');
    expect(result).toHaveLength(2);

    const hero = result.find(b => b.name === 'hero');
    expect(hero).toBeDefined();
    expect(hero?.hasJs).toBe(true);
    expect(hero?.hasCss).toBe(true);

    const cards = result.find(b => b.name === 'cards');
    expect(cards).toBeDefined();
    expect(cards?.hasJs).toBe(false);
    expect(cards?.hasCss).toBe(true);
  });

  it('ignores non-block files', async () => {
    await vfs.mkdir('/project/blocks/hero', { recursive: true });
    await vfs.writeFile('/project/blocks/hero/hero.js', 'code');
    await vfs.writeFile('/project/blocks/hero/README.md', 'docs');
    await vfs.writeFile('/project/blocks/.DS_Store', '');

    const result = await scanBlockInventory(vfs, '/project');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('hero');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/migration/block-inventory.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `src/migration/block-inventory.ts`:

```typescript
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { BlockInventoryEntry } from './types.js';

export async function scanBlockInventory(
  fs: VirtualFS,
  projectPath: string,
): Promise<BlockInventoryEntry[]> {
  const blocksDir = `${projectPath}/blocks`;
  const entries: BlockInventoryEntry[] = [];

  try {
    const dirs = await fs.readDir(blocksDir);
    for (const name of dirs) {
      const blockDir = `${blocksDir}/${name}`;
      const stat = await fs.stat(blockDir);
      if (stat.type !== 'directory') continue;

      const files = await fs.readDir(blockDir);
      const jsFile = files.find(f => f === `${name}.js`);
      const cssFile = files.find(f => f === `${name}.css`);

      if (!jsFile && !cssFile) continue;

      let jsSize: number | undefined;
      let cssSize: number | undefined;

      if (jsFile) {
        const content = await fs.readFile(`${blockDir}/${jsFile}`, { encoding: 'utf-8' });
        jsSize = typeof content === 'string' ? content.length : content.byteLength;
      }
      if (cssFile) {
        const content = await fs.readFile(`${blockDir}/${cssFile}`, { encoding: 'utf-8' });
        cssSize = typeof content === 'string' ? content.length : content.byteLength;
      }

      entries.push({
        name,
        hasJs: !!jsFile,
        hasCss: !!cssFile,
        jsSize,
        cssSize,
      });
    }
  } catch {
    // blocks/ directory doesn't exist
  }

  return entries;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/migration/block-inventory.test.ts`
Expected: PASS

**Step 5: Update barrel export**

Edit `src/migration/index.ts` to add:

```typescript
export { scanBlockInventory } from './block-inventory.js';
```

**Step 6: Commit**

```bash
git add src/migration/block-inventory.* src/migration/index.ts
git commit -m "feat(migration): add block inventory scanner"
```

---

## Task 7: migrate_page Tool — Skeleton + Input Validation

**Files:**
- Create: `src/tools/migrate-page-tool.ts`
- Create: `src/tools/migrate-page-tool.test.ts`

**Step 1: Write test**

Create `src/tools/migrate-page-tool.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createMigratePageTool } from './migrate-page-tool.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { VirtualFS } from '../fs/virtual-fs.js';

function mockBrowserAPI(): BrowserAPI {
  return {
    connect: vi.fn(),
    createPage: vi.fn(),
    listPages: vi.fn().mockResolvedValue([]),
    attachToPage: vi.fn().mockResolvedValue('session-1'),
    navigate: vi.fn(),
    screenshot: vi.fn().mockResolvedValue('base64png'),
    evaluate: vi.fn().mockResolvedValue('{}'),
    click: vi.fn(),
    type: vi.fn(),
    waitForSelector: vi.fn(),
    getAccessibilityTree: vi.fn(),
    getTransport: vi.fn(),
  } as unknown as BrowserAPI;
}

function mockVFS(): VirtualFS {
  return {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    readDir: vi.fn().mockResolvedValue([]),
    stat: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    rm: vi.fn(),
    rename: vi.fn(),
    getLightningFS: vi.fn(),
  } as unknown as VirtualFS;
}

describe('migrate_page tool', () => {
  it('has correct name and schema', () => {
    const tool = createMigratePageTool(mockBrowserAPI(), mockVFS());
    expect(tool.name).toBe('migrate_page');
    expect(tool.inputSchema.properties).toHaveProperty('url');
    expect(tool.inputSchema.properties).toHaveProperty('repo');
    expect(tool.inputSchema.required).toContain('url');
    expect(tool.inputSchema.required).toContain('repo');
  });

  it('rejects missing url', async () => {
    const tool = createMigratePageTool(mockBrowserAPI(), mockVFS());
    const result = await tool.execute({ repo: 'owner/repo' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('url');
  });

  it('rejects invalid repo format', async () => {
    const tool = createMigratePageTool(mockBrowserAPI(), mockVFS());
    const result = await tool.execute({ url: 'https://example.com', repo: 'noslash' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('owner/repo');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/migrate-page-tool.test.ts`
Expected: FAIL

**Step 3: Write tool skeleton**

Create `src/tools/migrate-page-tool.ts`:

```typescript
import type { ToolDefinition, ToolResult } from '../core/types.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { VirtualFS } from '../fs/virtual-fs.js';

export function createMigratePageTool(
  browser: BrowserAPI,
  fs: VirtualFS,
): ToolDefinition {
  return {
    name: 'migrate_page',
    description:
      'Extract page data for EDS migration. Clones the target repo, ' +
      'navigates to the URL, captures a full-page screenshot, extracts ' +
      'the visual tree (DOM structure with bounds, backgrounds, selectors), ' +
      'brand data (fonts, colors, spacing), metadata (title, OG tags), ' +
      'and inventories existing blocks. Returns file paths for all ' +
      'extraction artifacts. Use the migrate-page skill to interpret ' +
      'results and generate EDS blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the page to migrate',
        },
        repo: {
          type: 'string',
          description: 'GitHub repository in owner/repo format',
        },
      },
      required: ['url', 'repo'],
    },

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const url = input.url as string | undefined;
      const repo = input.repo as string | undefined;

      if (!url) {
        return { content: 'Error: url is required', isError: true };
      }
      if (!repo || !repo.includes('/')) {
        return {
          content: 'Error: repo must be in owner/repo format',
          isError: true,
        };
      }

      try {
        return await runMigrationExtraction(browser, fs, url, repo);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Migration extraction failed: ${msg}`, isError: true };
      }
    },
  };
}

async function runMigrationExtraction(
  browser: BrowserAPI,
  fs: VirtualFS,
  url: string,
  repo: string,
): Promise<ToolResult> {
  // TODO: Task 8 — git clone + branch
  // TODO: Task 9 — browser extraction pipeline
  return {
    content: `Migration extraction not yet implemented for ${url} (${repo})`,
    isError: true,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/migrate-page-tool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/tools/migrate-page-tool.*
git commit -m "feat(migration): add migrate_page tool skeleton with input validation"
```

---

## Task 8: migrate_page Tool — Git Operations

**Files:**
- Modify: `src/tools/migrate-page-tool.ts`
- Modify: `src/tools/migrate-page-tool.test.ts`

**Step 1: Write test for git operations**

Add to `src/tools/migrate-page-tool.test.ts`:

```typescript
import 'fake-indexeddb/auto';
import { VirtualFS } from '../fs/virtual-fs.js';
import { GitCommands } from '../git/git-commands.js';

describe('migrate_page tool — git operations', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let dbCounter = 100;

  beforeEach(async () => {
    const id = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `mig-git-${id}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test',
      authorEmail: 'test@test.com',
      globalDbName: `mig-git-global-${id}`,
    });

    // Create a local "remote" repo to clone from
    await git.execute(['init'], '/remote-repo');
    await vfs.writeFile('/remote-repo/README.md', '# Test');
    await vfs.mkdir('/remote-repo/blocks', { recursive: true });
    await git.execute(['add', '.'], '/remote-repo');
    await git.execute(['commit', '-m', 'init'], '/remote-repo');
  });

  it('derives project path from repo name', () => {
    // Test the slug derivation: "owner/my-eds-site" → "/shared/my-eds-site"
    const result = deriveProjectPath('owner/my-eds-site');
    expect(result).toBe('/shared/my-eds-site');
  });

  it('derives branch name from URL path', () => {
    const result = deriveBranchName('https://example.com/products/overview');
    expect(result).toBe('migrate/products-overview');
  });

  it('derives branch name from root URL', () => {
    const result = deriveBranchName('https://example.com/');
    expect(result).toBe('migrate/index');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/migrate-page-tool.test.ts`
Expected: FAIL

**Step 3: Implement git helper functions**

Edit `src/tools/migrate-page-tool.ts` — add helper functions and implement
the git portion of `runMigrationExtraction`:

```typescript
import { GitCommands } from '../git/git-commands.js';

export function deriveProjectPath(repo: string): string {
  const repoName = repo.split('/').pop() || repo;
  return `/shared/${repoName}`;
}

export function deriveBranchName(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/|\/$/g, '') || 'index';
  const slug = path.replace(/\//g, '-');
  return `migrate/${slug}`;
}

function derivePageSlug(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.replace(/^\/|\/$/g, '') || 'index';
}

async function runMigrationExtraction(
  browser: BrowserAPI,
  fs: VirtualFS,
  url: string,
  repo: string,
): Promise<ToolResult> {
  const projectPath = deriveProjectPath(repo);
  const branch = deriveBranchName(url);
  const pageSlug = derivePageSlug(url);
  const migrationDir = `${projectPath}/.migration`;

  // 1. Clone repo if not already present
  const exists = await fs.exists(projectPath);
  if (!exists) {
    const git = new GitCommands({ fs });
    const repoUrl = `https://github.com/${repo}.git`;
    const result = await git.execute(
      ['clone', repoUrl, projectPath, '--depth', '1'],
      '/shared',
    );
    if (result.exitCode !== 0) {
      return {
        content: `Git clone failed: ${result.stderr}`,
        isError: true,
      };
    }
  }

  // 2. Create migration branch
  const git = new GitCommands({ fs });
  await git.execute(['checkout', '-b', branch], projectPath);

  // 3. Create .migration directory
  await fs.mkdir(migrationDir, { recursive: true });

  // TODO: Task 9 — browser extraction pipeline continues here

  return { content: 'Extraction not yet complete', isError: true };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/migrate-page-tool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/tools/migrate-page-tool.*
git commit -m "feat(migration): add git clone and branch operations to migrate_page tool"
```

---

## Task 9: migrate_page Tool — Extraction Pipeline

**Files:**
- Modify: `src/tools/migrate-page-tool.ts`
- Modify: `src/tools/migrate-page-tool.test.ts`

**Step 1: Write test for extraction pipeline**

Add to `src/tools/migrate-page-tool.test.ts`:

```typescript
describe('migrate_page tool — extraction pipeline', () => {
  it('calls browser API in correct sequence', async () => {
    const browser = mockBrowserAPI();
    const vfs = mockVFS();

    // Mock: repo already exists
    (vfs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    // Mock: block inventory
    (vfs.readDir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // Mock browser responses
    (browser.attachToPage as ReturnType<typeof vi.fn>)
      .mockResolvedValue('session-1');
    (browser.evaluate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('{"fixedElementsConverted":0}') // page prep
      .mockResolvedValueOnce('{"tree":{},"text":"","nodeMap":{}}') // visual tree
      .mockResolvedValueOnce('{"fonts":{},"colors":{},"spacing":{},"favicons":[]}') // brand
      .mockResolvedValueOnce('{"title":"Test","description":""}'); // metadata
    (browser.screenshot as ReturnType<typeof vi.fn>)
      .mockResolvedValue('iVBOR...base64...');
    (browser.createPage as ReturnType<typeof vi.fn>)
      .mockResolvedValue('target-1');

    const tool = createMigratePageTool(browser, vfs);
    const result = await tool.execute({
      url: 'https://example.com/about',
      repo: 'owner/eds-site',
    });

    // Verify browser calls
    expect(browser.createPage).toHaveBeenCalledWith('https://example.com/about');
    expect(browser.attachToPage).toHaveBeenCalled();
    expect(browser.evaluate).toHaveBeenCalledTimes(4); // prep + 3 extractions
    expect(browser.screenshot).toHaveBeenCalled();

    // Verify files written
    expect(vfs.writeFile).toHaveBeenCalled();
    const writeCalls = (vfs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    const paths = writeCalls.map((c: unknown[]) => c[0]);
    expect(paths).toContain('/shared/eds-site/.migration/screenshot.png');
    expect(paths).toContain('/shared/eds-site/.migration/visual-tree.json');
    expect(paths).toContain('/shared/eds-site/.migration/brand.json');
    expect(paths).toContain('/shared/eds-site/.migration/metadata.json');

    // Verify result is not an error
    expect(result.isError).toBeFalsy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/migrate-page-tool.test.ts`
Expected: FAIL

**Step 3: Implement extraction pipeline**

Edit `src/tools/migrate-page-tool.ts` — complete the `runMigrationExtraction`
function:

```typescript
import { PAGE_PREP_SCRIPT } from '../migration/scripts/page-prep-script.js';
import { VISUAL_TREE_SCRIPT } from '../migration/scripts/visual-tree-script.js';
import { BRAND_EXTRACT_SCRIPT } from '../migration/scripts/brand-script.js';
import { METADATA_EXTRACT_SCRIPT } from '../migration/scripts/metadata-script.js';
import { scanBlockInventory } from '../migration/block-inventory.js';
import type { ExtractionResult } from '../migration/types.js';

async function runMigrationExtraction(
  browser: BrowserAPI,
  fs: VirtualFS,
  url: string,
  repo: string,
): Promise<ToolResult> {
  const projectPath = deriveProjectPath(repo);
  const branch = deriveBranchName(url);
  const pageSlug = derivePageSlug(url);
  const migrationDir = `${projectPath}/.migration`;

  // 1. Clone repo if not already present
  const exists = await fs.exists(projectPath);
  if (!exists) {
    const git = new GitCommands({ fs });
    const repoUrl = `https://github.com/${repo}.git`;
    const cloneResult = await git.execute(
      ['clone', repoUrl, projectPath, '--depth', '1'],
      '/shared',
    );
    if (cloneResult.exitCode !== 0) {
      return {
        content: `Git clone failed: ${cloneResult.stderr}`,
        isError: true,
      };
    }
  }

  // 2. Create migration branch
  const git = new GitCommands({ fs });
  await git.execute(['checkout', '-b', branch], projectPath);

  // 3. Create .migration directory
  await fs.mkdir(migrationDir, { recursive: true });

  // 4. Navigate to URL
  const targetId = await browser.createPage(url);
  await browser.attachToPage(targetId);

  // 5. Prepare page (fix fixed elements, trigger lazy loading)
  await browser.evaluate(PAGE_PREP_SCRIPT);

  // 6. Take full-page screenshot
  const screenshotBase64 = await browser.screenshot({ fullPage: true });
  const screenshotBytes = base64ToBytes(screenshotBase64 as string);
  const screenshotPath = `${migrationDir}/screenshot.png`;
  await fs.writeFile(screenshotPath, screenshotBytes);

  // 7. Extract visual tree
  const treeJson = await browser.evaluate(VISUAL_TREE_SCRIPT);
  const treePath = `${migrationDir}/visual-tree.json`;
  await fs.writeFile(treePath, treeJson as string);

  // 8. Extract brand data
  const brandJson = await browser.evaluate(BRAND_EXTRACT_SCRIPT);
  const brandPath = `${migrationDir}/brand.json`;
  await fs.writeFile(brandPath, brandJson as string);

  // 9. Extract metadata
  const metaJson = await browser.evaluate(METADATA_EXTRACT_SCRIPT);
  const metaPath = `${migrationDir}/metadata.json`;
  await fs.writeFile(metaPath, metaJson as string);

  // 10. Scan block inventory
  const inventory = await scanBlockInventory(fs, projectPath);
  const inventoryPath = `${migrationDir}/block-inventory.json`;
  await fs.writeFile(inventoryPath, JSON.stringify(inventory, null, 2));

  // 11. Return structured result
  const extraction: ExtractionResult = {
    url,
    repo,
    projectPath,
    branch,
    pageSlug,
    files: {
      screenshot: screenshotPath,
      visualTree: treePath,
      brand: brandPath,
      metadata: metaPath,
      blockInventory: inventoryPath,
    },
    blockCount: inventory.length,
  };

  return {
    content: formatExtractionSummary(extraction),
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function formatExtractionSummary(result: ExtractionResult): string {
  return [
    `## Migration Extraction Complete`,
    ``,
    `**URL:** ${result.url}`,
    `**Repo:** ${result.repo}`,
    `**Project:** ${result.projectPath}`,
    `**Branch:** ${result.branch}`,
    `**Existing blocks:** ${result.blockCount}`,
    ``,
    `### Extraction Files`,
    `- Screenshot: ${result.files.screenshot}`,
    `- Visual tree: ${result.files.visualTree}`,
    `- Brand data: ${result.files.brand}`,
    `- Metadata: ${result.files.metadata}`,
    `- Block inventory: ${result.files.blockInventory}`,
    ``,
    `Next: Read the visual tree and screenshot to decompose the page ` +
    `into fragments, sections, and blocks. Then create scoops for ` +
    `parallel block generation. Follow the migrate-page skill instructions.`,
  ].join('\n');
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/migrate-page-tool.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/tools/migrate-page-tool.*
git commit -m "feat(migration): implement full extraction pipeline in migrate_page tool"
```

---

## Task 10: Register Tool in scoop-context.ts

**Files:**
- Modify: `src/scoops/scoop-context.ts:113-119`
- Modify: `src/tools/index.ts`

**Step 1: Add export to tools barrel**

Edit `src/tools/index.ts` — add the export:

```typescript
export { createMigratePageTool } from './migrate-page-tool.js';
```

**Step 2: Register in scoop-context.ts**

Edit `src/scoops/scoop-context.ts` — add the import and tool registration:

At the top, add to imports:
```typescript
import { createMigratePageTool } from '../tools/index.js';
```

In the `init()` method, add to legacyTools array (after line 116):
```typescript
const legacyTools = [
  ...createFileTools(this.fs as VirtualFS),
  createBashTool(this.shell),
  createBrowserTool(browser, this.fs as VirtualFS),
  createMigratePageTool(browser, this.fs as VirtualFS),  // NEW
  ...createSearchTools(this.fs as VirtualFS),
  createJavaScriptTool(this.fs as VirtualFS),
  ...nanoClawTools,
];
```

**Step 3: Verify typecheck**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors

**Step 4: Commit**

```bash
git add src/tools/index.ts src/scoops/scoop-context.ts
git commit -m "feat(migration): register migrate_page tool in scoop context"
```

---

## Task 11: Migration Skill (SKILL.md)

**Files:**
- Create: `src/defaults/workspace/skills/migrate-page/SKILL.md`

This is the knowledge layer — it teaches the agent the complete EDS migration
methodology. The content is ported from:
- vibemigration's decomposition prompt (`playwright-worker/src/decomposition/prompt.ts`)
- vibemigration's block migration skill (`claude-code-sandbox/.claude/skills/sandbox-block-migration/SKILL.md`)
- vibemigration's header migration skill (`claude-code-sandbox/.claude/skills/sandbox-header-migration/SKILL.md`)

**Step 1: Create the skill**

Create `src/defaults/workspace/skills/migrate-page/SKILL.md`:

```markdown
---
name: migrate-page
description: Migrate a web page to AEM Edge Delivery Services. Extracts page structure, decomposes into blocks, generates EDS-compatible code, and verifies with visual comparison.
allowed-tools: migrate_page,browser,read_file,write_file,edit_file,bash
---

# Page Migration to AEM Edge Delivery Services

Migrate any web page to EDS by extracting its structure, decomposing it into
blocks, generating code, and verifying visually.

## Quick Start

When the user asks to migrate a page:

1. Call `migrate_page` tool with `url` and `repo`
2. Read the extraction files (visual tree, screenshot, brand, metadata)
3. Decompose the page into fragments → sections → blocks
4. Create one scoop per block for parallel generation
5. Assemble the final page and commit

## Phase 1: Extraction

Call the `migrate_page` tool:
```json
{ "url": "https://example.com/page", "repo": "owner/eds-site" }
```

This clones the repo to `/shared/eds-site/`, creates a migration branch,
navigates to the URL, and extracts:
- Full-page screenshot → `.migration/screenshot.png`
- Visual tree → `.migration/visual-tree.json`
- Brand data → `.migration/brand.json`
- Metadata → `.migration/metadata.json`
- Block inventory → `.migration/block-inventory.json`

## Phase 2: Decomposition

Read the visual tree and screenshot. The visual tree is a text representation:

```
r [body] @0,0 1200x5000
  rc1 [header] [bg:color] @0,0 1200x80 "Logo Nav..."
    rc1c1 [nav] [3x1] @100,10 1000x60
  rc2 [main] @0,80 1200x4500
    rc2c1 [section] [bg:color] @0,80 1200x600 "Hero Title..."
    rc2c2 [section] @0,680 1200x800
      rc2c2c1 [div] [3x1] @100,700 1000x400 "Card 1..."
  rc3 [footer] [bg:color] @0,4580 1200x420
```

Format: `{id} [{role/tag}] [{CxR layout}] [{bg:type}] @{x},{y} {w}x{h} "{text}"`

### Classification Rules

Classify each visual element as one of:
- **default-content**: Simple prose (headings, paragraphs, lists, images).
  THE TYPING TEST: Can an author create this by typing in Word/Google Docs?
- **block**: Structured component requiring decoration (cards, tabs, accordion,
  carousel). Any element with `[CxR]` layout where C >= 2 MUST be a block.
- **section**: Visual grouping. Background changes signal section boundaries.

### Required Fragments

Every page decomposes into exactly 3 fragments:
1. `/nav` — The navigation/header (first `<header>` or top-level nav)
2. `/{page-path}` — The main content area
3. `/footer` — The page footer

### Output Format

Write decomposition to `.migration/decomposition.json`:

```json
{
  "fragments": [
    {
      "path": "/nav",
      "selector": "header",
      "children": [
        { "type": "block", "name": "header", "selector": "rc1" }
      ]
    },
    {
      "path": "/about",
      "selector": "main",
      "children": [
        {
          "type": "section",
          "background": "#ffffff",
          "children": [
            { "type": "block", "name": "hero", "selector": "rc2c1" },
            { "type": "default-content", "selector": "rc2c1c2",
              "content": "paragraph text" }
          ]
        },
        {
          "type": "section",
          "background": "#f5f5f5",
          "children": [
            { "type": "block", "name": "cards", "selector": "rc2c2c1" }
          ]
        }
      ]
    },
    {
      "path": "/footer",
      "selector": "footer",
      "children": [
        { "type": "block", "name": "footer", "selector": "rc3" }
      ]
    }
  ]
}
```

## Phase 3: Block Generation (Parallel Scoops)

For each unique block in the decomposition, create a scoop:

```
scoop_scoop({ name: "hero-migrator" })
feed_scoop({
  scoop_name: "hero-migrator-scoop",
  prompt: "... complete instructions below ..."
})
```

### Block Scoop Prompt Template

Include ALL of this in the feed_scoop prompt (scoops have no conversation context):

```
You are migrating a web component to an AEM Edge Delivery Services block.

## Source
- Page URL: {url}
- Block name: {blockName}
- Block selector on original page: {selector}

## EDS Project
- Project path: /shared/{repo-name}/
- Write block files to: /shared/{repo-name}/blocks/{blockName}/

## Your Task

1. **Generate block CSS** — `/shared/{repo-name}/blocks/{blockName}/{blockName}.css`
   - Use CSS custom properties from brand data
   - Target the `.{blockName}` class (EDS auto-adds this)
   - Include responsive styles (mobile-first)

2. **Generate block JS** — `/shared/{repo-name}/blocks/{blockName}/{blockName}.js`
   - Export default async function that receives the block element
   - Restructure DOM for the desired layout
   - Add semantic classes for CSS targeting

3. **Create test page** — `/shared/{repo-name}/.migration/test-{blockName}.html`
   - Minimal HTML page that includes scripts/aem.js and uses this block
   - Block content as an HTML table (EDS content model)

4. **Visual verification** (up to 3 iterations):
   a. Use `browser serve "/shared/{repo-name}/"` with entry `.migration/test-{blockName}.html`
   b. Screenshot the source component: `browser screenshot` with selector on the original page
   c. Screenshot the preview: `browser screenshot` on the preview tab
   d. Compare both screenshots visually
   e. If the preview doesn't match, adjust CSS/JS and repeat
   f. Maximum 3 iterations. Aim for visual parity, not pixel-perfect.

5. Signal completion via `send_message` with a summary of what was generated.
```

### EDS Block Content Model

EDS blocks are authored as HTML tables:

```html
<div>
  <div class="hero">
    <div>
      <div>
        <picture>
          <img src="hero-image.jpg" alt="Hero">
        </picture>
      </div>
      <div>
        <h1>Welcome</h1>
        <p>Description text</p>
        <p><a href="/cta">Call to Action</a></p>
      </div>
    </div>
  </div>
</div>
```

The `aem.js` library:
1. Finds `<div class="hero">` in the DOM
2. Loads `blocks/hero/hero.js` and `blocks/hero/hero.css`
3. Calls the JS default export with the block element

### EDS Block JS Pattern

```javascript
export default async function decorate(block) {
  const rows = [...block.children];
  // Restructure DOM as needed
  // Add classes for CSS targeting
  // block.classList.add('variant-name') for variants
}
```

### EDS Block CSS Pattern

```css
.hero {
  position: relative;
  padding: var(--section-spacing, 60px) 0;
}

.hero h1 {
  font-size: var(--heading-font-size-xxl);
  font-family: var(--heading-font-family);
}

@media (min-width: 900px) {
  .hero > div {
    display: flex;
    gap: 2rem;
  }
}
```

## Phase 4: Assembly

After all scoops complete:

1. **Read all scoop results** — check that block files exist in
   `/shared/{repo-name}/blocks/{blockName}/`

2. **Generate brand CSS** — write `/shared/{repo-name}/styles/brand.css`:
   - Map extracted brand data to CSS custom properties
   - `:root { --heading-font-family: ...; --body-font-family: ...; ... }`

3. **Generate page content** — write to `/shared/{repo-name}/{page-path}/index.html`:
   - EDS-format HTML with sections separated by `<hr>` (section dividers)
   - Blocks as `<div class="block-name">` with table content
   - Default content as standard HTML elements
   - Include metadata block at the end

4. **Commit** — stage all changes and commit to the migration branch:
   ```bash
   cd /shared/{repo-name}
   git add blocks/ styles/ {page-path}/
   git commit -m "migrate: {page-path} from {url}"
   ```

5. **Report** — list all generated files, block count, and preview instructions:
   ```
   Use `browser serve "/shared/{repo-name}/"` to preview the migrated page.
   ```

## Brand CSS Variable Mapping

Map extracted brand data to EDS CSS custom properties:

| Brand Data | CSS Variable |
|-----------|-------------|
| fonts.heading | `--heading-font-family` |
| fonts.body | `--body-font-family` |
| fonts.sizes.xxl | `--heading-font-size-xxl` |
| fonts.sizes.xl | `--heading-font-size-xl` |
| colors.background | `--background-color` |
| colors.text | `--text-color` |
| colors.link | `--link-color` |
| colors.linkHover | `--link-hover-color` |
| spacing.sectionPadding | `--section-spacing` |
| spacing.contentMaxWidth | `--content-max-width` |

## Quality Criteria

A successful migration produces blocks that:
- Visually match the source page (verified via screenshot comparison)
- Use CSS custom properties (not hardcoded values)
- Are responsive (mobile-first with desktop breakpoint at 900px)
- Follow EDS conventions (default export, .block-name class targeting)
- Include only necessary decoration (no over-engineering)
```

**Step 2: Verify frontmatter parses correctly**

The skill loading system in `src/scoops/skills.ts` uses a simple regex to
parse YAML frontmatter. Verify the skill file starts with `---`, has
`name:`, `description:`, optional `allowed-tools:`, and ends with `---`.

**Step 3: Commit**

```bash
git add src/defaults/workspace/skills/migrate-page/
git commit -m "feat(migration): add migrate-page skill with decomposition and block generation methodology"
```

---

## Task 12: Verify Skill Loading + End-to-End Wiring

**Files:**
- Modify: `src/migration/index.ts` (add script exports)
- Test: `src/scoops/skills.test.ts` (verify skill loads)

**Step 1: Update barrel exports**

Edit `src/migration/index.ts` to export scripts:

```typescript
export type {
  VisualNode,
  VisualTreeResult,
  BrandData,
  PageMetadata,
  BlockInventoryEntry,
  ExtractionResult,
} from './types.js';
export { scanBlockInventory } from './block-inventory.js';
export { PAGE_PREP_SCRIPT } from './scripts/page-prep-script.js';
export { VISUAL_TREE_SCRIPT } from './scripts/visual-tree-script.js';
export { BRAND_EXTRACT_SCRIPT } from './scripts/brand-script.js';
export { METADATA_EXTRACT_SCRIPT } from './scripts/metadata-script.js';
```

**Step 2: Verify skill loads via existing test**

Run: `npx vitest run src/scoops/skills.test.ts`
Expected: PASS (existing tests should still pass; the new skill is bundled
via `import.meta.glob` and created by `createDefaultSkills` at runtime)

**Step 3: Verify no typecheck errors**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new migration tests)

**Step 5: Commit**

```bash
git add src/migration/index.ts
git commit -m "feat(migration): finalize module exports and verify skill loading"
```

**Step 6: Run build**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 7: Final commit if build required changes**

```bash
git add -A
git commit -m "fix(migration): address build issues"
```

---

## Implementation Notes

### For the executing agent

1. **Read vibemigration source files before porting.** The extraction scripts
   (Tasks 2-5) require reading the original TypeScript from vibemigration and
   converting to self-contained JavaScript IIFEs. Do not guess the implementation
   — read the source files listed at the top of this plan.

2. **The visual tree script (Task 4) is the most complex.** It inlines three
   separate modules (~450 lines total). Take care with:
   - CSS selector generation (Chrome DevTools algorithm)
   - CIELAB color comparison (sRGB → Lab conversion)
   - Layout detection (bounding box grid analysis)
   - Tree collapsing (single-child optimization)

3. **Test with jsdom.** Tasks 2-5 use `@vitest-environment jsdom` for DOM
   access. jsdom doesn't compute real styles or bounding boxes, so tests
   verify structure/format, not pixel-perfect values. Mock
   `getBoundingClientRect` where needed.

4. **The skill (Task 11) is critical for quality.** It encodes the migration
   methodology. Port the decomposition prompt from vibemigration's `prompt.ts`
   (V4.5) and the block generation patterns from the sandbox skills. The skill
   should be comprehensive enough that the agent can migrate pages without
   additional instructions.

5. **Git clone in tests.** Task 8 tests use local repos (init + commit in
   VFS). Testing against real GitHub repos would be flaky and slow. The git
   integration with real remotes is verified in the existing git-commands tests.
