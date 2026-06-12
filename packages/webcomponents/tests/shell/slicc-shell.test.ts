import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccShell } from '../../src/shell/slicc-shell.js';
// Composed children (by tag) — import so they are registered when tests run.
import '../../src/shell/slicc-chatpane.js';
import '../../src/dock/slicc-dock.js';
import '../../src/workbench/slicc-workbench-pane.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mountShell(open = false): SliccShell {
  const shell = document.createElement('slicc-shell');
  if (open) shell.setAttribute('open', '');
  shell.innerHTML =
    '<slicc-chatpane></slicc-chatpane>' +
    '<slicc-workbench-pane></slicc-workbench-pane>' +
    '<slicc-dock></slicc-dock>';
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

  it('overlays the workbench full-bleed (not a side-by-side split) at narrow / sidebar widths', () => {
    mountShell(true);
    // The scoped stylesheet carries an @media (max-width: 560px) block whose
    // workbench rule switches the pane to an absolute overlay — a viewport this
    // thin (an extension side panel) cannot host a chat | workbench split.
    const sheet = (document.getElementById('slicc-shell-style') as HTMLStyleElement).sheet;
    const media = Array.from(sheet?.cssRules ?? []).find(
      (r): r is CSSMediaRule => r instanceof CSSMediaRule && r.conditionText.includes('560px')
    );
    expect(media).toBeDefined();
    const wb = Array.from((media as CSSMediaRule).cssRules).find(
      (r): r is CSSStyleRule =>
        r instanceof CSSStyleRule && r.selectorText.includes('slicc-workbench-pane')
    );
    expect(wb?.style.position).toBe('absolute');
  });

  it('pins the dock to a full 48px basis so the rail is flush to the edge (no bare strip)', () => {
    mountShell();
    // Regression: the shell rule outranks the dock's own `flex: 0 0 48px`, so an
    // `auto` basis here collapsed the rail to its ~35px icon width and left a
    // bare-shader strip down the right edge.
    const sheet = (document.getElementById('slicc-shell-style') as HTMLStyleElement).sheet;
    const dockRule = Array.from(sheet?.cssRules ?? []).find(
      (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.includes('slicc-dock')
    );
    expect(dockRule?.style.flexBasis).toBe('48px');
  });

  it('exposes its three regions by getter', () => {
    const shell = mountShell();
    expect(shell.chatpane?.tagName.toLowerCase()).toBe('slicc-chatpane');
    expect(shell.workbench?.tagName.toLowerCase()).toBe('slicc-workbench-pane');
    expect(shell.dock?.tagName.toLowerCase()).toBe('slicc-dock');
  });

  it('reflects open between attribute and property and forwards to children', () => {
    const shell = mountShell();
    expect(shell.open).toBe(false);
    shell.open = true;
    expect(shell.hasAttribute('open')).toBe(true);
    expect(shell.chatpane?.hasAttribute('narrow')).toBe(true);
    expect(shell.workbench?.hasAttribute('open')).toBe(true);
    shell.open = false;
    expect(shell.chatpane?.hasAttribute('narrow')).toBe(false);
    expect(shell.workbench?.hasAttribute('open')).toBe(false);
  });

  it('select() opens the workbench and emits slicc-shell-select', () => {
    const shell = mountShell();
    let detail: { id: string } | null = null;
    shell.addEventListener('slicc-shell-select', (e) => {
      detail = (e as CustomEvent).detail;
    });
    shell.select('files');
    expect(shell.open).toBe(true);
    expect(shell.chatpane?.hasAttribute('narrow')).toBe(true);
    expect(detail).toEqual({ id: 'files' });
  });

  it('collapse() closes the workbench and emits slicc-shell-collapse', () => {
    const shell = mountShell(true);
    let collapsed = false;
    shell.addEventListener('slicc-shell-collapse', () => {
      collapsed = true;
    });
    shell.collapse();
    expect(shell.open).toBe(false);
    expect(shell.workbench?.hasAttribute('open')).toBe(false);
    expect(collapsed).toBe(true);
  });

  it('reacts to a bubbling dock-select event by selecting that surface', () => {
    const shell = mountShell();
    const selected: string[] = [];
    shell.addEventListener('slicc-shell-select', (e) =>
      selected.push((e as CustomEvent).detail.id)
    );
    shell.dock?.dispatchEvent(
      new CustomEvent('dock-select', { detail: { id: 'terminal' }, bubbles: true, composed: true })
    );
    expect(shell.open).toBe(true);
    expect(selected).toEqual(['terminal']);
  });

  it('animates the split with the prototype width transition', () => {
    const shell = mountShell();
    const cs = getComputedStyle(shell.chatpane as Element);
    expect(cs.transitionProperty).toContain('width');
    expect(cs.transitionDuration).toContain('0.38s');
  });

  it('cleans up its dock listeners on disconnect', () => {
    const shell = mountShell();
    shell.remove();
    let fired = false;
    shell.addEventListener('slicc-shell-select', () => {
      fired = true;
    });
    shell.dock?.dispatchEvent(
      new CustomEvent('dock-select', { detail: { id: 'x' }, bubbles: true })
    );
    expect(fired).toBe(false);
  });
});
