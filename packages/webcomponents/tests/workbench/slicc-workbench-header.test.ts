import { beforeEach, describe, expect, it, vi } from 'vitest';
// Siblings composed into the header — already registered; safe to import so the
// populated header mirrors the prototype (tab bar + kind badge + collapse btn).
// `slicc-tab-bar` is built in this wave too, so it is composed by tag only.
import '../../src/primitives/slicc-collapse-btn.js';
import '../../src/primitives/slicc-pane-tag.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';
import { SliccWorkbenchHeader } from '../../src/workbench/slicc-workbench-header.js';

/** Resolve a token reference (e.g. `var(--line)`) to its computed rgb string. */
function rgb(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  document.body.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return resolved;
}

/**
 * Build a realistic, populated workbench header matching the prototype `.wbhead`:
 * a tab bar (composed by tag), the kind badge, and the collapse button. The tab
 * bar carries its own scrolling chrome inline so the header geometry resolves.
 */
function makeHeader(kind: 'tool' | 'sprinkle' = 'tool'): SliccWorkbenchHeader {
  const el = document.createElement('slicc-workbench-header') as SliccWorkbenchHeader;
  el.style.cssText = 'width:520px;';
  el.setAttribute('kind', kind);
  el.innerHTML = `
    <slicc-tab-bar style="display:flex;min-width:0;overflow-x:auto;gap:4px;">
      <button class="tab sp">Hero studio</button>
      <button class="tab sp">palette</button>
    </slicc-tab-bar>
    <slicc-pane-tag></slicc-pane-tag>
    <slicc-collapse-btn></slicc-collapse-btn>`;
  return el;
}

describe('slicc-workbench-header', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-workbench-header')).toBe(SliccWorkbenchHeader);
  });

  it('renders into light DOM (no shadow root) with the spacer exposed as part="spacer"', () => {
    const el = makeHeader();
    document.body.appendChild(el);
    expect(el.shadowRoot).toBeNull();
    const spacer = el.querySelector('.slicc-wbhead__spacer') as HTMLElement;
    expect(spacer).not.toBeNull();
    expect(spacer.getAttribute('part')).toBe('spacer');
    // The `spacer` getter returns that same element.
    expect(el.spacer).toBe(spacer);
  });

  it('orders children: tab bar (left) → spacer → kind badge → collapse button (right)', () => {
    const el = makeHeader();
    document.body.appendChild(el);
    const tags = Array.from(el.children).map((c) => c.tagName.toLowerCase());
    expect(tags).toEqual([
      'slicc-tab-bar',
      'div', // the .spacer
      'slicc-pane-tag',
      'slicc-collapse-btn',
    ]);
    // The spacer is the prototype `flex:1` pusher.
    const spacer = el.querySelector('.slicc-wbhead__spacer') as HTMLElement;
    expect(getComputedStyle(spacer).flexGrow).toBe('1');
  });

  it('reflects the kind attribute to the property and back', () => {
    const el = makeHeader('tool');
    document.body.appendChild(el);

    expect(el.kind).toBe('tool');
    el.kind = 'sprinkle';
    expect(el.getAttribute('kind')).toBe('sprinkle');
    expect(el.kind).toBe('sprinkle');

    // Unrecognized values resolve to null on the property.
    el.setAttribute('kind', 'bogus');
    expect(el.kind).toBeNull();

    el.kind = null;
    expect(el.hasAttribute('kind')).toBe(false);
  });

  it('forwards kind down to the composed slicc-pane-tag badge (and updates on change)', () => {
    const el = makeHeader('tool');
    document.body.appendChild(el);
    const badge = el.querySelector('slicc-pane-tag') as HTMLElement;
    expect(badge.getAttribute('kind')).toBe('tool');

    el.kind = 'sprinkle';
    expect(badge.getAttribute('kind')).toBe('sprinkle');

    el.kind = null;
    expect(badge.hasAttribute('kind')).toBe(false);
  });

  it('re-emits a composed, bubbling collapse event when the composed collapse button fires', () => {
    const el = makeHeader();
    document.body.appendChild(el);

    const onDoc = vi.fn();
    document.body.addEventListener('collapse', onDoc);
    const fromHeader: CustomEvent[] = [];
    el.addEventListener('collapse', (e) => {
      if (e.target === el) fromHeader.push(e as CustomEvent);
    });

    const btn = el.querySelector('slicc-collapse-btn') as HTMLElement;
    btn.shadowRoot?.querySelector('button')?.click();

    // The header re-emits exactly one collapse with itself as the target.
    expect(fromHeader).toHaveLength(1);
    expect(fromHeader[0].bubbles).toBe(true);
    expect(fromHeader[0].composed).toBe(true);
    // The document sees a single collapse (the original was stopped at the host).
    expect(onDoc).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('collapse', onDoc);
  });

  it('is a flex strip: row, gap 6px, 8px/12px padding, bottom --line border, clipped overflow (real Chromium)', () => {
    const el = makeHeader();
    document.body.appendChild(el);
    const cs = getComputedStyle(el);

    expect(cs.display).toBe('flex');
    expect(cs.flexDirection).toBe('row');
    expect(cs.alignItems).toBe('center');
    expect(cs.columnGap).toBe('6px');
    expect(cs.paddingTop).toBe('8px');
    expect(cs.paddingLeft).toBe('12px');
    // Bottom border only, 1px, from --line.
    expect(cs.borderBottomStyle).toBe('solid');
    expect(cs.borderBottomWidth).toBe('1px');
    expect(cs.borderTopStyle).toBe('none');
    expect(cs.borderBottomColor).toBe(rgb('var(--line)'));
    // Overflow hidden so the tab bar scrolls instead of widening the strip.
    expect(cs.overflowX).toBe('hidden');
    // Keeps its intrinsic height inside the column (flex: 0 0 auto).
    expect(cs.flexGrow).toBe('0');
    expect(cs.flexShrink).toBe('0');
  });

  it('pins the right-rail items as flex 0 0 auto so the spacer pushes them right', () => {
    const el = makeHeader();
    document.body.appendChild(el);
    const badge = el.querySelector('slicc-pane-tag') as HTMLElement;
    const collapse = el.querySelector('slicc-collapse-btn') as HTMLElement;
    for (const item of [badge, collapse]) {
      const cs = getComputedStyle(item);
      expect(cs.flexGrow).toBe('0');
      expect(cs.flexShrink).toBe('0');
    }
    // Geometry: the badge + collapse sit to the right of the spacer.
    const spacerRight = (
      el.querySelector('.slicc-wbhead__spacer') as HTMLElement
    ).getBoundingClientRect().right;
    expect(badge.getBoundingClientRect().left).toBeGreaterThanOrEqual(spacerRight - 1);
  });

  it('flips the bottom border with dark mode via inherited tokens', () => {
    const el = makeHeader();
    document.body.appendChild(el);
    const light = getComputedStyle(el).borderBottomColor;

    setTheme('dark');
    const dark = getComputedStyle(el).borderBottomColor;
    setTheme('light');
    expect(dark).not.toBe(light);
  });

  it('survives detach + re-attach without rebuilding / duplicating the spacer', () => {
    const el = makeHeader();
    document.body.appendChild(el);
    const spacer = el.querySelector('.slicc-wbhead__spacer') as HTMLElement;

    el.remove();
    document.body.appendChild(el);

    expect(el.querySelector('.slicc-wbhead__spacer')).toBe(spacer);
    expect(el.querySelectorAll('.slicc-wbhead__spacer').length).toBe(1);
  });

  it('works empty (no slotted children): builds the spacer, badge sync is a no-op', () => {
    const el = document.createElement('slicc-workbench-header') as SliccWorkbenchHeader;
    el.setAttribute('kind', 'tool');
    document.body.appendChild(el);
    expect(el.querySelector('.slicc-wbhead__spacer')).not.toBeNull();
    // No badge to forward to — does not throw, kind still reflects.
    expect(el.kind).toBe('tool');
    expect(el.querySelector('slicc-pane-tag')).toBeNull();
  });
});
