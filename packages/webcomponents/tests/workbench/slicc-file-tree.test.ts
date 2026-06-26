import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';
import type { FileTreeItem } from '../../src/workbench/slicc-file-tree.js';
import { SliccFileTree } from '../../src/workbench/slicc-file-tree.js';

/** rgb() form of a `#rrggbb` hex, matching getComputedStyle output. */
const rgb = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

/** The prototype VFS sidebar items. */
const ITEMS: FileTreeItem[] = [
  { kind: 'group', label: 'workspace/' },
  { kind: 'file', id: 'hero.tsx', label: 'hero.tsx', path: 'workspace/hero.tsx' },
  { kind: 'file', id: 'hero.css', label: 'hero.css', path: 'workspace/hero.css' },
  { kind: 'file', id: 'tokens.css', label: 'tokens.css' },
  { kind: 'group', label: 'skills/' },
  { kind: 'file', id: 'sprinkles/', label: 'sprinkles/' },
];

function makeTree(items: FileTreeItem[] = ITEMS): SliccFileTree {
  const el = document.createElement('slicc-file-tree') as SliccFileTree;
  el.items = items;
  return el;
}

function fileRow(el: SliccFileTree, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`.f[data-id="${id}"]`);
}

describe('slicc-file-tree', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-file-tree')).toBe(SliccFileTree);
  });

  describe('structure', () => {
    it('renders group headers and file rows into its light DOM (no shadow root)', () => {
      const el = makeTree();
      document.body.appendChild(el);
      expect(el.shadowRoot).toBeNull();
      const groups = el.querySelectorAll('.grp');
      const files = el.querySelectorAll('.f');
      expect(groups).toHaveLength(2);
      expect(files).toHaveLength(4);
      expect(groups[0].textContent).toBe('workspace/');
      expect(groups[1].textContent).toBe('skills/');
      expect(fileRow(el, 'hero.tsx')?.textContent).toBe('hero.tsx');
    });

    it('renders nothing for an empty item set', () => {
      const el = makeTree([]);
      document.body.appendChild(el);
      expect(el.querySelectorAll('.f')).toHaveLength(0);
      expect(el.querySelectorAll('.grp')).toHaveLength(0);
    });

    it('escapes file and group labels', () => {
      const el = makeTree([
        { kind: 'group', label: '<b>grp</b>' },
        { kind: 'file', id: 'x', label: '<script>x</script>' },
      ]);
      document.body.appendChild(el);
      expect(el.querySelector('script')).toBeNull();
      expect(el.querySelector('.grp')?.querySelector('b')).toBeNull();
      expect(fileRow(el, 'x')?.textContent).toBe('<script>x</script>');
    });

    it('adopts slotted light-DOM children as the initial items', () => {
      const el = document.createElement('slicc-file-tree') as SliccFileTree;
      el.innerHTML =
        '<div data-group>workspace/</div>' +
        '<div data-id="a.ts">a.ts</div>' +
        '<div id="b.ts">b.ts</div>';
      document.body.appendChild(el);
      expect(el.querySelectorAll('.grp')).toHaveLength(1);
      expect(el.querySelectorAll('.f')).toHaveLength(2);
      expect(fileRow(el, 'a.ts')).not.toBeNull();
      expect(fileRow(el, 'b.ts')).not.toBeNull();
    });
  });

  describe('items property', () => {
    it('reflects an assigned array back through the getter (copied, not aliased)', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const out = el.items;
      expect(out).toHaveLength(ITEMS.length);
      out.push({ kind: 'file', id: 'leak', label: 'leak' });
      expect(el.items).toHaveLength(ITEMS.length);
    });

    it('re-renders when items are reassigned', () => {
      const el = makeTree();
      document.body.appendChild(el);
      el.items = [{ kind: 'file', id: 'only.ts', label: 'only.ts' }];
      expect(el.querySelectorAll('.f')).toHaveLength(1);
      expect(fileRow(el, 'only.ts')).not.toBeNull();
    });
  });

  describe('file size display', () => {
    it('renders a .sz span when the file item has a size', () => {
      const el = makeTree([{ kind: 'file', id: 'big.zip', label: 'big.zip', size: 1536 }]);
      document.body.appendChild(el);
      const sz = fileRow(el, 'big.zip')?.querySelector('.sz');
      expect(sz?.textContent).toBe('1.5K');
    });

    it('formats sizes across B / K / M / G boundaries', () => {
      const el = makeTree([
        { kind: 'file', id: 'b', label: 'b', size: 512 },
        { kind: 'file', id: 'k', label: 'k', size: 1024 },
        { kind: 'file', id: 'm', label: 'm', size: 1024 * 1024 },
        { kind: 'file', id: 'g', label: 'g', size: 1024 * 1024 * 1024 },
      ]);
      document.body.appendChild(el);
      expect(fileRow(el, 'b')?.querySelector('.sz')?.textContent).toBe('512 B');
      expect(fileRow(el, 'k')?.querySelector('.sz')?.textContent).toBe('1.0K');
      expect(fileRow(el, 'm')?.querySelector('.sz')?.textContent).toBe('1.0M');
      expect(fileRow(el, 'g')?.querySelector('.sz')?.textContent).toBe('1.0G');
    });

    it('omits .sz when size is not provided', () => {
      const el = makeTree([{ kind: 'file', id: 'no-size.ts', label: 'no-size.ts' }]);
      document.body.appendChild(el);
      expect(fileRow(el, 'no-size.ts')?.querySelector('.sz')).toBeNull();
    });
  });

  describe('open-dir preservation across refresh', () => {
    it('preserves user-expanded dirs when items is re-assigned', () => {
      const el = makeTree([
        {
          kind: 'dir',
          id: 'src',
          label: 'src',
          children: [{ kind: 'file', id: 'a.ts', label: 'a.ts' }],
        },
      ]);
      document.body.appendChild(el);
      el.toggleDir('src');
      expect(el.isDirOpen('src')).toBe(true);
      el.items = [
        {
          kind: 'dir',
          id: 'src',
          label: 'src',
          children: [
            { kind: 'file', id: 'a.ts', label: 'a.ts' },
            { kind: 'file', id: 'b.ts', label: 'b.ts' },
          ],
        },
      ];
      expect(el.isDirOpen('src')).toBe(true);
    });

    it('seeds open dirs from item.open on the first assignment', () => {
      const el = document.createElement('slicc-file-tree') as SliccFileTree;
      el.items = [
        {
          kind: 'dir',
          id: 'lib',
          label: 'lib',
          open: true,
          children: [],
        },
      ];
      document.body.appendChild(el);
      expect(el.isDirOpen('lib')).toBe(true);
    });

    it('user-collapsed dir (open:true in items) stays collapsed after refresh', () => {
      // Regression for: 3s refresh re-opens dirs the user manually collapsed.
      // buildVfsTreeItems always emits root dirs with open:true, so the
      // old union logic would re-add a collapsed root on every refresh.
      const el = document.createElement('slicc-file-tree') as SliccFileTree;
      el.items = [{ kind: 'dir', id: 'workspace', label: 'workspace', open: true, children: [] }];
      document.body.appendChild(el);
      expect(el.isDirOpen('workspace')).toBe(true);
      // User collapses the dir
      el.toggleDir('workspace');
      expect(el.isDirOpen('workspace')).toBe(false);
      // Simulate a refresh: re-assign items, still carrying open:true
      el.items = [{ kind: 'dir', id: 'workspace', label: 'workspace', open: true, children: [] }];
      // Must stay collapsed — the refresh must not undo the user's toggle
      expect(el.isDirOpen('workspace')).toBe(false);
    });
  });

  describe('selected attribute ↔ property reflection', () => {
    it('reflects the selected property to the attribute and back', () => {
      const el = makeTree();
      document.body.appendChild(el);
      expect(el.selected).toBeNull();
      el.selected = 'hero.css';
      expect(el.getAttribute('selected')).toBe('hero.css');
      el.setAttribute('selected', 'hero.tsx');
      expect(el.selected).toBe('hero.tsx');
      el.selected = null;
      expect(el.hasAttribute('selected')).toBe(false);
    });

    it('applies `.on` to the row named by the selected attribute', () => {
      const el = makeTree();
      el.selected = 'hero.css';
      document.body.appendChild(el);
      expect(fileRow(el, 'hero.css')?.classList.contains('on')).toBe(true);
      el.selected = 'hero.tsx';
      expect(fileRow(el, 'hero.css')?.classList.contains('on')).toBe(false);
      expect(fileRow(el, 'hero.tsx')?.classList.contains('on')).toBe(true);
    });
  });

  describe('single-selection behavior + file-select event', () => {
    it('selectFile tints exactly one row and emits file-select with id + path', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onSelect = vi.fn();
      el.addEventListener('file-select', onSelect);

      el.selectFile('hero.css');
      expect(el.querySelectorAll('.f.on')).toHaveLength(1);
      expect(fileRow(el, 'hero.css')?.classList.contains('on')).toBe(true);
      expect(el.selected).toBe('hero.css');
      expect(onSelect).toHaveBeenCalledTimes(1);
      const detail = onSelect.mock.calls[0][0].detail;
      expect(detail).toEqual({ id: 'hero.css', path: 'workspace/hero.css' });
    });

    it('falls back to the label as the path when no explicit path is given', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onSelect = vi.fn();
      el.addEventListener('file-select', onSelect);
      el.selectFile('tokens.css');
      expect(onSelect.mock.calls[0][0].detail).toEqual({
        id: 'tokens.css',
        path: 'tokens.css',
      });
    });

    it('moves the selection (only one active row at a time)', () => {
      const el = makeTree();
      document.body.appendChild(el);
      el.selectFile('hero.tsx');
      el.selectFile('sprinkles/');
      expect(fileRow(el, 'hero.tsx')?.classList.contains('on')).toBe(false);
      expect(fileRow(el, 'sprinkles/')?.classList.contains('on')).toBe(true);
      expect(el.querySelectorAll('.f.on')).toHaveLength(1);
    });

    it('emits the event composed + bubbling so it crosses boundaries', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onBody = vi.fn();
      document.body.addEventListener('file-select', onBody);
      el.selectFile('hero.css');
      expect(onBody).toHaveBeenCalledTimes(1);
      const ev = onBody.mock.calls[0][0] as CustomEvent;
      expect(ev.bubbles).toBe(true);
      expect(ev.composed).toBe(true);
      document.body.removeEventListener('file-select', onBody);
    });

    it('is a no-op (no event) for an unknown id', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onSelect = vi.fn();
      el.addEventListener('file-select', onSelect);
      el.selectFile('does-not-exist');
      expect(onSelect).not.toHaveBeenCalled();
      expect(el.querySelectorAll('.f.on')).toHaveLength(0);
    });

    it('selects on a row click', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onSelect = vi.fn();
      el.addEventListener('file-select', onSelect);
      // Click on the row's text node target — the handler resolves the closest .f.
      fileRow(el, 'nav.tsx');
      const row = fileRow(el, 'hero.tsx');
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(fileRow(el, 'hero.tsx')?.classList.contains('on')).toBe(true);
    });

    it('stops handling clicks after disconnect', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onSelect = vi.fn();
      el.addEventListener('file-select', onSelect);
      el.remove();
      fileRow(el, 'hero.tsx')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('nested directories (fold/expand)', () => {
    const NESTED: FileTreeItem[] = [
      { kind: 'group', label: 'workspace/' },
      {
        kind: 'dir',
        id: 'components',
        label: 'components',
        open: true,
        children: [
          {
            kind: 'file',
            id: 'hero.tsx',
            label: 'hero.tsx',
            path: 'workspace/components/hero.tsx',
          },
          {
            kind: 'dir',
            id: 'ui',
            label: 'ui',
            children: [
              {
                kind: 'file',
                id: 'button.tsx',
                label: 'button.tsx',
                path: 'workspace/components/ui/button.tsx',
              },
            ],
          },
        ],
      },
      { kind: 'file', id: 'tokens.css', label: 'tokens.css' },
    ];

    function makeNested(): SliccFileTree {
      const el = document.createElement('slicc-file-tree') as SliccFileTree;
      el.items = NESTED;
      document.body.appendChild(el);
      return el;
    }

    /** The `.children` wrapper that immediately follows the named `.dir` row. */
    function childrenOf(el: SliccFileTree, dirId: string): HTMLElement | null {
      const dir = el.querySelector<HTMLElement>(`.dir[data-dir-id="${dirId}"]`);
      const next = dir?.nextElementSibling;
      return next instanceof HTMLElement && next.classList.contains('children') ? next : null;
    }

    it('renders a `.dir` toggle row with a chevron <svg> for each directory', () => {
      const el = makeNested();
      const dir = el.querySelector<HTMLElement>('.dir[data-dir-id="components"]');
      expect(dir).not.toBeNull();
      expect(dir?.querySelector('svg.chev')).not.toBeNull();
      expect(dir?.textContent).toContain('components');
    });

    it('seeds the open state from the item `open` flag (open shows, default hides)', () => {
      const el = makeNested();
      expect(el.isDirOpen('components')).toBe(true);
      expect(el.isDirOpen('ui')).toBe(false);
      // open dir → children wrapper visible; closed dir → hidden.
      expect(childrenOf(el, 'components')?.hasAttribute('hidden')).toBe(false);
      expect(childrenOf(el, 'ui')?.hasAttribute('hidden')).toBe(true);
    });

    it('toggling a directory shows/hides its children and flips aria-expanded', () => {
      const el = makeNested();
      el.toggleDir('components');
      expect(el.isDirOpen('components')).toBe(false);
      expect(childrenOf(el, 'components')?.hasAttribute('hidden')).toBe(true);
      expect(
        el.querySelector('.dir[data-dir-id="components"]')?.getAttribute('aria-expanded')
      ).toBe('false');
      el.toggleDir('components');
      expect(el.isDirOpen('components')).toBe(true);
      expect(childrenOf(el, 'components')?.hasAttribute('hidden')).toBe(false);
      expect(
        el.querySelector('.dir[data-dir-id="components"]')?.getAttribute('aria-expanded')
      ).toBe('true');
    });

    it('toggles on a directory row click and emits dir-toggle { id, open }', () => {
      const el = makeNested();
      const onToggle = vi.fn();
      el.addEventListener('dir-toggle', onToggle);
      el.querySelector<HTMLElement>('.dir[data-dir-id="ui"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      expect(el.isDirOpen('ui')).toBe(true);
      expect(childrenOf(el, 'ui')?.hasAttribute('hidden')).toBe(false);
      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onToggle.mock.calls[0][0].detail).toEqual({ id: 'ui', open: true });
    });

    it('emits dir-toggle composed + bubbling and is a no-op for an unknown id', () => {
      const el = makeNested();
      const onBody = vi.fn();
      document.body.addEventListener('dir-toggle', onBody);
      el.toggleDir('components');
      expect(onBody).toHaveBeenCalledTimes(1);
      const ev = onBody.mock.calls[0][0] as CustomEvent;
      expect(ev.bubbles).toBe(true);
      expect(ev.composed).toBe(true);
      document.body.removeEventListener('dir-toggle', onBody);

      const onToggle = vi.fn();
      el.addEventListener('dir-toggle', onToggle);
      el.toggleDir('does-not-exist');
      expect(onToggle).not.toHaveBeenCalled();
    });

    it('indents nested children (the `.children` wrapper carries left padding)', () => {
      const el = makeNested();
      const wrap = childrenOf(el, 'components') as HTMLElement;
      expect(Number.parseFloat(getComputedStyle(wrap).paddingLeft)).toBeGreaterThan(0);
      // A doubly-nested file sits further right than a singly-nested one.
      el.toggleDir('ui');
      const shallow = fileRow(el, 'hero.tsx') as HTMLElement;
      const deep = fileRow(el, 'button.tsx') as HTMLElement;
      expect(deep.getBoundingClientRect().left).toBeGreaterThan(
        shallow.getBoundingClientRect().left
      );
    });

    it('selects a nested file (selection still works) with its full path', () => {
      const el = makeNested();
      const onSelect = vi.fn();
      el.addEventListener('file-select', onSelect);
      el.selectFile('hero.tsx');
      expect(fileRow(el, 'hero.tsx')?.classList.contains('on')).toBe(true);
      expect(el.querySelectorAll('.f.on')).toHaveLength(1);
      expect(onSelect.mock.calls[0][0].detail).toEqual({
        id: 'hero.tsx',
        path: 'workspace/components/hero.tsx',
      });
    });

    it('selects a nested file on a row click without toggling its ancestor dirs', () => {
      const el = makeNested();
      el.toggleDir('ui'); // open it so the row is visible
      const onSelect = vi.fn();
      el.addEventListener('file-select', onSelect);
      fileRow(el, 'button.tsx')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(fileRow(el, 'button.tsx')?.classList.contains('on')).toBe(true);
      // The surrounding directories stay as they were.
      expect(el.isDirOpen('ui')).toBe(true);
      expect(el.isDirOpen('components')).toBe(true);
    });
  });

  describe('appearance (getComputedStyle, real Chromium)', () => {
    it('is a fixed 190px, non-shrinking column with a right divider', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      expect(cs.width).toBe('190px');
      expect(cs.flexGrow).toBe('0');
      expect(cs.flexShrink).toBe('0');
      expect(cs.overflowX).toBe('auto');
      expect(cs.borderRightWidth).toBe('1px');
      // light --line === #e5e5e5
      expect(cs.borderRightColor).toBe(rgb('#e5e5e5'));
    });

    it('paints group headers in --txt-3 and idle files in --ink', () => {
      const el = makeTree();
      document.body.appendChild(el);
      // light --txt-3 === #a1a1a1, --ink === #0a0a0a
      expect(getComputedStyle(el.querySelector('.grp') as HTMLElement).color).toBe(rgb('#a1a1a1'));
      expect(getComputedStyle(fileRow(el, 'hero.tsx') as HTMLElement).color).toBe(rgb('#0a0a0a'));
    });

    it('tints the active row violet (text + icon) in light mode', () => {
      const el = makeTree();
      el.selected = 'hero.css';
      document.body.appendChild(el);
      const row = fileRow(el, 'hero.css') as HTMLElement;
      // light --violet === #8b5cf6
      expect(getComputedStyle(row).color).toBe(rgb('#8b5cf6'));
      // icon inherits the violet tint via .f.on .ficon rule
      const icon = row.querySelector<HTMLElement>('.ficon');
      expect(icon).not.toBeNull();
      expect(getComputedStyle(icon as HTMLElement).color).toBe(rgb('#8b5cf6'));
      // active background is a violet/canvas mix, distinct from the idle row.
      const idle = getComputedStyle(fileRow(el, 'hero.tsx') as HTMLElement).backgroundColor;
      expect(getComputedStyle(row).backgroundColor).not.toBe(idle);
    });

    it('renders a file icon on every file row', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const icon = fileRow(el, 'hero.tsx')?.querySelector('.ficon');
      expect(icon).not.toBeNull();
      expect(icon?.tagName.toLowerCase()).toBe('svg');
    });

    it('re-bases the active tint over --canvas in dark mode', () => {
      const wrap = document.createElement('div');
      wrap.className = 'dark';
      const light = makeTree();
      light.selected = 'hero.css';
      const dark = makeTree();
      dark.selected = 'hero.css';
      document.body.appendChild(light);
      wrap.appendChild(dark);
      document.body.appendChild(wrap);

      const lightBg = getComputedStyle(fileRow(light, 'hero.css') as HTMLElement).backgroundColor;
      const darkBg = getComputedStyle(fileRow(dark, 'hero.css') as HTMLElement).backgroundColor;
      // 22% over dark --canvas (#161618) differs from 10% over light --canvas (#fff).
      expect(darkBg).not.toBe(lightBg);
      // violet text survives the theme flip.
      expect(getComputedStyle(fileRow(dark, 'hero.css') as HTMLElement).color).toBe(rgb('#8b5cf6'));
    });
  });

  describe('hover action strip', () => {
    it('renders action buttons inside each .f row', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const row = fileRow(el, 'hero.tsx') as HTMLElement;
      const strip = row.querySelector('.actions') as HTMLElement;
      expect(strip).not.toBeNull();
      expect(strip.querySelectorAll('button')).toHaveLength(4);
    });

    it('does NOT render action buttons on directory rows', () => {
      const items: FileTreeItem[] = [
        {
          kind: 'dir',
          id: 'src',
          label: 'src',
          children: [{ kind: 'file', id: 'a.ts', label: 'a.ts' }],
        },
      ];
      const el = makeTree(items);
      document.body.appendChild(el);
      const dir = el.querySelector('.dir') as HTMLElement;
      expect(dir.querySelector('.actions')).toBeNull();
    });

    it('clicking the preview button emits file-preview with id + path', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onPreview = vi.fn();
      el.addEventListener('file-preview', onPreview);
      const row = fileRow(el, 'hero.tsx') as HTMLElement;
      const previewBtn = row.querySelector('[data-action="preview"]') as HTMLElement;
      previewBtn.click();
      expect(onPreview).toHaveBeenCalledTimes(1);
      expect(onPreview.mock.calls[0][0].detail).toEqual({
        id: 'hero.tsx',
        path: 'workspace/hero.tsx',
      });
    });

    it('clicking the reference button emits file-reference with id + path', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onRef = vi.fn();
      el.addEventListener('file-reference', onRef);
      const row = fileRow(el, 'hero.tsx') as HTMLElement;
      const refBtn = row.querySelector('[data-action="reference"]') as HTMLElement;
      refBtn.click();
      expect(onRef).toHaveBeenCalledTimes(1);
      expect(onRef.mock.calls[0][0].detail).toEqual({ id: 'hero.tsx', path: 'workspace/hero.tsx' });
    });

    it('clicking the download button emits file-download with id + path', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onDl = vi.fn();
      el.addEventListener('file-download', onDl);
      const row = fileRow(el, 'hero.tsx') as HTMLElement;
      const dlBtn = row.querySelector('[data-action="download"]') as HTMLElement;
      dlBtn.click();
      expect(onDl).toHaveBeenCalledTimes(1);
      expect(onDl.mock.calls[0][0].detail).toEqual({ id: 'hero.tsx', path: 'workspace/hero.tsx' });
    });

    it('clicking the overflow button emits file-overflow with id + path + anchor', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onOverflow = vi.fn();
      el.addEventListener('file-overflow', onOverflow);
      const row = fileRow(el, 'hero.tsx') as HTMLElement;
      const overflowBtn = row.querySelector('[data-action="overflow"]') as HTMLElement;
      overflowBtn.click();
      expect(onOverflow).toHaveBeenCalledTimes(1);
      const detail = onOverflow.mock.calls[0][0].detail;
      expect(detail.id).toBe('hero.tsx');
      expect(detail.path).toBe('workspace/hero.tsx');
      expect(detail.anchor).toBe(overflowBtn);
    });

    it('action button clicks do NOT trigger file-select', () => {
      const el = makeTree();
      document.body.appendChild(el);
      const onSelect = vi.fn();
      el.addEventListener('file-select', onSelect);
      const row = fileRow(el, 'hero.tsx') as HTMLElement;
      const previewBtn = row.querySelector('[data-action="preview"]') as HTMLElement;
      previewBtn.click();
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
