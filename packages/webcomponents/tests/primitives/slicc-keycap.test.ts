import { beforeEach, describe, expect, it } from 'vitest';
import { SliccKeycap } from '../../src/primitives/slicc-keycap.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function makeKeycap(cap: string): SliccKeycap {
  const el = document.createElement('slicc-keycap') as SliccKeycap;
  el.cap = cap;
  return el;
}

function keys(el: SliccKeycap): HTMLElement[] {
  return [...(el.shadowRoot?.querySelectorAll('.key') ?? [])] as HTMLElement[];
}

describe('slicc-keycap', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-keycap')).toBe(SliccKeycap);
  });

  it('renders one legend per cap with the cap/key parts', () => {
    const el = makeKeycap('f');
    document.body.appendChild(el);
    expect(el.shadowRoot?.querySelector('.cap')?.getAttribute('part')).toBe('cap');
    const [key] = keys(el);
    expect(key?.getAttribute('part')).toBe('key');
    expect(key?.tagName).toBe('KBD');
    expect(key?.textContent).toBe('f');
  });

  it('splits a chord on whitespace, modifiers first', () => {
    const el = makeKeycap('⌘ ⇧ P');
    document.body.appendChild(el);
    expect(keys(el).map((k) => k.textContent)).toEqual(['⌘', '⇧', 'P']);
  });

  /**
   * A key that is a SHAPE draws as the lucide glyph, not the character — at
   * 11px a font's idea of `⏎` is a smudge. The glyph is the whole reason the
   * cap table is shared with the HUD.
   */
  it('draws a shape key as a glyph rather than as text', () => {
    const el = makeKeycap('⏎');
    document.body.appendChild(el);
    const [key] = keys(el);
    expect(key?.querySelector('svg')).not.toBeNull();
    expect(key?.textContent).toBe('');
  });

  it('leaves a modifier character as text', () => {
    const el = makeKeycap('⌘');
    document.body.appendChild(el);
    const [key] = keys(el);
    expect(key?.querySelector('svg')).toBeNull();
    expect(key?.textContent).toBe('⌘');
  });

  it('reflects variant and placement, normalizing unknown values', () => {
    const el = makeKeycap('f');
    document.body.appendChild(el);
    expect(el.variant).toBe('chiclet');
    expect(el.placement).toBe('top-end');

    el.variant = 'deck';
    expect(el.getAttribute('variant')).toBe('deck');
    el.setAttribute('variant', 'brutalist');
    expect(el.variant).toBe('chiclet');

    el.placement = 'bottom-start';
    expect(el.getAttribute('placement')).toBe('bottom-start');
    el.setAttribute('placement', 'sideways');
    expect(el.placement).toBe('top-end');
  });

  it('reflects dim as a boolean attribute', () => {
    const el = makeKeycap('f');
    document.body.appendChild(el);
    expect(el.dim).toBe(false);
    el.dim = true;
    expect(el.hasAttribute('dim')).toBe(true);
    el.dim = false;
    expect(el.hasAttribute('dim')).toBe(false);
  });

  /**
   * The stagger seed cannot live in the shared constructable stylesheet — one
   * sheet, every instance — so it is written inline per cap.
   */
  it('writes the stagger seed to --i, defaulting to 0', () => {
    const el = makeKeycap('f');
    document.body.appendChild(el);
    expect(el.style.getPropertyValue('--i')).toBe('0');
    el.setAttribute('stagger', '4');
    expect(el.style.getPropertyValue('--i')).toBe('4');
    el.setAttribute('stagger', 'later');
    expect(el.style.getPropertyValue('--i')).toBe('0');
  });

  /** Decoration: the button's own name and the help sheet are the a11y path. */
  it('is hidden from assistive technology and never a hit target', () => {
    const el = makeKeycap('f');
    document.body.appendChild(el);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(getComputedStyle(el).pointerEvents).toBe('none');
  });

  it('positions itself against the nearest positioned ancestor', () => {
    const box = document.createElement('div');
    box.style.cssText = 'position:relative;width:120px;height:40px;';
    const el = makeKeycap('f');
    box.append(el);
    document.body.appendChild(box);
    expect(getComputedStyle(el).position).toBe('absolute');
    // Overhangs the corner: the cap's right edge is past the box's.
    expect(el.getBoundingClientRect().right).toBeGreaterThan(box.getBoundingClientRect().right);
  });

  it('re-renders when the cap changes', () => {
    const el = makeKeycap('f');
    document.body.appendChild(el);
    el.cap = 'j';
    expect(keys(el).map((k) => k.textContent)).toEqual(['j']);
  });

  /**
   * The cap cannot answer its own `:hover` (no hit area) and cannot ask the
   * sheet whether an ancestor is hovered (`:host-context(:hover)` is true
   * whenever the pointer is in the window, via `body`). So it watches the box
   * it is pinned inside — which means the press arrives with no host wiring.
   */
  describe('anchor hover', () => {
    function mount(): { anchor: HTMLElement; el: SliccKeycap } {
      const anchor = document.createElement('div');
      anchor.style.cssText = 'position:relative;width:120px;height:40px;';
      const el = makeKeycap('f');
      anchor.append(el);
      document.body.appendChild(anchor);
      return { anchor, el };
    }

    it('goes hot while the pointer is over its anchor', () => {
      const { anchor, el } = mount();
      expect(el.hasAttribute('hot')).toBe(false);
      anchor.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(true);
      anchor.dispatchEvent(new PointerEvent('pointerleave'));
      expect(el.hasAttribute('hot')).toBe(false);
    });

    /**
     * `pointerenter` does not bubble, so crossing between the control's own
     * children cannot re-fire it — one hover is one press, not a run of them.
     */
    it('does not re-press when the pointer crosses the anchor’s children', () => {
      const { anchor, el } = mount();
      const child = document.createElement('span');
      anchor.append(child);
      anchor.dispatchEvent(new PointerEvent('pointerenter'));
      child.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
      expect(el.hasAttribute('hot')).toBe(true);
    });

    /** A node yanked out mid-hover never gets its `pointerleave`. */
    it('drops hot and unbinds when it is detached', () => {
      const { anchor, el } = mount();
      anchor.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(true);

      el.remove();
      expect(el.hasAttribute('hot')).toBe(false);
      // The old anchor is no longer wired to it.
      anchor.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(false);
    });

    /**
     * A host that cannot make the cap a child of the control it names — a
     * shadow component whose default slot means something else, or one inside
     * a clipping parent — floats the cap elsewhere and points it at the real
     * control instead. The press has to follow the pointer THERE, not to the
     * box the cap happens to sit in.
     */
    it('follows an explicit anchor instead of its parent', () => {
      const { anchor, el } = mount();
      const real = document.createElement('button');
      document.body.append(real);
      el.anchor = real;
      expect(el.anchor).toBe(real);

      real.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(true);
      real.dispatchEvent(new PointerEvent('pointerleave'));
      expect(el.hasAttribute('hot')).toBe(false);

      // And the parent it is sitting in is no longer the one that presses it.
      anchor.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(false);
    });

    /** The shell re-resolves its targets whenever the chrome rebuilds. */
    it('re-points a live anchor, dropping the press with the old one', () => {
      const { el } = mount();
      const first = document.createElement('button');
      const second = document.createElement('button');
      document.body.append(first, second);

      el.anchor = first;
      first.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(true);

      // Re-pointed mid-hover: the old node will never send its `pointerleave`.
      el.anchor = second;
      expect(el.hasAttribute('hot')).toBe(false);
      first.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(false);
      second.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(true);
    });

    it('re-pointing to the same anchor is a no-op', () => {
      const { el } = mount();
      const real = document.createElement('button');
      document.body.append(real);
      el.anchor = real;
      real.dispatchEvent(new PointerEvent('pointerenter'));

      el.anchor = real;
      expect(el.hasAttribute('hot')).toBe(true);
    });

    it('falls back to the parent when an explicit anchor is cleared', () => {
      const { anchor, el } = mount();
      const real = document.createElement('button');
      document.body.append(real);
      el.anchor = real;
      el.anchor = null;

      expect(el.anchor).toBeNull();
      anchor.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(true);
    });

    /** The dock-tree MOVES surfaces rather than cloning them. */
    it('re-binds to its new anchor after a move', () => {
      const { anchor, el } = mount();
      const next = document.createElement('div');
      next.style.cssText = 'position:relative;width:120px;height:40px;';
      document.body.appendChild(next);

      next.append(el);
      next.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(true);

      next.dispatchEvent(new PointerEvent('pointerleave'));
      anchor.dispatchEvent(new PointerEvent('pointerenter'));
      expect(el.hasAttribute('hot')).toBe(false);
    });
  });
});
