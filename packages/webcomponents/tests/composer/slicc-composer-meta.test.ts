import { beforeEach, describe, expect, it } from 'vitest';
import { SliccComposerMeta, THINKING_LEVELS } from '../../src/composer/slicc-composer-meta.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccComposerMeta) => void): SliccComposerMeta {
  const el = document.createElement('slicc-composer-meta') as SliccComposerMeta;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The model-select pill inside the shadow root. */
function modelPill(el: SliccComposerMeta): HTMLButtonElement {
  return el.shadowRoot?.querySelector('.msel') as HTMLButtonElement;
}

/** The thinking-effort pill inside the shadow root. */
function thinkingPill(el: SliccComposerMeta): HTMLButtonElement {
  return el.shadowRoot?.querySelector('.tsel') as HTMLButtonElement;
}

describe('slicc-composer-meta', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-composer-meta')).toBe(SliccComposerMeta);
  });

  describe('structure', () => {
    it('renders the meta row with all ::part hooks', () => {
      const el = mount();
      const root = el.shadowRoot;
      expect(root?.querySelector('[part="meta"]')).toBeTruthy();
      expect(root?.querySelector('[part="model"]')).toBeTruthy();
      expect(root?.querySelector('[part="thinking"]')).toBeTruthy();
      expect(root?.querySelector('[part="brain"]')).toBeTruthy();
      expect(root?.querySelector('[part="hint"]')).toBeTruthy();
    });

    it('places a flex spacer between the pills and the hint', () => {
      const el = mount();
      expect(el.shadowRoot?.querySelector('.mspacer')).toBeTruthy();
    });

    it('renders a lucide sparkles <svg> (not the ✦ emoji) in the model pill', () => {
      const el = mount();
      const ic = modelPill(el).querySelector('.ic') as SVGSVGElement;
      // The model glyph is a real lucide <svg>, rendered via iconSvg('sparkles').
      expect(ic).toBeTruthy();
      expect(ic.tagName.toLowerCase()).toBe('svg');
      expect(ic.querySelector('path')).toBeTruthy();
      // No bespoke unicode-symbol glyph remains anywhere on the pill.
      expect(modelPill(el).textContent ?? '').not.toContain('✦');
    });

    it('strokes the sparkles glyph with the rainbow gradient', () => {
      const el = mount();
      const ic = modelPill(el).querySelector('.ic') as SVGSVGElement;
      // The .ctl .ic rule paints the lucide stroke from the shadow-root gradient.
      expect(getComputedStyle(ic).stroke).toContain('meta-rainbow');
      // The gradient <defs> the stroke references is present in the shadow root.
      expect(el.shadowRoot?.querySelector('#meta-rainbow')).toBeTruthy();
    });

    it('renders a lucide chevron-down <svg> caret (not the ▾ glyph) in each pill', () => {
      const el = mount();
      const carets = el.shadowRoot?.querySelectorAll('.cx svg') as NodeListOf<SVGSVGElement>;
      expect(carets).toHaveLength(2);
      for (const c of carets) expect(c.tagName.toLowerCase()).toBe('svg');
      expect(el.shadowRoot?.querySelector('.meta')?.textContent ?? '').not.toContain('▾');
    });

    it('renders the default keyboard hint (two kbd chips + dot separators)', () => {
      const el = mount();
      const hint = el.shadowRoot?.querySelector('.hint') as HTMLElement;
      expect(hint.querySelectorAll('.kbd')).toHaveLength(2);
      expect(hint.querySelectorAll('.sep')).toHaveLength(2);
      expect(hint.textContent).toContain('send');
      expect(hint.textContent).toContain('newline');
      expect(hint.textContent).toContain('review before shipping');
    });

    it('exposes a named hint slot for overriding the hint content', () => {
      const el = mount();
      expect(el.shadowRoot?.querySelector('slot[name="hint"]')).toBeTruthy();
    });

    it('caps the row at 680px and centers it', () => {
      const el = mount();
      const row = el.shadowRoot?.querySelector('.meta') as HTMLElement;
      const cs = getComputedStyle(row);
      expect(cs.maxWidth).toBe('680px');
      expect(cs.display).toBe('flex');
    });
  });

  describe('attribute ↔ property reflection', () => {
    it('defaults the model to "Opus 4.8"', () => {
      const el = mount();
      expect(el.model).toBe('Opus 4.8');
      expect(modelPill(el).textContent).toContain('Opus 4.8');
    });

    it('reflects model into the pill (escaped)', () => {
      const el = mount((e) => {
        e.model = 'Sonnet 4.8';
      });
      expect(el.getAttribute('model')).toBe('Sonnet 4.8');
      expect(modelPill(el).textContent).toContain('Sonnet 4.8');

      el.model = '<script>x</script>';
      expect(modelPill(el).querySelector('script')).toBeNull();
      expect(el.shadowRoot?.querySelector('.msel')?.textContent).toContain('<script>x</script>');

      el.model = null;
      expect(el.hasAttribute('model')).toBe(false);
      expect(el.model).toBe('Opus 4.8');
    });

    it('defaults thinking to "bombastica"', () => {
      const el = mount();
      expect(el.thinking).toBe('bombastica');
      expect(el.shadowRoot?.querySelector('.tlabel')?.textContent).toBe('bombastica');
    });

    it('reflects thinking and normalizes unknown values to the default', () => {
      const el = mount((e) => {
        e.thinking = 'grande';
      });
      expect(el.getAttribute('thinking')).toBe('grande');
      expect(el.thinking).toBe('grande');
      expect(el.shadowRoot?.querySelector('.tlabel')?.textContent).toBe('grande');

      el.setAttribute('thinking', 'bogus');
      expect(el.thinking).toBe('bombastica');
    });

    it('reflects narrow', () => {
      const el = mount();
      expect(el.narrow).toBe(false);
      el.narrow = true;
      expect(el.hasAttribute('narrow')).toBe(true);
      el.narrow = false;
      expect(el.hasAttribute('narrow')).toBe(false);
    });
  });

  describe('thinking pill variants/states', () => {
    it('paints the violet border for the accented (bombastica) effort', () => {
      const el = mount((e) => {
        e.thinking = 'bombastica';
      });
      expect(el.accented).toBe(true);
      const tsel = thinkingPill(el);
      expect(tsel.classList.contains('x')).toBe(true);
      // The .ctl.tsel.x rule mixes 35% violet into --line; a default pill keeps --line.
      const accentedBorder = getComputedStyle(tsel).borderTopColor;

      el.thinking = 'grande';
      const plainTsel = thinkingPill(el);
      expect(plainTsel.classList.contains('x')).toBe(false);
      expect(el.accented).toBe(false);
      const plainBorder = getComputedStyle(plainTsel).borderTopColor;

      expect(accentedBorder).not.toBe(plainBorder);
    });

    it('renders a lucide brain <svg> tinted violet (not a hand-rolled glyph)', () => {
      const el = mount();
      const brain = el.shadowRoot?.querySelector('.brain') as unknown as SVGSVGElement;
      // The thinking glyph is a real lucide <svg>, rendered via iconSvg('brain').
      expect(brain).toBeTruthy();
      expect(brain.tagName.toLowerCase()).toBe('svg');
      expect(brain.querySelector('path')).toBeTruthy();
      // --violet: #8b5cf6 → rgb(139, 92, 246).
      expect(getComputedStyle(brain as unknown as Element).color).toBe('rgb(139, 92, 246)');
    });

    it('exposes the model-icon, brain, and caret ::part hooks on lucide <svg>s', () => {
      const el = mount();
      const root = el.shadowRoot;
      const modelIcon = root?.querySelector('[part="model-icon"]') as SVGSVGElement;
      const brain = root?.querySelector('[part="brain"]') as unknown as SVGSVGElement;
      expect(modelIcon?.tagName.toLowerCase()).toBe('svg');
      expect(brain?.tagName.toLowerCase()).toBe('svg');
      expect(root?.querySelectorAll('[part="caret"]')).toHaveLength(2);
    });
  });

  describe('narrow state', () => {
    it('hides the hint when narrow is set', () => {
      const el = mount((e) => {
        e.narrow = true;
      });
      const hint = el.shadowRoot?.querySelector('.hint') as HTMLElement;
      expect(getComputedStyle(hint).display).toBe('none');
    });

    it('shows the hint when not narrow', () => {
      const el = mount();
      const hint = el.shadowRoot?.querySelector('.hint') as HTMLElement;
      expect(getComputedStyle(hint).display).not.toBe('none');
    });
  });

  describe('behavior / events', () => {
    it('opens the model dropdown (upward) on pill click — not an immediate model-change', () => {
      const el = mount((e) => {
        e.model = 'Opus 4.8';
      });
      let fired = false;
      el.addEventListener('model-change', () => {
        fired = true;
      });
      expect(el.menuOpen).toBe(false);
      modelPill(el).click();
      // The pill toggles the menu open; nothing is committed yet.
      expect(el.menuOpen).toBe(true);
      expect(modelPill(el).getAttribute('aria-expanded')).toBe('true');
      expect(el.shadowRoot?.querySelector('.mwrap.open')).not.toBeNull();
      expect(fired).toBe(false);
      // The menu opens UPWARD (its bottom is anchored above the pill).
      const menu = el.shadowRoot?.querySelector('.menu') as HTMLElement;
      expect(getComputedStyle(menu).bottom).not.toBe('auto');
    });

    it('lists the model options with the current one ticked, defaulting to Opus/Sonnet/Haiku', () => {
      const el = mount((e) => {
        e.model = 'Sonnet 4.6';
      });
      modelPill(el).click();
      const items = [...(el.shadowRoot?.querySelectorAll('.mitem') ?? [])];
      expect(items.map((i) => i.getAttribute('data-model'))).toEqual([
        'Opus 4.8',
        'Sonnet 4.6',
        'Haiku 4.5',
      ]);
      const selected = el.shadowRoot?.querySelector('.mitem[aria-selected="true"]');
      expect(selected?.getAttribute('data-model')).toBe('Sonnet 4.6');
    });

    it('honours a custom models list', () => {
      const el = mount();
      el.models = ['gpt-5', 'o4'];
      modelPill(el).click();
      const items = [...(el.shadowRoot?.querySelectorAll('.mitem') ?? [])];
      expect(items.map((i) => i.textContent?.trim())).toEqual(['gpt-5', 'o4']);
    });

    it('selecting a row sets model, closes the menu, and emits model-change', () => {
      const el = mount((e) => {
        e.model = 'Opus 4.8';
      });
      let detail: { model: string } | null = null;
      el.addEventListener('model-change', (e) => {
        detail = (e as CustomEvent).detail;
      });
      modelPill(el).click();
      const haiku = el.shadowRoot?.querySelector(
        '.mitem[data-model="Haiku 4.5"]'
      ) as HTMLButtonElement;
      haiku.click();
      expect(el.model).toBe('Haiku 4.5');
      expect(el.menuOpen).toBe(false);
      expect(detail).toEqual({ model: 'Haiku 4.5' });
    });

    it('closes the model dropdown on an outside mousedown', () => {
      const el = mount();
      modelPill(el).click();
      expect(el.menuOpen).toBe(true);
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
      expect(el.menuOpen).toBe(false);
    });

    it('closes the model dropdown on Escape', () => {
      const el = mount();
      modelPill(el).click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(el.menuOpen).toBe(false);
    });

    it('cycles the thinking level forward (wrapping) on each click', () => {
      const el = mount((e) => {
        e.thinking = 'bambino';
      });
      const seen: string[] = [];
      el.addEventListener('thinking-change', (e) => {
        seen.push((e as CustomEvent).detail.thinking);
      });

      // bambino → piccolo → grande → bombastica → bambino (wrap).
      for (let i = 0; i < THINKING_LEVELS.length; i++) thinkingPill(el).click();

      expect(seen).toEqual(['piccolo', 'grande', 'bombastica', 'bambino']);
      expect(el.thinking).toBe('bambino');
    });

    it('swaps the label and toggles the violet border as it cycles', () => {
      const el = mount((e) => {
        e.thinking = 'grande';
      });
      expect(thinkingPill(el).classList.contains('x')).toBe(false);

      // grande → bombastica turns the border on.
      thinkingPill(el).click();
      expect(el.thinking).toBe('bombastica');
      expect(el.shadowRoot?.querySelector('.tlabel')?.textContent).toBe('bombastica');
      expect(thinkingPill(el).classList.contains('x')).toBe(true);

      // bombastica → bambino turns it back off.
      thinkingPill(el).click();
      expect(el.thinking).toBe('bambino');
      expect(thinkingPill(el).classList.contains('x')).toBe(false);
    });

    it('reports accented=true only for bombastica in the thinking-change detail', () => {
      const el = mount((e) => {
        e.thinking = 'grande';
      });
      let detail: { thinking: string; accented: boolean } | null = null;
      el.addEventListener('thinking-change', (e) => {
        detail = (e as CustomEvent).detail;
      });
      thinkingPill(el).click(); // → bombastica
      expect(detail).toEqual({ thinking: 'bombastica', accented: true });
    });

    it('does not emit thinking-change when the model pill is clicked', () => {
      const el = mount();
      let fired = false;
      el.addEventListener('thinking-change', () => {
        fired = true;
      });
      modelPill(el).click();
      expect(fired).toBe(false);
    });
  });

  describe('lifecycle cleanup', () => {
    it('detaches click listeners on disconnect', () => {
      const el = mount();
      const tsel = thinkingPill(el);
      el.remove();
      tsel.click();
      // Detached: cycling must not advance the (removed) element's state.
      expect(el.thinking).toBe('bombastica');
    });
  });
});
