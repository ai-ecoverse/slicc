import { beforeEach, describe, expect, it, vi } from 'vitest';
// The composed chrome sibling (registered by an earlier wave) — import its
// side-effect module so the inner <slicc-pane> upgrades and resolves its
// surface geometry under real Chromium.
import '../../src/primitives/slicc-pane.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';
import '../../src/workbench/slicc-surface.js';
import '../../src/workbench/slicc-workbench-body.js';
import { SliccWorkbenchPane } from '../../src/workbench/slicc-workbench-pane.js';

/** The composed `<slicc-pane>` chrome the host renders into its light DOM. */
function paneOf(el: SliccWorkbenchPane): HTMLElement {
  return el.querySelector(':scope > slicc-pane') as HTMLElement;
}

/**
 * Build a realistic, populated workbench pane: a `<slicc-workbench-header>`
 * (slotted into the header) carrying a tabstrip, and a `<slicc-workbench-body>`
 * carrying a memory surface — the prototype `.wbhead` / `.wbbody` markup. The
 * two sibling tags are composed BY TAG (they may be inert here, which is the
 * point: relocation must not depend on them being upgraded).
 */
function makeWorkbenchPane(): SliccWorkbenchPane {
  const el = document.createElement('slicc-workbench-pane') as SliccWorkbenchPane;
  // Give the shell real width so the calc(66% - 72px) geometry resolves.
  el.style.cssText = 'display:flex;';

  const header = document.createElement('slicc-workbench-header');
  header.setAttribute('slot', 'header');
  header.className = 'wbhead-demo';
  header.innerHTML = '<div class="tabstrip"><button class="tab">Hero studio</button></div>';

  const body = document.createElement('slicc-workbench-body');
  body.className = 'wbbody-demo';
  body.innerHTML = '<div class="memrow">palette preference</div>';

  el.append(header, body);
  return el;
}

/** Mount the pane inside a fixed-width shell row so 66% resolves to real px. */
function mountInShell(el: SliccWorkbenchPane): HTMLElement {
  const shell = document.createElement('div');
  shell.style.cssText = 'display:flex;width:1000px;height:400px;';
  shell.appendChild(el);
  document.body.appendChild(shell);
  return shell;
}

describe('slicc-workbench-pane', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-workbench-pane')).toBe(SliccWorkbenchPane);
  });

  it('renders into light DOM (no shadow root), composing an elevated <slicc-pane part="pane">', () => {
    const el = makeWorkbenchPane();
    mountInShell(el);

    expect(el.shadowRoot).toBeNull();
    const pane = paneOf(el);
    expect(pane).not.toBeNull();
    expect(pane.tagName.toLowerCase()).toBe('slicc-pane');
    // Composed with the heavier two-layer workbench shadow.
    expect(pane.hasAttribute('elevated')).toBe(true);
    expect(pane.getAttribute('part')).toBe('pane');
    // The `pane` getter returns that same wrapper.
    expect(el.pane).toBe(pane);
  });

  it('relocates the slotted header + body (by tag) into the composed pane, in order', () => {
    const el = makeWorkbenchPane();
    mountInShell(el);
    const pane = paneOf(el);

    const header = pane.querySelector('slicc-workbench-header');
    const body = pane.querySelector('slicc-workbench-body');
    expect(header).not.toBeNull();
    expect(body).not.toBeNull();
    // The header keeps slot="header" so the composed pane pins it above its scroll body.
    expect(header!.getAttribute('slot')).toBe('header');
    // DOM order preserved: header precedes body.
    expect(header!.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reflects the open attribute to the property and back', () => {
    const el = makeWorkbenchPane();
    mountInShell(el);

    expect(el.open).toBe(false);
    el.open = true;
    expect(el.hasAttribute('open')).toBe(true);
    expect(el.open).toBe(true);
    el.open = false;
    expect(el.hasAttribute('open')).toBe(false);

    el.setAttribute('open', '');
    expect(el.open).toBe(true);
  });

  it('survives detach + re-attach without rebuilding / duplicating the pane', () => {
    const el = makeWorkbenchPane();
    const shell = mountInShell(el);
    const pane = paneOf(el);

    el.remove();
    shell.appendChild(el);

    expect(paneOf(el)).toBe(pane);
    expect(el.querySelectorAll(':scope > slicc-pane').length).toBe(1);
  });

  it('collapsed (default): width 0, opacity 0, clipped, with the animated transition', () => {
    const el = makeWorkbenchPane();
    mountInShell(el);
    const cs = getComputedStyle(el);

    expect(cs.width).toBe('0px');
    expect(cs.opacity).toBe('0');
    expect(cs.overflowX).toBe('hidden');
    expect(cs.flexGrow).toBe('0');
    expect(cs.flexShrink).toBe('0');
    // The width/margin/opacity transition is present.
    expect(cs.transitionProperty).toContain('width');
    expect(cs.transitionProperty).toContain('opacity');
    expect(cs.transitionDuration).toContain('0.38s');
  });

  it('expanded (open): opacity 1, 12px margin, and width = calc(66% - 72px) of the shell', () => {
    const el = makeWorkbenchPane();
    el.setAttribute('open', '');
    mountInShell(el);
    const cs = getComputedStyle(el);

    expect(cs.opacity).toBe('1');
    expect(cs.marginTop).toBe('12px');
    expect(cs.marginLeft).toBe('12px');
    // 66% of the 1000px shell minus the 72px reserve = 588px.
    expect(el.getBoundingClientRect().width).toBeCloseTo(588, 0);
  });

  it('toggling open fires a composed, bubbling slicc-workbench-pane-toggle with detail.open', () => {
    const el = makeWorkbenchPane();
    mountInShell(el);

    const onToggle = vi.fn();
    // Listen on the document to prove the event bubbles + composes out of the host.
    document.addEventListener('slicc-workbench-pane-toggle', onToggle);
    try {
      el.open = true;
      el.open = false;
    } finally {
      document.removeEventListener('slicc-workbench-pane-toggle', onToggle);
    }

    expect(onToggle).toHaveBeenCalledTimes(2);
    const first = onToggle.mock.calls[0][0] as CustomEvent<{ open: boolean }>;
    const second = onToggle.mock.calls[1][0] as CustomEvent<{ open: boolean }>;
    expect(first.bubbles).toBe(true);
    expect(first.composed).toBe(true);
    expect(first.detail.open).toBe(true);
    expect(second.detail.open).toBe(false);
  });

  it('does not fire the toggle event for redundant attribute writes', () => {
    const el = makeWorkbenchPane();
    el.setAttribute('open', '');
    mountInShell(el);

    const onToggle = vi.fn();
    document.addEventListener('slicc-workbench-pane-toggle', onToggle);
    try {
      // Re-setting to the same value is a no-op (oldValue === newValue).
      el.setAttribute('open', '');
    } finally {
      document.removeEventListener('slicc-workbench-pane-toggle', onToggle);
    }
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('inherits the floating-card chrome from the composed pane (canvas surface + line border)', () => {
    const el = makeWorkbenchPane();
    el.setAttribute('open', '');
    mountInShell(el);

    const surface = paneOf(el).querySelector('.slicc-pane__surface') as HTMLElement;
    expect(surface).not.toBeNull();
    const scs = getComputedStyle(surface);
    // var(--canvas) = #fff in light; a 1px var(--line) border; 14px radius; clipped.
    expect(scs.borderTopWidth).toBe('1px');
    expect(scs.borderTopStyle).toBe('solid');
    expect(scs.borderTopLeftRadius).toBe('14px');
    expect(scs.overflowX).toBe('hidden');
    expect(scs.backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('flips the floating-card surface to the dark canvas via the inherited theme scope', () => {
    const el = makeWorkbenchPane();
    el.setAttribute('open', '');
    mountInShell(el);
    const surface = paneOf(el).querySelector('.slicc-pane__surface') as HTMLElement;

    const light = getComputedStyle(surface).backgroundColor;
    setTheme('dark');
    const dark = getComputedStyle(surface).backgroundColor;
    expect(dark).not.toBe(light);
    // --canvas darkens to #161618 in dark mode.
    expect(dark).toBe('rgb(22, 22, 24)');
  });
});

describe('slicc-workbench-pane / body height', () => {
  it('passes the remaining pane height to a flex-sized workbench body', async () => {
    // The regression: the pane's body region was a plain block, so a
    // `slicc-workbench-body { flex: 1 }` child (whose surfaces are
    // absolutely positioned and add no auto height) collapsed to 0px —
    // panes rendered as a 10px sliver of rounded corners.
    const host = document.createElement('div');
    host.style.cssText = 'display:flex;width:1200px;height:600px;';
    const el = document.createElement('slicc-workbench-pane') as SliccWorkbenchPane;
    el.setAttribute('open', '');

    const header = document.createElement('slicc-workbench-header');
    header.setAttribute('slot', 'header');
    header.textContent = 'tabs';

    const body = document.createElement('slicc-workbench-body');
    const surface = document.createElement('slicc-surface');
    surface.setAttribute('surface-id', 'mem');
    surface.setAttribute('active', '');
    surface.textContent = 'content';
    body.append(surface);

    el.append(header, body);
    host.append(el);
    document.body.appendChild(host);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const bodyRect = body.getBoundingClientRect();
    expect(bodyRect.height).toBeGreaterThan(400);
    host.remove();
  });
});
