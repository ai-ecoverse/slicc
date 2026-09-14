import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hintNodes, SliccKeyHud } from '../../src/composer/slicc-key-hud.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(attrs: Record<string, string> = {}): SliccKeyHud {
  const el = document.createElement('slicc-key-hud') as SliccKeyHud;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  document.body.append(el);
  return el;
}

function caps(el: SliccKeyHud): string[] {
  return [...(el.shadowRoot?.querySelectorAll('.press') ?? [])].map((press) =>
    [...press.querySelectorAll('.cap')]
      .map((cap) => cap.getAttribute('aria-label') ?? cap.textContent)
      .join('')
  );
}

function pressEls(el: SliccKeyHud): HTMLElement[] {
  return [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.press') ?? [])];
}

function hintEl(el: SliccKeyHud): HTMLElement | null {
  return el.shadowRoot?.querySelector('.hint') ?? null;
}

describe('slicc-key-hud', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers and renders its chrome into a shadow root', () => {
    const el = mount();
    expect(customElements.get('slicc-key-hud')).toBe(SliccKeyHud);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe('Keyboard mode');

    expect(el.shadowRoot?.querySelector('svg.icon')).not.toBeNull();
  });

  it('pins itself to the bottom of its column', () => {
    const el = mount();
    const style = getComputedStyle(el);
    expect(style.position).toBe('absolute');
    expect(style.bottom).toBe('0px');

    expect(style.zIndex).toBe('2');
  });

  it('does not bleed on its own — that paint is a slicc-shell rule', () => {
    const el = mount();

    expect(getComputedStyle(el, '::after').content).toBe('none');
  });

  it('announces the mode but never the typing', () => {
    const el = mount();
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');

    expect(el.shadowRoot?.querySelector('.keys')?.getAttribute('aria-hidden')).toBe('true');
  });

  describe('the hint', () => {
    it('draws bracketed tokens as caps and the rest as text', () => {
      const el = mount();
      const hint = hintEl(el);
      expect(hint?.textContent).toContain('help');
      expect([...(hint?.querySelectorAll('.cap') ?? [])].map((cap) => cap.textContent)).toEqual([
        '?',
        'i',
        '',
      ]);

      expect(hint?.querySelector('.cap[aria-label="⏎"] svg')).not.toBeNull();
    });

    it('takes the host wording, since the shell reads the live keymap', () => {
      const el = mount({ hint: '[x] help' });
      expect(hintEl(el)?.textContent).toBe('x help');
    });

    it('renders nothing for an empty hint', () => {
      const el = mount({ hint: '' });
      expect(hintEl(el)?.hidden).toBe(true);
    });

    it('escapes rather than parses — a hint is not a markup surface', () => {
      const el = mount({ hint: '<b>bold</b>' });
      expect(hintEl(el)?.querySelector('b')).toBeNull();
      expect(hintEl(el)?.textContent).toBe('<b>bold</b>');
    });

    it('splits into caps and text, unbracketed text passing through whole', () => {
      expect(hintNodes('plain')).toEqual(['plain']);
      expect(hintNodes('')).toEqual([]);
    });
  });

  describe('presses', () => {
    it('draws a press per keystroke, staling everything but the newest', () => {
      const el = mount();
      el.record(['f'], true);
      el.record(['3'], true);
      expect(caps(el)).toEqual(['f', '3']);
      expect(pressEls(el).map((press) => press.dataset.age)).toEqual(['stale', undefined]);
    });

    it('draws an unbound press dimmed rather than not at all', () => {
      const el = mount();
      el.record(['q'], false);
      expect(pressEls(el).map((press) => press.dataset.bound)).toEqual(['false']);
    });

    it('gives the hint up while caps are on screen, and takes it back on clear', () => {
      const el = mount();
      expect(hintEl(el)?.hidden).toBe(false);
      el.record(['f'], true);
      expect(hintEl(el)?.hidden).toBe(true);
      el.clear();
      expect(hintEl(el)?.hidden).toBe(false);
      expect(caps(el)).toEqual([]);
    });

    it('keeps only `depth` presses, dropping the oldest', () => {
      const el = mount({ depth: '2' });
      for (const key of ['a', 'b', 'c']) el.record([key], true);
      expect(caps(el)).toEqual(['b', 'c']);
    });

    it('draws a modifier chord as one press of several caps', () => {
      const el = mount();
      el.record(['⌘', '⇧', 'P'], false);
      expect(caps(el)).toEqual(['⌘⇧P']);
    });

    it('round-trips presses defensively', () => {
      const el = mount();
      el.presses = [{ caps: ['f'] }, { caps: ['3'], bound: false }];
      const copy = el.presses;
      copy[0].caps[0] = 'changed';
      expect(el.presses[0].caps).toEqual(['f']);
      expect(caps(el)).toEqual(['f', '3']);
    });

    it('clears on a non-array assignment rather than throwing', () => {
      const el = mount();
      el.record(['f'], true);
      // @ts-expect-error exercising the defensive runtime guard.
      el.presses = null;
      expect(caps(el)).toEqual([]);
    });
  });

  describe('the linger', () => {
    it('clears the strip after the quiet spell, each press restarting it', () => {
      vi.useFakeTimers();
      try {
        const el = mount({ linger: '1000' });
        el.record(['f'], true);
        vi.advanceTimersByTime(700);
        el.record(['3'], true);
        vi.advanceTimersByTime(700);
        expect(caps(el)).toEqual(['f', '3']);
        vi.advanceTimersByTime(400);
        expect(caps(el)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('arms no timer for a declarative assignment', () => {
      vi.useFakeTimers();
      try {
        const el = mount({ linger: '1000' });
        el.presses = [{ caps: ['f'] }];
        vi.advanceTimersByTime(5000);
        expect(caps(el)).toEqual(['f']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops a live press deadline when presses are set declaratively', () => {
      vi.useFakeTimers();
      try {
        const el = mount({ linger: '1000' });
        el.record(['f'], true);
        el.presses = [{ caps: ['3'] }];
        el.remove();
        document.body.append(el);

        vi.advanceTimersByTime(5000);
        expect(caps(el)).toEqual(['3']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops its timer when it leaves the document', () => {
      vi.useFakeTimers();
      try {
        const el = mount({ linger: '1000' });
        el.record(['f'], true);
        el.remove();

        expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });

    it('picks the pending clear back up after a reattach', () => {
      vi.useFakeTimers();
      try {
        const el = mount({ linger: '1000' });
        el.record(['f'], true);
        vi.advanceTimersByTime(400);
        const column = document.createElement('div');
        document.body.append(column);
        column.append(el);
        expect(caps(el)).toEqual(['f']);

        vi.advanceTimersByTime(500);
        expect(caps(el)).toEqual(['f']);
        vi.advanceTimersByTime(200);
        expect(caps(el)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears on reattach when the linger ran out while it was detached', () => {
      vi.useFakeTimers();
      try {
        const el = mount({ linger: '1000' });
        el.record(['f'], true);
        el.remove();
        vi.advanceTimersByTime(2000);
        document.body.append(el);
        expect(caps(el)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not resurrect a cleared strip on a later reattach', () => {
      vi.useFakeTimers();
      try {
        const el = mount({ linger: '1000' });
        el.record(['f'], true);
        vi.advanceTimersByTime(1200);
        expect(caps(el)).toEqual([]);
        el.remove();
        document.body.append(el);
        expect(caps(el)).toEqual([]);
        expect(hintEl(el)?.hidden).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
