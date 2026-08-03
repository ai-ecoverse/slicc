import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccShell } from '../../src/shell/slicc-shell.js';
// Composed children (by tag) — import so they are registered when tests run.
import '../../src/dock/slicc-dock.js';
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
});
