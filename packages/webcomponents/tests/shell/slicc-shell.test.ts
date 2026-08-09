import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccShell } from '../../src/shell/slicc-shell.js';
// Composed children (by tag) — import so they are registered when tests run.
import '../../src/dock/slicc-dock.js';
import '../../src/shell/slicc-chatpane.js';
import '../../src/workbench/slicc-surface.js';
import type { DockTreeSpec, SliccDockTree } from '../../src/workbench/slicc-dock-tree.js';
import '../../src/workbench/slicc-dock-tree.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mountShell(): SliccShell {
  const shell = document.createElement('slicc-shell');
  shell.innerHTML = '<slicc-dock-tree></slicc-dock-tree>' + '<slicc-dock></slicc-dock>';
  document.body.appendChild(shell);
  return shell as SliccShell;
}

describe('slicc-shell', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });
  afterEach(() => document.body.replaceChildren());

  it('registers the custom element and is light DOM', () => {
    expect(customElements.get('slicc-shell')).toBe(SliccShell);
    expect(mountShell().shadowRoot).toBeNull();
  });

  it('pins the dock to a full 48px basis so the rail is flush to the edge (no bare strip)', () => {
    mountShell();
    // Regression: the shell rule outranks the dock's own `flex: 0 0 48px`, so an
    // `auto` basis here collapsed the rail to its ~35px icon width and left a
    // bare-shader strip down the right edge.
    const sheet = (document.getElementById('slicc-shell-style') as HTMLStyleElement).sheet;
    const dockRule = Array.from(sheet?.cssRules ?? []).find(
      (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.includes('slicc-dock,')
    );
    expect(dockRule?.style.flexBasis).toBe('48px');
  });

  it('exposes its two regions by getter', () => {
    const shell = mountShell();
    expect(shell.dockTree?.tagName.toLowerCase()).toBe('slicc-dock-tree');
    expect(shell.dock?.tagName.toLowerCase()).toBe('slicc-dock');
  });

  it('gives the dock-tree the remaining flex space', () => {
    mountShell();
    const sheet = (document.getElementById('slicc-shell-style') as HTMLStyleElement).sheet;
    const treeRule = Array.from(sheet?.cssRules ?? []).find(
      (r): r is CSSStyleRule =>
        r instanceof CSSStyleRule && r.selectorText.includes('slicc-dock-tree')
    );
    // Chromium's CSSOM normalizes the unitless 0 flex-basis to "0px".
    expect(treeRule?.style.flex).toBe('1 1 0px');
  });

  it('narrows the chatpane exactly while the dock-tree places any non-chat leaf — the silent setTree restore included', () => {
    const shell = document.createElement('slicc-shell') as SliccShell;
    const dockTree = document.createElement('slicc-dock-tree') as SliccDockTree;
    const chatSurface = document.createElement('slicc-surface');
    chatSurface.setAttribute('surface-id', 'chat');
    const pane = document.createElement('slicc-chatpane');
    chatSurface.append(pane);
    const term = document.createElement('slicc-surface');
    term.setAttribute('surface-id', 'term');
    dockTree.append(chatSurface, term);
    shell.append(dockTree, document.createElement('slicc-dock'));
    document.body.appendChild(shell);

    const spec = (withTerm: boolean): DockTreeSpec => ({
      zones: {
        top: null,
        left: { type: 'leaf', surfaceId: 'chat' },
        middle: null,
        right: withTerm ? { type: 'leaf', surfaceId: 'term' } : null,
        bottom: null,
      },
      rowFr: { top: 1, center: 1, bottom: 1 },
      colFr: { left: 1, middle: 1, right: 1 },
    });

    dockTree.setTree(spec(false));
    expect(pane.hasAttribute('narrow')).toBe(false);

    // `setTree` fires no `dock-tree-change` (a restore must not re-persist) —
    // the narrow sync must ride the render notification instead, or a restored
    // two-leaf layout boots with the wide reading-column feather squeezed into
    // the narrow column (the post-#1784 regression).
    dockTree.setTree(spec(true));
    expect(pane.hasAttribute('narrow')).toBe(true);

    dockTree.removeSurface('term');
    expect(pane.hasAttribute('narrow')).toBe(false);
  });
});
