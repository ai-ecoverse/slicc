// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ShownMenu {
  items: Array<{ id: string; label: string; visible?: boolean }>;
}

const shown: ShownMenu[] = [];

vi.mock('@slicc/webcomponents', () => ({
  SliccOverflowMenu: {
    show: (opts: ShownMenu) => {
      shown.push(opts);
    },
  },
  SliccQuickLook: { open: () => {}, close: () => {} },
}));

const { wireFileActions } = await import('../../src/ui/wc/file-actions.js');

function visibleIds(menu: ShownMenu | undefined): string[] {
  return (menu?.items ?? []).filter((i) => i.visible !== false).map((i) => i.id);
}

function wire(): HTMLElement {
  const fileTree = document.createElement('div');
  document.body.appendChild(fileTree);
  wireFileActions({
    fileTree,
    openFs: () =>
      Promise.resolve({
        readDir: () => Promise.resolve([]),
        readFile: () => Promise.resolve(new Uint8Array()),
        stat: () => Promise.reject(new Error('ENOENT')),
      }),
    openWriter: () => Promise.reject(new Error('not needed')),
    insertReference: () => {},
    toPreviewUrl: (p: string) => `https://preview.test${p}`,
    log: { error: () => {} },
  });
  return fileTree;
}

function openMenu(fileTree: HTMLElement, path: string, kind: 'file' | 'directory'): void {
  fileTree.dispatchEvent(
    new CustomEvent('file-overflow', {
      detail: { id: path, path, anchor: document.createElement('button'), kind },
    })
  );
}

function chooseAction(fileTree: HTMLElement, action: string, path: string): void {
  fileTree.dispatchEvent(
    new CustomEvent('overflow-action', { detail: { action, context: { path } } })
  );
}

describe('file-tree context menu', () => {
  beforeEach(() => {
    shown.length = 0;
    document.body.replaceChildren();
  });

  describe('event contract', () => {
    for (const action of ['preview', 'reference', 'download'] as const) {
      it(`choosing "${action}" emits file-${action}`, () => {
        const fileTree = wire();
        const seen: Array<{ id: string; path: string }> = [];
        fileTree.addEventListener(`file-${action}`, (e) => {
          seen.push((e as CustomEvent<{ id: string; path: string }>).detail);
        });

        chooseAction(fileTree, action, '/workspace/bb.jsh');

        expect(seen).toEqual([{ id: '/workspace/bb.jsh', path: '/workspace/bb.jsh' }]);
      });
    }

    it('emits those events composed and bubbling, like the tree does', () => {
      const fileTree = wire();
      const events: Event[] = [];
      document.body.addEventListener('file-preview', (e) => events.push(e));

      chooseAction(fileTree, 'preview', '/workspace/bb.jsh');

      expect(events[0]?.composed).toBe(true);
      expect(events[0]?.bubbles).toBe(true);
    });
  });

  describe('menu contents', () => {
    it('offers the full set for a file', () => {
      const fileTree = wire();
      openMenu(fileTree, '/workspace/bb.jsh', 'file');

      expect(visibleIds(shown[0])).toEqual([
        'preview',
        'reference',
        'download',
        'rename',
        'duplicate',
        'copy-path',
        'delete',
      ]);
    });

    it('offers only copy-path for a directory', () => {
      const fileTree = wire();
      openMenu(fileTree, '/workspace/skills', 'directory');

      expect(visibleIds(shown[0])).toEqual(['copy-path']);
    });

    it('offers "open in browser" only for a previewable file type', () => {
      const fileTree = wire();
      openMenu(fileTree, '/workspace/page.html', 'file');
      expect(visibleIds(shown[0])).toContain('open-browser');

      shown.length = 0;
      openMenu(fileTree, '/workspace/notes.md', 'file');
      expect(visibleIds(shown[0])).not.toContain('open-browser');
    });

    it('never offers "open in browser" for a directory', () => {
      const fileTree = wire();
      openMenu(fileTree, '/workspace/site.html-dir', 'directory');
      expect(visibleIds(shown[0])).not.toContain('open-browser');
    });
  });
});
