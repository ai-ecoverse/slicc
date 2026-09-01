/**
 * Tests for `<slicc-file-tree>` after the move to `@pierre/trees`.
 *
 * These assert the component's CONTRACT — the `FileTreeItem` input shape, the
 * `items`/`selected`/`gitStatus` accessors, and the `file-*` / `dir-toggle`
 * events — rather than the markup. The previous suite tested the hand-rolled
 * light-DOM structure (`.f` rows, `.sz` spans, computed row tints); that markup
 * now belongs to the library and asserting on it would just be testing someone
 * else's renderer.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';
import { type FileTreeItem, SliccFileTree } from '../../src/workbench/slicc-file-tree.js';

/** The library renders asynchronously; give it a frame or two to settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

async function mount(items: FileTreeItem[]): Promise<SliccFileTree> {
  const tree = document.createElement('slicc-file-tree') as SliccFileTree;
  tree.style.cssText = 'display:block;width:320px;height:420px;';
  document.body.appendChild(tree);
  tree.items = items;
  await settle();
  return tree;
}

const SAMPLE: FileTreeItem[] = [
  {
    kind: 'dir',
    id: '/workspace',
    label: 'workspace',
    open: true,
    children: [
      {
        kind: 'file',
        id: '/workspace/bb.jsh',
        label: 'bb.jsh',
        path: '/workspace/bb.jsh',
        size: 2048,
      },
      {
        kind: 'dir',
        id: '/workspace/src',
        label: 'src',
        children: [
          {
            kind: 'file',
            id: '/workspace/src/main.ts',
            label: 'main.ts',
            path: '/workspace/src/main.ts',
          },
        ],
      },
    ],
  },
];

/**
 * The names of the rows the library painted.
 *
 * Each row is a `<button aria-label="<name>">` inside the container's shadow
 * root. Reading the accessible name (rather than raw `textContent`, which also
 * carries ~40 KB of injected stylesheet) keeps these assertions about what a
 * user can actually see and reach.
 */
function rowLabels(tree: SliccFileTree): string[] {
  const root = tree.querySelector('file-tree-container')?.shadowRoot;
  if (!root) return [];
  // The accessible name is the primary source, but a row whose whole path
  // collapsed into the flattened root carries an empty one — so the visible
  // text is included too. Reading the rows (rather than the shadow root at
  // large) keeps ~40 KB of injected stylesheet out of the assertion.
  return [...root.querySelectorAll('button')].map(
    (row) => `${row.getAttribute('aria-label') ?? ''} ${row.textContent ?? ''}`
  );
}

/** All row names joined, for `toContain`-style assertions. */
function renderedText(tree: SliccFileTree): string {
  return rowLabels(tree).join('\n');
}

describe('slicc-file-tree', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-file-tree')).toBe(SliccFileTree);
  });

  describe('items', () => {
    it('renders the supplied files', async () => {
      const tree = await mount(SAMPLE);
      expect(renderedText(tree)).toContain('bb.jsh');
    });

    it('reflects an assigned array back through the getter, copied not aliased', async () => {
      const tree = await mount(SAMPLE);
      const read = tree.items;
      expect(read).toEqual(SAMPLE);
      read.push({ kind: 'file', id: '/x', label: 'x' });
      expect(tree.items).toHaveLength(SAMPLE.length);
    });

    it('re-renders when items are reassigned', async () => {
      const tree = await mount(SAMPLE);
      tree.items = [{ kind: 'file', id: '/only.txt', label: 'only.txt' }];
      await settle();
      const text = renderedText(tree);
      expect(text).toContain('only.txt');
      expect(text).not.toContain('bb.jsh');
    });

    it('renders nothing for an empty item set', async () => {
      const tree = await mount([]);
      expect(tree.querySelector('file-tree-container')).toBeNull();
    });

    it('tolerates a non-array assignment', async () => {
      const tree = await mount(SAMPLE);
      (tree as unknown as { items: unknown }).items = null;
      await settle();
      expect(tree.items).toEqual([]);
    });

    it('hoists group rows away rather than rendering them as paths', async () => {
      // A `group` is a visual header with no path; the library builds hierarchy
      // from paths alone, so groups flatten out and their children survive.
      const tree = await mount([
        { kind: 'group', label: 'Recent' },
        { kind: 'file', id: '/a.ts', label: 'a.ts' },
      ]);
      const text = renderedText(tree);
      expect(text).toContain('a.ts');
      expect(text).not.toContain('Recent');
    });

    it('keeps an empty directory visible', async () => {
      const tree = await mount([{ kind: 'dir', id: '/empty', label: 'empty', children: [] }]);
      expect(renderedText(tree)).toContain('empty');
    });

    it('shows a file size as a row decoration', async () => {
      const tree = await mount(SAMPLE);
      // 2048 bytes renders in the compact form the old `.sz` span used.
      expect(renderedText(tree)).toContain('2K');
    });
  });

  describe('selection', () => {
    it('selectFile emits file-select with id and path', async () => {
      const tree = await mount(SAMPLE);
      const seen: Array<{ id: string; path: string }> = [];
      tree.addEventListener('file-select', (e) => {
        seen.push((e as CustomEvent<{ id: string; path: string }>).detail);
      });

      tree.selectFile('/workspace/bb.jsh');
      expect(seen).toEqual([{ id: '/workspace/bb.jsh', path: '/workspace/bb.jsh' }]);
    });

    it('falls back to the label as the path when none is given', async () => {
      const tree = await mount([{ kind: 'file', id: '/a.ts', label: 'a.ts' }]);
      const seen: Array<{ path: string }> = [];
      tree.addEventListener('file-select', (e) => {
        seen.push((e as CustomEvent<{ path: string }>).detail);
      });

      tree.selectFile('/a.ts');
      expect(seen[0]?.path).toBe('a.ts');
    });

    /**
     * The rows on screen, in order — what anything addressing a row by number
     * has to ask, and what `items` cannot answer: it is nested, and says
     * nothing about which directories are open.
     */
    it('visibleIds lists the painted rows, top to bottom', async () => {
      const tree = await mount(SAMPLE);
      // Rendered order, which is directories first — and `/workspace/src` is
      // collapsed, so its child is not on screen and not in the list. The
      // folders are here at all only because the library prints their rows
      // with a trailing slash that the lookup has to strip.
      expect(tree.visibleIds()).toEqual(['/workspace', '/workspace/src', '/workspace/bb.jsh']);
    });

    it('visibleIds grows when a directory is expanded', async () => {
      const tree = await mount(SAMPLE);
      tree.toggleDir('/workspace/src');
      await settle();
      expect(tree.visibleIds()).toContain('/workspace/src/main.ts');
    });

    it('visibleIds is empty before anything has been painted', () => {
      const tree = document.createElement('slicc-file-tree') as SliccFileTree;
      expect(tree.visibleIds()).toEqual([]);
    });

    it('is a no-op with no event for an unknown id', async () => {
      const tree = await mount(SAMPLE);
      let fired = 0;
      tree.addEventListener('file-select', () => {
        fired += 1;
      });

      tree.selectFile('/nope.ts');
      expect(fired).toBe(0);
    });

    it('reflects the selected property to the attribute and back', async () => {
      const tree = await mount(SAMPLE);
      tree.selected = '/workspace/bb.jsh';
      expect(tree.getAttribute('selected')).toBe('/workspace/bb.jsh');

      tree.selected = null;
      expect(tree.hasAttribute('selected')).toBe(false);
      expect(tree.selected).toBeNull();
    });

    it('records the selection made through selectFile', async () => {
      const tree = await mount(SAMPLE);
      tree.selectFile('/workspace/bb.jsh');
      expect(tree.selected).toBe('/workspace/bb.jsh');
    });

    it('emits file-select composed and bubbling so it crosses shadow boundaries', async () => {
      const tree = await mount(SAMPLE);
      const events: Event[] = [];
      document.body.addEventListener('file-select', (e) => events.push(e));

      tree.selectFile('/workspace/bb.jsh');
      expect(events[0]?.composed).toBe(true);
      expect(events[0]?.bubbles).toBe(true);
    });
  });

  describe('directories', () => {
    it('reports a directory seeded open by its item flag', async () => {
      const tree = await mount(SAMPLE);
      expect(tree.isDirOpen('/workspace')).toBe(true);
    });

    it('toggleDir flips the state and emits dir-toggle', async () => {
      const tree = await mount(SAMPLE);
      const seen: Array<{ id: string; open: boolean }> = [];
      tree.addEventListener('dir-toggle', (e) => {
        seen.push((e as CustomEvent<{ id: string; open: boolean }>).detail);
      });

      tree.toggleDir('/workspace');
      expect(seen[0]).toEqual({ id: '/workspace', open: false });
      expect(tree.isDirOpen('/workspace')).toBe(false);

      tree.toggleDir('/workspace');
      expect(seen[1]?.open).toBe(true);
    });

    it('toggleDir is a no-op for an unknown id and for a file', async () => {
      const tree = await mount(SAMPLE);
      let fired = 0;
      tree.addEventListener('dir-toggle', () => {
        fired += 1;
      });

      tree.toggleDir('/nope');
      tree.toggleDir('/workspace/bb.jsh');
      expect(fired).toBe(0);
    });

    it('isDirOpen is false for a file and for an unknown id', async () => {
      const tree = await mount(SAMPLE);
      expect(tree.isDirOpen('/workspace/bb.jsh')).toBe(false);
      expect(tree.isDirOpen('/nope')).toBe(false);
    });
  });

  describe('preview', () => {
    it('previewFile emits file-preview with id and path', async () => {
      const tree = await mount(SAMPLE);
      const seen: Array<{ id: string; path: string }> = [];
      tree.addEventListener('file-preview', (e) => {
        seen.push((e as CustomEvent<{ id: string; path: string }>).detail);
      });

      tree.previewFile('/workspace/bb.jsh');
      expect(seen).toEqual([{ id: '/workspace/bb.jsh', path: '/workspace/bb.jsh' }]);
    });

    it('does not preview a directory or an unknown id', async () => {
      const tree = await mount(SAMPLE);
      let fired = 0;
      tree.addEventListener('file-preview', () => {
        fired += 1;
      });

      tree.previewFile('/workspace');
      tree.previewFile('/nope.ts');
      expect(fired).toBe(0);
    });
  });

  describe('git status', () => {
    it('accepts and reflects a git status list', async () => {
      const tree = await mount(SAMPLE);
      tree.gitStatus = [{ path: '/workspace/bb.jsh', status: 'modified' }];
      await settle();
      expect(tree.gitStatus).toEqual([{ path: '/workspace/bb.jsh', status: 'modified' }]);
    });

    it('copies the assigned list rather than aliasing it', async () => {
      const tree = await mount(SAMPLE);
      const input: Array<{ path: string; status: 'modified' }> = [
        { path: '/workspace/bb.jsh', status: 'modified' },
      ];
      tree.gitStatus = input;
      input.push({ path: '/other', status: 'modified' });
      expect(tree.gitStatus).toHaveLength(1);
    });

    it('still renders when a status names a path that is not in the tree', async () => {
      const tree = await mount(SAMPLE);
      tree.gitStatus = [{ path: '/gone.ts', status: 'deleted' }];
      await settle();
      expect(renderedText(tree)).toContain('bb.jsh');
    });
  });

  describe('row interaction', () => {
    /** The rendered row whose accessible name is `name`. */
    function row(tree: SliccFileTree, name: string): HTMLElement | null {
      const root = tree.querySelector('file-tree-container')?.shadowRoot;
      return (
        [...(root?.querySelectorAll('button') ?? [])].find(
          (b) => b.getAttribute('aria-label') === name
        ) ?? null
      );
    }

    it('opens the previewer on a double-click', async () => {
      const tree = await mount(SAMPLE);
      const seen: string[] = [];
      tree.addEventListener('file-preview', (e) => {
        seen.push((e as CustomEvent<{ path: string }>).detail.path);
      });

      const target = row(tree, 'bb.jsh');
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      await settle();
      target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
      await settle();

      expect(seen).toEqual(['/workspace/bb.jsh']);
    });

    it('opens the previewer on Enter', async () => {
      const tree = await mount(SAMPLE);
      const seen: string[] = [];
      tree.addEventListener('file-preview', (e) => {
        seen.push((e as CustomEvent<{ path: string }>).detail.path);
      });

      const target = row(tree, 'bb.jsh');
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      await settle();
      target?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true })
      );
      await settle();

      expect(seen).toEqual(['/workspace/bb.jsh']);
    });

    it('ignores other keys', async () => {
      const tree = await mount(SAMPLE);
      let fired = 0;
      tree.addEventListener('file-preview', () => {
        fired += 1;
      });

      const target = row(tree, 'bb.jsh');
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      await settle();
      target?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true })
      );
      await settle();

      expect(fired).toBe(0);
    });

    it('emits file-overflow with an anchor when the context menu opens', async () => {
      const tree = await mount(SAMPLE);
      const seen: Array<{ id: string; path: string; anchor: HTMLElement; kind: string }> = [];
      tree.addEventListener('file-overflow', (e) => {
        seen.push(
          (e as CustomEvent<{ id: string; path: string; anchor: HTMLElement; kind: string }>).detail
        );
      });

      row(tree, 'bb.jsh')?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, composed: true })
      );
      await settle();

      expect(seen[0]?.id).toBe('/workspace/bb.jsh');
      expect(seen[0]?.path).toBe('/workspace/bb.jsh');
      expect(seen[0]?.kind).toBe('file');
      expect(seen[0]?.anchor).toBeInstanceOf(HTMLElement);
    });

    it('reports a directory context menu as a directory', async () => {
      const tree = await mount(SAMPLE);
      const seen: Array<{ kind: string }> = [];
      tree.addEventListener('file-overflow', (e) => {
        seen.push((e as CustomEvent<{ kind: string }>).detail);
      });

      row(tree, 'src')?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, composed: true })
      );
      await settle();

      expect(seen[0]?.kind).toBe('directory');
    });

    it('emits file-select once when a row is clicked, not twice', async () => {
      // The attribute reflection round-trips through the library's selection
      // callback; only the originating action may emit.
      const tree = await mount(SAMPLE);
      const seen: string[] = [];
      tree.addEventListener('file-select', (e) => {
        seen.push((e as CustomEvent<{ path: string }>).detail.path);
      });

      row(tree, 'bb.jsh')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, composed: true })
      );
      await settle();

      expect(seen).toEqual(['/workspace/bb.jsh']);
    });

    it('keeps a user-collapsed directory collapsed across a refresh', async () => {
      const tree = await mount(SAMPLE);
      tree.toggleDir('/workspace');
      await settle();
      expect(tree.isDirOpen('/workspace')).toBe(false);

      // A background poll re-assigns the same items; the seed `open: true` must
      // not re-open what the user just closed.
      tree.items = SAMPLE;
      await settle();
      expect(tree.isDirOpen('/workspace')).toBe(false);
    });
  });

  /**
   * #2408: a refresh used to unmount the tree and build a new one, which threw
   * away the scroll offset along with the scroller. Now that the workbench
   * refreshes on VFS change events rather than a 3 s timer (#2409), the
   * refreshes that remain are the ones a user is actively watching — landing
   * them back at the top of the tree is exactly when it is most disruptive.
   */
  describe('refresh preserves the view', () => {
    /** Enough rows to overflow the fixed-height mount and make scrolling real. */
    function tallTree(extra = 0): FileTreeItem[] {
      return [
        {
          kind: 'dir',
          id: '/workspace',
          label: 'workspace',
          open: true,
          children: Array.from({ length: 120 + extra }, (_, i) => ({
            kind: 'file' as const,
            id: `/workspace/f${String(i).padStart(3, '0')}.txt`,
            label: `f${String(i).padStart(3, '0')}.txt`,
            path: `/workspace/f${String(i).padStart(3, '0')}.txt`,
          })),
        },
      ];
    }

    /** The library's scrolling element, whatever it decided to call it. */
    function scroller(tree: SliccFileTree): HTMLElement | null {
      const root = tree.querySelector('file-tree-container')?.shadowRoot;
      const candidates = [...(root?.querySelectorAll('*') ?? [])] as HTMLElement[];
      return candidates.find((el) => el.scrollHeight > el.clientHeight + 1) ?? null;
    }

    it('keeps the scroll position across a refresh', async () => {
      const tree = await mount(tallTree());
      const el = scroller(tree);
      expect(el).not.toBeNull();
      if (!el) return;

      el.scrollTop = 600;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      await settle();
      const before = el.scrollTop;
      expect(before).toBeGreaterThan(0);

      // A change lands: one more file, everything else identical.
      tree.items = tallTree(1);
      await settle();

      // The SAME scroller is still there — an in-place update, not a rebuild.
      expect(scroller(tree)).toBe(el);
      expect(el.scrollTop).toBe(before);
    });

    it('keeps a user-expanded directory expanded across a refresh', async () => {
      const items: FileTreeItem[] = [
        {
          kind: 'dir',
          id: '/workspace',
          label: 'workspace',
          open: true,
          children: [
            {
              kind: 'dir',
              id: '/workspace/deep',
              label: 'deep',
              children: [
                {
                  kind: 'file',
                  id: '/workspace/deep/a.txt',
                  label: 'a.txt',
                  path: '/workspace/deep/a.txt',
                },
              ],
            },
          ],
        },
      ];
      const tree = await mount(items);
      tree.toggleDir('/workspace/deep');
      await settle();
      expect(tree.isDirOpen('/workspace/deep')).toBe(true);

      tree.items = items;
      await settle();
      // The seed says collapsed; the user says otherwise, and the user wins.
      expect(tree.isDirOpen('/workspace/deep')).toBe(true);
      expect(renderedText(tree)).toContain('a.txt');
    });

    it('does not stack row listeners across refreshes', async () => {
      const tree = await mount(SAMPLE);
      // The in-place update keeps the library's container, so re-wiring it per
      // refresh would open the previewer once per refresh that had happened.
      for (let i = 0; i < 3; i++) {
        tree.items = SAMPLE;
        await settle();
      }
      const seen: string[] = [];
      tree.addEventListener('file-preview', (e) => {
        seen.push((e as CustomEvent<{ path: string }>).detail.path);
      });

      const root = tree.querySelector('file-tree-container')?.shadowRoot;
      const target = [...(root?.querySelectorAll('button') ?? [])].find(
        (b) => b.getAttribute('aria-label') === 'bb.jsh'
      );
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      await settle();
      target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
      await settle();

      expect(seen).toEqual(['/workspace/bb.jsh']);
    });

    it('still tears down when a refresh empties the tree', async () => {
      const tree = await mount(SAMPLE);
      expect(renderedText(tree)).toContain('bb.jsh');
      tree.items = [];
      await settle();
      expect(renderedText(tree)).not.toContain('bb.jsh');
    });
  });

  describe('lifecycle', () => {
    it('tears the tree down on disconnect', async () => {
      const tree = await mount(SAMPLE);
      tree.remove();
      await settle();
      // Post-teardown calls must not throw on a detached component.
      expect(() => tree.toggleDir('/workspace')).not.toThrow();
      expect(tree.isDirOpen('/workspace')).toBe(false);
    });

    it('renders again when re-connected', async () => {
      const tree = await mount(SAMPLE);
      tree.remove();
      document.body.appendChild(tree);
      await settle();
      expect(renderedText(tree)).toContain('bb.jsh');
    });

    it('accepts items assigned before connection', async () => {
      const tree = document.createElement('slicc-file-tree') as SliccFileTree;
      tree.items = SAMPLE;
      document.body.appendChild(tree);
      await settle();
      expect(renderedText(tree)).toContain('bb.jsh');
    });
  });
});
