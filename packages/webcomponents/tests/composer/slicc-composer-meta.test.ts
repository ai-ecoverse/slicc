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

    it('renders the sparkle rainbow icon in the model pill', () => {
      const el = mount();
      const ic = modelPill(el).querySelector('.ic') as HTMLElement;
      expect(ic.textContent).toBe('✦');
      // Real-browser fidelity: the rainbow gradient resolves as a background image.
      expect(getComputedStyle(ic).backgroundImage).toContain('gradient');
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

    it('renders the brain glyph tinted violet', () => {
      const el = mount();
      const brain = el.shadowRoot?.querySelector('.brain') as HTMLElement;
      // --violet: #8b5cf6 → rgb(139, 92, 246).
      expect(getComputedStyle(brain).color).toBe('rgb(139, 92, 246)');
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
    it('emits a composed, bubbling model-change when the model pill is clicked', () => {
      const el = mount((e) => {
        e.model = 'Opus 4.8';
      });
      let detail: { model: string } | null = null;
      el.addEventListener('model-change', (e) => {
        detail = (e as CustomEvent).detail;
      });
      modelPill(el).click();
      expect(detail).toEqual({ model: 'Opus 4.8' });
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
