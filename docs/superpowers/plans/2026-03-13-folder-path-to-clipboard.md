# Copy VFS Path to Clipboard — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users click a row in the file browser and press Cmd/Ctrl+C to copy its VFS path to the clipboard.

**Architecture:** Add `selectedPath` state directly to `FileBrowserPanel`, a `keydown` listener scoped to the container, selection re-application after DOM refresh (applied _after_ the innerHTML comparison to avoid defeating the change-detection optimization), and CSS for the selected/feedback states. Two files touched: `src/ui/file-browser-panel.ts` and `index.html`.

**Tech Stack:** Vanilla TypeScript DOM, `navigator.clipboard.writeText()`, Vitest

**Spec:** `docs/superpowers/specs/2026-03-13-folder-path-to-clipboard-design.md`

---

## Chunk 1: Selection state + CSS

### Task 1: Add selected row and copy-flash CSS

**Files:**

- Modify: `index.html:886` (after existing `.file-browser__item:hover` rule)

- [ ] **Step 1: Add CSS rules for selected state and copy feedback**

Insert after line 886 (`.file-browser__item:hover { ... }`):

```css
.file-browser__item--selected {
  background: var(--s2-bg-elevated);
  box-shadow: inset 2px 0 0 var(--s2-accent);
}
.file-browser__item--selected:hover {
  background: var(--s2-bg-elevated);
}
.file-browser__item--selected.file-browser__item--copy-flash {
  background: color-mix(in srgb, var(--s2-positive) 20%, transparent);
}
```

Note: the copy-flash rule uses `.file-browser__item--selected.file-browser__item--copy-flash` (double class) for specificity instead of `!important`. The transition is inherited from the base `.file-browser__item` rule (`transition: background var(--s2-transition-default)` on line 884).

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: clean (CSS-only change, no TS impact)

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "style: add selected row and copy-flash CSS for file browser"
```

---

## Chunk 2: Selection state + keydown handler + visual feedback

### Task 2: Wire selection and copy into FileBrowserPanel

This task adds all the TypeScript changes in one go: `selectedPath` state, `data-path` attribute on rows, selection on click, keydown listener for Cmd/Ctrl+C, clipboard write, visual flash feedback, selection re-application after `refresh()`, and cleanup in `dispose()`.

**Key design decision — innerHTML comparison:** The `refresh()` method compares `tmp.innerHTML === this.bodyEl.innerHTML` to skip unnecessary DOM swaps. Selection-related attributes (`--selected` class, `tabindex`) would cause this comparison to always differ. Solution: run the innerHTML comparison _first_ (against the clean rendered tree), do the DOM swap if needed, _then_ apply selection decorations unconditionally. This preserves the optimization.

**Files:**

- Modify: `src/ui/file-browser-panel.ts`

- [ ] **Step 1: Add state fields**

Add to the class fields (after `onRunCommand` on line 97):

```ts
private selectedPath: string | null = null;
private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
```

- [ ] **Step 2: Set `data-path` attribute on each row in `renderDir()`**

In the `renderDir` method, after line 157 (`row.style.paddingLeft = ...`), add for ALL rows (both directory and file branches):

```ts
row.dataset.path =
  entry.type === 'directory' && !fullPath.endsWith('/') ? fullPath + '/' : fullPath;
```

- [ ] **Step 3: Add selection on folder row click**

Replace the existing folder click handler (lines 189-196) with:

```ts
row.addEventListener('click', () => {
  this.selectPath(fullPath, 'directory');
  if (this.expandedDirs.has(fullPath)) {
    this.expandedDirs.delete(fullPath);
  } else {
    this.expandedDirs.add(fullPath);
  }
  this.refresh();
});
```

- [ ] **Step 4: Add selection on file row click**

After the file row's CAT button is appended (after line 243 `row.appendChild(catBtn)`), add a click handler on the row:

```ts
row.addEventListener('click', () => {
  this.selectPath(fullPath, 'file');
});
```

- [ ] **Step 5: Add `selectPath()` helper**

Add before the `dispose()` method:

```ts
private selectPath(fullPath: string, type: 'file' | 'directory'): void {
  this.selectedPath = type === 'directory' && !fullPath.endsWith('/')
    ? fullPath + '/'
    : fullPath;
  this.applySelection();
  const row = this.bodyEl.querySelector('.file-browser__item--selected') as HTMLElement | null;
  row?.focus();
}
```

- [ ] **Step 6: Add `applySelection()` method**

```ts
private applySelection(): void {
  const prev = this.bodyEl.querySelector('.file-browser__item--selected');
  if (prev) {
    prev.classList.remove('file-browser__item--selected');
    prev.removeAttribute('tabindex');
  }
  if (!this.selectedPath) return;
  const rows = this.bodyEl.querySelectorAll<HTMLElement>('.file-browser__item');
  for (const row of rows) {
    if (row.dataset.path === this.selectedPath) {
      row.classList.add('file-browser__item--selected');
      row.tabIndex = 0;
      break;
    }
  }
}
```

- [ ] **Step 7: Update `refresh()` to preserve selection after DOM swap**

Replace the `refresh()` method (lines 113-126) with:

```ts
async refresh(): Promise<void> {
  if (!this.fs) return;
  const tmp = document.createElement('div');
  try {
    await this.renderDir('/', tmp, 0);
  } catch (err) {
    console.warn('[FileBrowser] Refresh failed:', err instanceof Error ? err.message : String(err));
    return;
  }
  // Compare BEFORE applying selection (selection attrs would defeat the check)
  if (tmp.innerHTML === this.bodyEl.innerHTML) {
    // Tree unchanged — still need to ensure selection is decorated
    this.applySelection();
    return;
  }
  const hadFocus = this.container.contains(document.activeElement);
  while (this.bodyEl.firstChild) this.bodyEl.removeChild(this.bodyEl.firstChild);
  while (tmp.firstChild) this.bodyEl.appendChild(tmp.firstChild);
  // Re-apply selection to the new DOM
  this.applySelection();
  if (hadFocus && this.selectedPath) {
    const row = this.bodyEl.querySelector('.file-browser__item--selected') as HTMLElement | null;
    row?.focus();
  }
}
```

- [ ] **Step 8: Add `setupKeydown()` and `flashCopyFeedback()` methods**

```ts
private setupKeydown(): void {
  this.keydownHandler = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'c') return;
    if (!this.selectedPath) return;
    const collapsed = window.getSelection()?.isCollapsed !== false;
    if (!collapsed) return;
    e.preventDefault();
    navigator.clipboard.writeText(this.selectedPath).then(() => {
      this.flashCopyFeedback();
    }).catch((err) => {
      console.warn('[FileBrowser] Clipboard write failed:', err instanceof Error ? err.message : String(err));
    });
  };
  this.container.addEventListener('keydown', this.keydownHandler);
}

private flashCopyFeedback(): void {
  const row = this.bodyEl.querySelector('.file-browser__item--selected');
  if (!row) return;
  row.classList.add('file-browser__item--copy-flash');
  setTimeout(() => {
    row.classList.remove('file-browser__item--copy-flash');
  }, 300);
}
```

- [ ] **Step 9: Call `setupKeydown()` in `render()`**

At the end of the `render()` method (after `this.container.appendChild(this.bodyEl)` on line 135), add:

```ts
this.setupKeydown();
```

- [ ] **Step 10: Clean up listener in `dispose()`**

In the `dispose()` method, before the existing DOM cleanup loop, add:

```ts
if (this.keydownHandler) {
  this.container.removeEventListener('keydown', this.keydownHandler);
  this.keydownHandler = null;
}
```

- [ ] **Step 11: Run typecheck and tests**

Run: `npm run typecheck && npm run test`
Expected: clean typecheck, all existing tests pass

- [ ] **Step 12: Commit**

```bash
git add src/ui/file-browser-panel.ts
git commit -m "feat: add row selection and Cmd/Ctrl+C path copy to file browser"
```

---

## Chunk 3: Tests + verification

### Task 3: Add DOM integration tests for listener lifecycle

**Files:**

- Create: `src/ui/file-browser-panel.test.ts`

The test environment is `node` by default (configured in `vite.config.ts`). `FileBrowserPanel` uses DOM APIs, so this test file needs the `jsdom` environment pragma.

- [ ] **Step 1: Write the test file**

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { FileBrowserPanel } from './file-browser-panel.js';

function createContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('FileBrowserPanel', () => {
  it('registers a keydown listener on the container', () => {
    const container = createContainer();
    const spy = vi.spyOn(container, 'addEventListener');
    new FileBrowserPanel(container);
    expect(spy).toHaveBeenCalledWith('keydown', expect.any(Function));
    container.remove();
  });

  it('removes the keydown listener on dispose', () => {
    const container = createContainer();
    const spy = vi.spyOn(container, 'removeEventListener');
    const panel = new FileBrowserPanel(container);
    panel.dispose();
    expect(spy).toHaveBeenCalledWith('keydown', expect.any(Function));
    container.remove();
  });
});
```

- [ ] **Step 2: Run tests — verify they pass**

Run: `npx vitest run src/ui/file-browser-panel.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Commit**

```bash
git add src/ui/file-browser-panel.test.ts
git commit -m "test: add listener lifecycle tests for file browser panel"
```

---

### Task 4: Verification and build gates

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: clean

- [ ] **Step 2: Run full test suite**

Run: `npm run test`
Expected: all tests pass, including new ones

- [ ] **Step 3: Run production build**

Run: `npm run build`
Expected: clean build

- [ ] **Step 4: Run extension build**

Run: `npm run build:extension`
Expected: clean build

- [ ] **Step 5: Final commit if any fixups were needed**

Only if previous verification steps required fixes:

```bash
git add -A
git commit -m "fix: address build/test issues from path copy feature"
```
