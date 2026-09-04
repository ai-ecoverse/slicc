import { beforeEach, describe, expect, it } from 'vitest';
import { SliccCompactionMarker } from '../../src/chat/slicc-compaction-marker.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccCompactionMarker) => void): SliccCompactionMarker {
  const el = document.createElement('slicc-compaction-marker') as SliccCompactionMarker;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

function labelText(el: SliccCompactionMarker): string {
  return el.shadowRoot?.querySelector('[part="label"]')?.textContent ?? '';
}

function pathButton(el: SliccCompactionMarker): HTMLButtonElement | null {
  return el.shadowRoot?.querySelector('[part="path"]') as HTMLButtonElement | null;
}

const SNAPSHOT = '/sessions/live-cone-mtlor6sy-8egf.md';

describe('slicc-compaction-marker', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
    document.body.classList.remove('dark');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-compaction-marker')).toBe(SliccCompactionMarker);
  });

  it('renders the chip structure with ::part hooks in the shadow root', () => {
    const el = mount();
    expect(el.shadowRoot).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="chip"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="glyph"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="label"]')).toBeTruthy();
  });

  it('announces itself politely rather than interrupting a screen reader', () => {
    expect(mount().getAttribute('role')).toBe('status');
  });

  it('leaves a host-set role alone', () => {
    const el = mount((e) => {
      e.setAttribute('role', 'note');
    });
    expect(el.getAttribute('role')).toBe('note');
  });

  describe('attribute ↔ property reflection', () => {
    it('defaults to a summarized threshold round', () => {
      const el = mount();
      expect(el.trigger).toBe('threshold');
      expect(el.state).toBe('summarized');
    });

    it('reflects trigger', () => {
      const el = mount();
      el.trigger = 'idle';
      expect(el.getAttribute('trigger')).toBe('idle');
      expect(el.trigger).toBe('idle');
    });

    it('reflects state', () => {
      const el = mount();
      el.state = 'fallback';
      expect(el.getAttribute('state')).toBe('fallback');
      expect(el.state).toBe('fallback');
    });

    it('reflects transcript, and clears it on null', () => {
      const el = mount();
      el.transcript = SNAPSHOT;
      expect(el.getAttribute('transcript')).toBe(SNAPSHOT);
      el.transcript = null;
      expect(el.hasAttribute('transcript')).toBe(false);
    });

    it('reflects the label override, and clears it on null', () => {
      const el = mount();
      el.label = 'Compacted twice';
      expect(labelText(el)).toBe('Compacted twice');
      el.label = null;
      expect(labelText(el)).toBe('History compacted');
    });

    /**
     * An unknown value must not leave the host without a `state` attribute:
     * the degraded and in-flight treatments are attribute selectors, so a
     * missing attribute would paint a truncation as an ordinary compaction.
     */
    it('normalizes unknown trigger and state onto the reflected attributes', () => {
      const el = mount((e) => {
        e.setAttribute('trigger', 'wat');
        e.setAttribute('state', 'nope');
      });
      expect(el.getAttribute('trigger')).toBe('threshold');
      expect(el.getAttribute('state')).toBe('summarized');
    });
  });

  describe('derived copy', () => {
    it.each([
      ['idle', 'summarizing', 'Idle — compacting history in the background'],
      ['idle', 'summarized', 'Compacted while idle'],
      ['threshold', 'summarizing', 'Context filling up — compacting history'],
      ['threshold', 'summarized', 'History compacted'],
      ['overflow', 'summarizing', 'Context overflowed — compacting history'],
      ['overflow', 'summarized', 'Context overflowed — history compacted'],
    ] as const)('words a %s / %s round', (trigger, state, expected) => {
      const el = mount((e) => {
        e.trigger = trigger;
        e.state = state;
      });
      expect(labelText(el)).toBe(expected);
    });

    /** The degradation reads the same whatever started the round. */
    it.each(['idle', 'threshold', 'overflow'] as const)(
      'words a %s fallback as a truncation',
      (trigger) => {
        const el = mount((e) => {
          e.trigger = trigger;
          e.state = 'fallback';
        });
        expect(labelText(el)).toBe('Summary unavailable — older messages truncated');
      }
    );
  });

  describe('transcript link', () => {
    it('renders no link without a transcript path', () => {
      expect(pathButton(mount())).toBeNull();
    });

    it('shows the basename and keeps the full path as the title', () => {
      const el = mount((e) => {
        e.transcript = SNAPSHOT;
      });
      const button = pathButton(el);
      expect(button?.textContent).toBe('live-cone-mtlor6sy-8egf.md');
      expect(button?.getAttribute('title')).toBe(SNAPSHOT);
    });

    it('is a real button, so it is reachable from the keyboard', () => {
      const el = mount((e) => {
        e.transcript = SNAPSHOT;
      });
      expect(pathButton(el)?.tagName).toBe('BUTTON');
      expect(pathButton(el)?.type).toBe('button');
    });

    it('dispatches a composed, bubbling slicc-compaction-transcript with the path', () => {
      const el = mount((e) => {
        e.transcript = SNAPSHOT;
      });
      const seen: Array<{ path: string }> = [];
      // Listen on the document to prove the event escapes the shadow root.
      document.addEventListener('slicc-compaction-transcript', (e) => {
        seen.push((e as CustomEvent<{ path: string }>).detail);
      });
      pathButton(el)?.click();
      expect(seen).toEqual([{ path: SNAPSHOT }]);
    });

    it('re-binds the click after a re-render, firing once per click', () => {
      const el = mount((e) => {
        e.transcript = SNAPSHOT;
      });
      let count = 0;
      el.addEventListener('slicc-compaction-transcript', () => {
        count += 1;
      });
      // A state change rebuilds the shadow tree, so the button is a new node.
      el.state = 'fallback';
      pathButton(el)?.click();
      expect(count).toBe(1);
    });
  });

  describe('computed presentation', () => {
    it('lays the seam out as a flex row so the hairlines can fill', () => {
      const el = mount();
      expect(getComputedStyle(el).display).toBe('flex');
    });

    it('paints both flanking hairlines with a non-zero height', () => {
      const el = mount();
      for (const side of ['::before', '::after']) {
        const rule = getComputedStyle(el, side);
        expect(rule.content).not.toBe('none');
        expect(parseFloat(rule.height)).toBeGreaterThan(0);
      }
    });

    /**
     * The degraded chip must be visibly different from the ordinary one, or
     * the whole point of the state is lost. Compare resolved colors rather
     * than asserting a literal, so a token change does not break the test.
     */
    it('tints the fallback chip away from the summarized one', () => {
      const plain = mount((e) => {
        e.state = 'summarized';
      });
      const degraded = mount((e) => {
        e.state = 'fallback';
      });
      const chip = (el: SliccCompactionMarker) =>
        getComputedStyle(el.shadowRoot?.querySelector('[part="chip"]') as HTMLElement);
      expect(chip(degraded).color).not.toBe(chip(plain).color);
      expect(chip(degraded).backgroundColor).not.toBe(chip(plain).backgroundColor);
    });

    it('hides entirely when hidden', () => {
      const el = mount((e) => {
        e.hidden = true;
      });
      expect(getComputedStyle(el).display).toBe('none');
    });
  });
});
