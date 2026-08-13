import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { SliccAgentAvatar } from '../../src/switcher/slicc-agent-avatar.js';
import {
  arcDash,
  type ScoopDescriptor,
  type ScoopSelectDetail,
  SliccAgentTabs,
} from '../../src/switcher/slicc-agent-tabs.js';
import type { SliccScoopOverflow } from '../../src/switcher/slicc-scoop-overflow.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const ROSTER: ScoopDescriptor[] = [
  { key: 'cone', type: 'cone', color: '#b07823', label: 'Sliccy', eyes: 'open', fill: 38 },
  {
    key: 'researcher',
    type: 'scoop',
    color: '#06b6d4',
    label: 'Research',
    eyes: 'open',
    fill: 62,
    state: 'working',
  },
  {
    key: 'designer',
    color: '#8b5cf6',
    label: 'Design',
    eyes: 'open',
    fill: 46,
    state: 'idle',
  },
  {
    key: 'tester',
    color: '#f59e0b',
    label: 'Testing',
    eyes: 'dead',
    fill: 84,
    state: 'broken',
  },
  {
    key: 'triage',
    color: '#10b981',
    label: 'Triage',
    eyes: 'none',
    fill: 14,
    state: 'initializing',
    ephemeral: true,
  },
];

function mount(scoops: ScoopDescriptor[] = ROSTER, width = 720): SliccAgentTabs {
  const element = document.createElement('slicc-agent-tabs') as SliccAgentTabs;
  element.style.width = `${width}px`;
  element.scoops = scoops;
  document.body.append(element);
  return element;
}

function segments(element: SliccAgentTabs): HTMLButtonElement[] {
  return [...element.querySelectorAll<HTMLButtonElement>('.slicc-agent-tabs__segment')];
}

function segment(element: SliccAgentTabs, key: string): HTMLButtonElement {
  return segments(element).find((item) => item.dataset.k === key) as HTMLButtonElement;
}

function keydown(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function avatar(element: SliccAgentTabs): HTMLElement | null {
  return element.querySelector('.slicc-agent-tabs__focus-avatar');
}

function overflow(element: SliccAgentTabs): SliccScoopOverflow {
  return element.querySelector('slicc-scoop-overflow') as SliccScoopOverflow;
}

function glow(element: SliccAgentTabs, key: string): SVGCircleElement {
  return segment(element, key).querySelector('.slicc-agent-tabs__glyph-glow') as SVGCircleElement;
}

function rosterOf(count: number): ScoopDescriptor[] {
  return Array.from({ length: count }, (_, index) => ({
    key: index === 0 ? 'cone' : `scoop-${index}`,
    type: index === 0 ? ('cone' as const) : ('scoop' as const),
    label: index === 0 ? 'sliccy' : `agent-${index}`,
    state: 'idle' as const,
  }));
}

describe('slicc-agent-tabs', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers and renders into light DOM with scoped chrome', () => {
    const element = mount();
    expect(customElements.get('slicc-agent-tabs')).toBe(SliccAgentTabs);
    expect(element.shadowRoot).toBeNull();
    expect(element.classList.contains('slicc-agent-tabs')).toBe(true);
    expect(element.getAttribute('part')).toBe('row');
    expect(element.querySelector('[part="track"]')).toBeTruthy();
  });

  it('injects its light-DOM stylesheet only once', () => {
    mount();
    mount();
    expect(document.querySelectorAll('#slicc-agent-tabs-style')).toHaveLength(1);
  });

  it('renders avatar, segmented control, then the composed overflow tag', () => {
    const element = mount();
    expect([...element.children].map((child) => child.tagName.toLowerCase())).toEqual([
      'slicc-agent-avatar',
      'div',
    ]);
    expect(
      [...(element.querySelector('.slicc-agent-tabs__track-frame')?.children ?? [])].map((child) =>
        child.tagName.toLowerCase()
      )
    ).toEqual(['div', 'slicc-scoop-overflow']);
    expect(overflow(element).tagName.toLowerCase()).toBe('slicc-scoop-overflow');
  });

  it('round-trips scoops defensively and keeps every descriptor field', () => {
    const element = mount();
    expect(element.scoops[4]).toMatchObject({
      key: 'triage',
      ephemeral: true,
      state: 'initializing',
      fill: 14,
    });
    const copy = element.scoops;
    copy[0].label = 'changed';
    expect(element.scoops[0].label).toBe('Sliccy');
  });

  it('re-renders when scoops changes and clears on a non-array assignment', () => {
    const element = mount();
    element.scoops = [{ key: 'cone', label: 'Solo' }];
    expect(segments(element)).toHaveLength(1);
    expect(segment(element, 'cone').textContent).toContain('Solo');
    // @ts-expect-error exercising the defensive runtime guard.
    element.scoops = null;
    expect(segments(element)).toHaveLength(0);
    expect(avatar(element)).toBeNull();
  });

  describe('keyed reconciliation', () => {
    it('deduplicates descriptors by key with the first occurrence winning', () => {
      const element = mount([
        { key: 'cone', label: 'First cone' },
        { key: 'cone', label: 'Duplicate cone' },
        { key: 'researcher', label: 'Research' },
      ]);

      expect(element.scoops.map((scoop) => scoop.label)).toEqual(['First cone', 'Research']);
      expect(segments(element).map((item) => item.dataset.k)).toEqual(['cone', 'researcher']);
      expect(segments(element).filter((item) => item.tabIndex === 0)).toHaveLength(1);
      expect(
        segments(element).filter((item) => item.getAttribute('aria-selected') === 'true')
      ).toHaveLength(1);
    });

    it('removes pre-existing duplicate-key nodes without leaving orphans on later renders', () => {
      const element = mount([{ key: 'cone' }, { key: 'researcher' }]);
      const original = segment(element, 'cone');
      const orphan = original.cloneNode(true) as HTMLButtonElement;
      original.after(orphan);

      element.scoops = [{ key: 'cone' }, { key: 'researcher' }];
      element.attention = 'researcher';

      expect(segment(element, 'cone')).toBe(original);
      expect(orphan.isConnected).toBe(false);
      expect(segments(element).map((item) => item.dataset.k)).toEqual(['cone', 'researcher']);
    });

    it('reorders while adding and removing keys in the same update', () => {
      const element = mount([{ key: 'cone' }, { key: 'researcher' }, { key: 'designer' }]);
      const designer = segment(element, 'designer');

      element.scoops = [{ key: 'designer' }, { key: 'tester' }, { key: 'cone' }];

      expect(segments(element).map((item) => item.dataset.k)).toEqual([
        'designer',
        'tester',
        'cone',
      ]);
      expect(segment(element, 'designer')).toBe(designer);
      expect(segment(element, 'researcher')).toBeUndefined();
    });

    it('reconciles empty and single-scoop rosters with valid tab semantics', () => {
      const element = mount([]);
      expect(segments(element)).toHaveLength(0);

      element.scoops = [{ key: 'solo', label: 'Solo' }];
      expect(segments(element)).toHaveLength(1);
      expect(segment(element, 'solo').tabIndex).toBe(0);
      expect(segment(element, 'solo').getAttribute('aria-selected')).toBe('true');

      element.scoops = [];
      expect(segments(element)).toHaveLength(0);
      expect(avatar(element)).toBeNull();
    });
  });

  it('reflects active, attention, and connection properties to attributes', () => {
    const element = mount();
    element.active = 'researcher';
    element.attention = 'designer';
    element.connection = 'disconnected';
    expect(element.getAttribute('active')).toBe('researcher');
    expect(element.getAttribute('attention')).toBe('designer');
    expect(element.getAttribute('connection')).toBe('disconnected');
    expect(avatar(element)?.getAttribute('connection')).toBe('disconnected');
    element.connection = 'connected';
    expect(avatar(element)?.getAttribute('connection')).toBe('connected');
    element.active = null;
    element.attention = null;
    expect(element.hasAttribute('active')).toBe(false);
    expect(element.hasAttribute('attention')).toBe(false);
  });

  it('focuses the first descriptor by default and updates avatar + selected segment', () => {
    const element = mount();
    expect(avatar(element)?.getAttribute('type')).toBe('cone');
    expect(avatar(element)?.getAttribute('role')).toBe('img');
    expect(segment(element, 'cone').getAttribute('aria-selected')).toBe('true');
    element.active = 'researcher';
    expect(avatar(element)?.getAttribute('type')).toBe('scoop');
    expect(avatar(element)?.getAttribute('color')).toBe('#06b6d4');
    expect(avatar(element)?.getAttribute('fill')).toBe('62');
    expect(avatar(element)?.hasAttribute('blink')).toBe(true);
    expect(segment(element, 'researcher').getAttribute('aria-selected')).toBe('true');
  });

  it('falls back to the first descriptor when active does not exist', () => {
    const element = mount();
    element.active = 'missing';
    expect(avatar(element)?.getAttribute('aria-label')).toBe('Sliccy focused agent');
    expect(segment(element, 'cone').getAttribute('aria-selected')).toBe('true');
  });

  it('carries data-k, labels, ephemeral state, and per-key hues on segments', () => {
    const element = mount();
    expect(segment(element, 'designer').dataset.k).toBe('designer');
    expect(segment(element, 'designer').style.getPropertyValue('--slicc-agent-tabs-hue')).toBe(
      'var(--violet)'
    );
    expect(segment(element, 'triage').classList.contains('ephemeral')).toBe(true);
    expect(segment(element, 'tester').getAttribute('aria-label')).toContain('84% context fill');
  });

  it('uses a supplied color as the hue for unknown keys and rose as the final fallback', () => {
    const element = mount([{ key: 'custom', color: '#123456' }, { key: 'fallback' }]);
    expect(segment(element, 'custom').style.getPropertyValue('--slicc-agent-tabs-hue')).toBe(
      '#123456'
    );
    expect(segment(element, 'fallback').style.getPropertyValue('--slicc-agent-tabs-hue')).toBe(
      'var(--rose)'
    );
  });

  describe('status glyphs and fullness arcs', () => {
    /** Whether a segment's circle / square centre pin is currently painted. */
    function pins(element: SliccAgentTabs, key: string): { circle: boolean; square: boolean } {
      const seg = segment(element, key);
      const shown = (selector: string): boolean =>
        getComputedStyle(seg.querySelector(selector) as SVGElement).display !== 'none';
      return {
        circle: shown('.slicc-agent-tabs__glyph-pin'),
        square: shown('.slicc-agent-tabs__glyph-pin-square'),
      };
    }

    it('maps idle and working to arcs, with a centre pin only for working', () => {
      const element = mount();
      expect(
        segment(element, 'designer').querySelector('.slicc-agent-tabs__glyph-arc')
      ).toBeTruthy();
      expect(pins(element, 'designer')).toEqual({ circle: false, square: false });
      expect(
        segment(element, 'researcher').querySelector('.slicc-agent-tabs__glyph-arc')
      ).toBeTruthy();
      expect(
        segment(element, 'researcher').querySelector('.slicc-agent-tabs__glyph-pin')
      ).toBeTruthy();
      // Working always paints exactly one pin — which one is the phase's job.
      const working = pins(element, 'researcher');
      expect(working.circle !== working.square).toBe(true);
    });

    it('shapes the working pin by phase: square for thinking, circle for a tool call', () => {
      const element = mount([
        { key: 'thinker', label: 'Thinker', state: 'working', phase: 'thinking' },
        { key: 'runner', label: 'Runner', state: 'working', phase: 'tool' },
      ]);
      expect(pins(element, 'thinker')).toEqual({ circle: false, square: true });
      expect(pins(element, 'runner')).toEqual({ circle: true, square: false });
      expect(segment(element, 'thinker').dataset.phase).toBe('thinking');
      expect(segment(element, 'runner').dataset.phase).toBe('tool');
    });

    it('defaults an unset phase to thinking (a turn opens in LLM-wait)', () => {
      const element = mount([{ key: 'bare', label: 'Bare', state: 'working' }]);
      expect(pins(element, 'bare')).toEqual({ circle: false, square: true });
      expect(segment(element, 'bare').dataset.phase).toBe('thinking');
    });

    it('carries no phase attribute unless the agent is working', () => {
      const element = mount([
        { key: 'idle', label: 'Idle', state: 'idle', phase: 'tool' },
        { key: 'broken', label: 'Broken', state: 'broken', phase: 'tool' },
      ]);
      expect(segment(element, 'idle').hasAttribute('data-phase')).toBe(false);
      expect(segment(element, 'broken').hasAttribute('data-phase')).toBe(false);
      expect(pins(element, 'idle')).toEqual({ circle: false, square: false });
    });

    it('repaints the pin in place when a live segment flips phase', () => {
      const element = mount([{ key: 'busy', label: 'Busy', state: 'working', phase: 'thinking' }]);
      const before = segment(element, 'busy');
      element.scoops = [{ key: 'busy', label: 'Busy', state: 'working', phase: 'tool' }];
      // Reconciled, not rebuilt — the segment identity must survive so focus
      // and the running arc animation are not reset mid-turn.
      expect(segment(element, 'busy')).toBe(before);
      expect(pins(element, 'busy')).toEqual({ circle: true, square: false });
    });

    it('names the busy detail in the accessible label', () => {
      const element = mount([
        { key: 'thinker', label: 'Thinker', state: 'working', phase: 'thinking', fill: 10 },
        { key: 'runner', label: 'Runner', state: 'working', phase: 'tool', fill: 10 },
        { key: 'idle', label: 'Idle', state: 'idle', fill: 10 },
      ]);
      expect(segment(element, 'thinker').getAttribute('aria-label')).toContain(
        'working (thinking)'
      );
      expect(segment(element, 'runner').getAttribute('aria-label')).toContain(
        'working (running a tool)'
      );
      expect(segment(element, 'idle').getAttribute('aria-label')).not.toContain('(');
    });

    it('maps broken to an X and initializing to a dashed ring while hiding their arcs', () => {
      const element = mount();
      expect(
        segment(element, 'tester').querySelectorAll('.slicc-agent-tabs__broken-x')
      ).toHaveLength(2);
      expect(
        getComputedStyle(
          segment(element, 'tester').querySelector('.slicc-agent-tabs__glyph-arc') as SVGElement
        ).display
      ).toBe('none');
      expect(
        segment(element, 'triage').querySelector('.slicc-agent-tabs__initializing-ring')
      ).toBeTruthy();
      expect(
        getComputedStyle(
          segment(element, 'triage').querySelector('.slicc-agent-tabs__glyph-arc') as SVGElement
        ).display
      ).toBe('none');
    });

    it('derives legacy state from dead eyes and attention when state is omitted', async () => {
      const element = mount([
        { key: 'cone', eyes: 'open' },
        { key: 'busy', eyes: 'open' },
        { key: 'failed', eyes: 'dead' },
      ]);
      element.attention = 'busy';
      expect(segment(element, 'cone').dataset.state).toBe('idle');
      expect(segment(element, 'busy').dataset.state).toBe('working');
      expect(segment(element, 'failed').dataset.state).toBe('broken');
      await vi.waitFor(() => expect(getComputedStyle(glow(element, 'busy')).opacity).toBe('0.72'));
      expect(
        getComputedStyle(
          segment(element, 'busy').querySelector('.slicc-agent-tabs__glyph-arc') as SVGCircleElement
        ).animationPlayState
      ).toBe('running');
    });

    it('cross-fades the ring glow when the most-recent speaker moves', async () => {
      const element = mount([{ key: 'cone' }, { key: 'paused', state: 'idle' }]);
      element.attention = 'paused';
      const coneGlow = glow(element, 'cone');
      const pausedGlow = glow(element, 'paused');
      expect(segment(element, 'paused').dataset.state).toBe('idle');
      expect(segment(element, 'paused').dataset.attention).toBe('true');
      expect(segment(element, 'paused').getAttribute('aria-label')).toContain(
        'spoke most recently'
      );
      expect(segment(element, 'cone').hasAttribute('data-attention')).toBe(false);
      expect(getComputedStyle(pausedGlow).transitionProperty).toContain('opacity');
      await vi.waitFor(() => {
        expect(getComputedStyle(pausedGlow).opacity).toBe('0.72');
        expect(getComputedStyle(coneGlow).opacity).toBe('0');
      });

      element.attention = 'cone';
      expect(segment(element, 'paused').hasAttribute('data-attention')).toBe(false);
      expect(segment(element, 'paused').getAttribute('aria-label')).not.toContain(
        'spoke most recently'
      );
      expect(segment(element, 'cone').dataset.attention).toBe('true');
      expect(glow(element, 'paused')).toBe(pausedGlow);
      expect(glow(element, 'cone')).toBe(coneGlow);
      expect(getComputedStyle(pausedGlow).opacity).toBe('0.72');
      expect(getComputedStyle(coneGlow).opacity).toBe('0');
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(Number.parseFloat(getComputedStyle(pausedGlow).opacity)).toBeGreaterThan(0);
      expect(Number.parseFloat(getComputedStyle(pausedGlow).opacity)).toBeLessThan(0.72);
      expect(Number.parseFloat(getComputedStyle(coneGlow).opacity)).toBeGreaterThan(0);
      expect(Number.parseFloat(getComputedStyle(coneGlow).opacity)).toBeLessThan(0.72);

      await vi.waitFor(() => {
        expect(getComputedStyle(pausedGlow).opacity).toBe('0');
        expect(getComputedStyle(coneGlow).opacity).toBe('0.72');
      });
    });

    it('renders attention as a layout-neutral ring glow over broken and selected states', async () => {
      const element = mount([{ key: 'cone' }, { key: 'failed', state: 'broken', eyes: 'dead' }]);
      element.active = 'failed';
      const failed = segment(element, 'failed');
      const before = failed.getBoundingClientRect();

      element.attention = 'failed';
      const attentionStyle = getComputedStyle(failed);
      const after = failed.getBoundingClientRect();
      await vi.waitFor(() =>
        expect(getComputedStyle(glow(element, 'failed')).opacity).toBe('0.72')
      );
      const glowStyle = getComputedStyle(glow(element, 'failed'));

      expect(failed.dataset.state).toBe('broken');
      expect(failed.getAttribute('aria-selected')).toBe('true');
      expect(attentionStyle.outlineStyle).toBe('none');
      expect(attentionStyle.boxShadow).not.toBe('none');
      expect(glowStyle.opacity).toBe('0.72');
      expect(glowStyle.filter).not.toBe('none');
      expect(after.width).toBeCloseTo(before.width);
      expect(after.height).toBeCloseTo(before.height);
      const style = document.querySelector('#slicc-agent-tabs-style') as HTMLStyleElement;
      expect(style.textContent).not.toContain('--slicc-agent-tabs-attention-outline');
      expect(style.textContent).not.toContain('@keyframes slicc-agent-tabs-attention');
    });

    it('maps 0/25/50/75/100 fullness to a 90°–360° sweep', () => {
      const circumference = 2 * Math.PI * 5;
      expect(arcDash(0)).toBeCloseTo(circumference * 0.25);
      expect(arcDash(25)).toBeCloseTo(circumference * (157.5 / 360));
      expect(arcDash(50)).toBeCloseTo(circumference * (225 / 360));
      expect(arcDash(75)).toBeCloseTo(circumference * (292.5 / 360));
      expect(arcDash(100)).toBeCloseTo(circumference);
    });

    it('clamps non-finite and out-of-range fullness', () => {
      expect(arcDash(-20)).toBeCloseTo(arcDash(0));
      expect(arcDash(200)).toBeCloseTo(arcDash(100));
      expect(arcDash(Number.NaN)).toBeCloseTo(arcDash(0));
      const element = mount([{ key: 'cone', fill: 200 }]);
      expect(avatar(element)?.getAttribute('fill')).toBe('100');
    });

    it('writes the calculated dash length into the SVG arc', () => {
      const element = mount([{ key: 'cone', fill: 50, state: 'idle' }]);
      const arc = segment(element, 'cone').querySelector('.slicc-agent-tabs__glyph-arc');
      element.scoops = [{ key: 'cone', fill: 75, state: 'idle' }];
      const updated = segment(element, 'cone').querySelector('.slicc-agent-tabs__glyph-arc');
      expect(updated).toBe(arc);
      expect(updated?.getAttribute('stroke-dasharray')).toBe(
        `${arcDash(75).toFixed(3)} ${(2 * Math.PI * 5).toFixed(3)}`
      );
    });

    it('preserves arc identity and pauses or resumes its continuous animation by state', () => {
      const element = mount([{ key: 'cone', fill: 50, state: 'working' }]);
      const segmentBefore = segment(element, 'cone');
      const arcBefore = segmentBefore.querySelector(
        '.slicc-agent-tabs__glyph-arc'
      ) as SVGCircleElement;
      expect(getComputedStyle(arcBefore).animationPlayState).toBe('running');

      element.scoops = [{ key: 'cone', fill: 50, state: 'idle' }];
      const segmentAfter = segment(element, 'cone');
      const arcAfter = segmentAfter.querySelector(
        '.slicc-agent-tabs__glyph-arc'
      ) as SVGCircleElement;
      expect(segmentAfter).toBe(segmentBefore);
      expect(arcAfter).toBe(arcBefore);
      expect(getComputedStyle(arcAfter).animationPlayState).toBe('paused');

      element.scoops = [{ key: 'cone', fill: 50, state: 'working' }];
      expect(segment(element, 'cone').querySelector('.slicc-agent-tabs__glyph-arc')).toBe(
        arcBefore
      );
      expect(getComputedStyle(arcBefore).animationPlayState).toBe('running');
    });

    it('initially writes the calculated dash length into the SVG arc', () => {
      const element = mount([{ key: 'cone', fill: 50, state: 'idle' }]);
      const arc = segment(element, 'cone').querySelector('.slicc-agent-tabs__glyph-arc');
      expect(arc?.getAttribute('stroke-dasharray')).toBe(
        `${arcDash(50).toFixed(3)} ${(2 * Math.PI * 5).toFixed(3)}`
      );
    });

    it('keeps a static attention glow and fullness sweep under reduced motion', () => {
      mount();
      const style = document.querySelector('#slicc-agent-tabs-style') as HTMLStyleElement;
      const media = [...(style.sheet?.cssRules ?? [])].find(
        (rule): rule is CSSMediaRule =>
          rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion')
      );
      expect(media).toBeDefined();
      const reducedArcRule = [...(media?.cssRules ?? [])].find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText.includes('__glyph-arc')
      );
      const reducedGlowRule = [...(media?.cssRules ?? [])].find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText.includes('__glyph-glow')
      );
      const attentionRule = [...(style.sheet?.cssRules ?? [])].find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText.includes('[data-attention=')
      );
      expect(reducedArcRule?.style.animationName).toBe('none');
      expect(reducedArcRule?.style.transform).toBe('rotate(-90deg)');
      expect(reducedGlowRule?.style.transitionProperty).toBe('none');
      expect(attentionRule?.style.opacity).toBe('0.72');
    });
  });

  describe('selection', () => {
    it('emits the compatible payload and updates active when a segment is clicked', () => {
      const element = mount();
      const listener = vi.fn();
      element.addEventListener('slicc-scoop-select', (event) =>
        listener((event as CustomEvent<ScoopSelectDetail>).detail)
      );
      segment(element, 'designer').click();
      expect(element.active).toBe('designer');
      expect(listener).toHaveBeenCalledWith({ id: 'designer', key: 'designer', label: 'Design' });
    });

    it('select() bubbles a composed event and falls back to the key as label', () => {
      const element = mount();
      const listener = vi.fn();
      document.body.addEventListener('slicc-scoop-select', listener);
      element.select('unknown');
      const event = listener.mock.calls[0][0] as CustomEvent<ScoopSelectDetail>;
      expect(event.detail).toEqual({ id: 'unknown', key: 'unknown', label: 'unknown' });
      expect(event.bubbles).toBe(true);
      expect(event.composed).toBe(true);
      document.body.removeEventListener('slicc-scoop-select', listener);
    });
  });

  describe('tablist keyboard navigation', () => {
    it('keeps only the selected segment in the tab order', () => {
      const element = mount();
      element.active = 'designer';
      expect(segments(element).map((item) => item.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
      expect(segment(element, 'designer').getAttribute('aria-selected')).toBe('true');
    });

    it('moves focus with arrows and Home/End, wrapping without automatic activation', () => {
      const element = mount();
      segment(element, 'cone').focus();

      expect(keydown(segment(element, 'cone'), 'ArrowRight').defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(segment(element, 'researcher'));
      expect(element.active).toBeNull();
      expect(segment(element, 'cone').getAttribute('aria-selected')).toBe('true');
      expect(segment(element, 'researcher').getAttribute('aria-selected')).toBe('false');

      expect(keydown(segment(element, 'researcher'), 'PageDown').defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(segment(element, 'researcher'));

      keydown(segment(element, 'researcher'), 'End');
      expect(document.activeElement).toBe(segment(element, 'triage'));
      keydown(segment(element, 'triage'), 'Home');
      expect(document.activeElement).toBe(segment(element, 'cone'));
      keydown(segment(element, 'cone'), 'ArrowLeft');
      expect(document.activeElement).toBe(segment(element, 'triage'));
      keydown(segment(element, 'triage'), 'ArrowRight');
      expect(document.activeElement).toBe(segment(element, 'cone'));
    });

    it('manually activates the focused segment with Enter or Space', () => {
      const element = mount();
      const listener = vi.fn();
      element.addEventListener('slicc-scoop-select', listener);

      segment(element, 'researcher').focus();
      keydown(segment(element, 'researcher'), 'Enter');
      expect(element.active).toBe('researcher');
      expect(document.activeElement).toBe(segment(element, 'researcher'));
      expect(segment(element, 'researcher').tabIndex).toBe(0);
      expect(segment(element, 'researcher').getAttribute('aria-selected')).toBe('true');

      segment(element, 'designer').focus();
      keydown(segment(element, 'designer'), ' ');
      expect(element.active).toBe('designer');
      expect(document.activeElement).toBe(segment(element, 'designer'));
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('preserves focus and segment identity across a scoops reconciliation', () => {
      const element = mount();
      const before = segment(element, 'designer');
      before.focus();
      element.scoops = ROSTER.map((scoop) =>
        scoop.key === 'researcher' ? { ...scoop, state: 'idle' } : scoop
      );
      const after = segment(element, 'designer');
      expect(after).toBe(before);
      expect(document.activeElement).toBe(after);
      expect(segment(element, 'cone').getAttribute('aria-selected')).toBe('true');
    });

    it('focuses the selected fallback when the focused scoop disappears', () => {
      const element = mount();
      segment(element, 'designer').focus();
      element.scoops = ROSTER.filter((scoop) => scoop.key !== 'designer');
      expect(document.activeElement).toBe(segment(element, 'cone'));
      expect(segment(element, 'cone').getAttribute('aria-selected')).toBe('true');
    });

    it('keeps the decorative avatar outside the tab order and the overflow trigger reachable', () => {
      const element = mount(ROSTER, 180);
      element.reflow();
      const overflowButton = overflow(element).shadowRoot?.querySelector(
        '.morebtn'
      ) as HTMLButtonElement;

      expect(avatar(element)?.tabIndex).toBe(-1);
      expect(avatar(element)?.getAttribute('role')).toBe('img');
      expect(overflowButton.tabIndex).toBe(0);
      expect(overflowButton.getAttribute('role')).not.toBe('tab');
      overflowButton.focus();
      expect(overflow(element).shadowRoot?.activeElement).toBe(overflowButton);
    });
  });

  describe('focused avatar tracking', () => {
    function mountFocused(key: string, scoops: ScoopDescriptor[] = ROSTER): SliccAgentTabs {
      const element = document.createElement('slicc-agent-tabs') as SliccAgentTabs;
      element.style.width = '720px';
      element.scoops = scoops;
      element.active = key;
      document.body.append(element);
      return element;
    }

    it('restores inferred scoop identity and returns cleanly to the cone', () => {
      const element = mountFocused('designer');
      const focused = avatar(element) as HTMLElement;

      expect(focused.getAttribute('type')).toBe('scoop');
      expect(focused.getAttribute('color')).toBe('#8b5cf6');
      expect(focused.getAttribute('eyes')).toBe('open');
      expect(focused.shadowRoot?.querySelector('.glyph path')?.getAttribute('fill')).toBe(
        '#8b5cf6'
      );

      element.active = 'cone';
      expect(avatar(element)).toBe(focused);
      expect(focused.getAttribute('type')).toBe('cone');
      expect(focused.getAttribute('color')).toBe('#b07823');
      expect(focused.getAttribute('eyes')).toBe('open');
    });

    /** Only a running tool call keeps the pointer channel; the other activities own the gaze. */
    function toolRoster(): ScoopDescriptor[] {
      return ROSTER.map((scoop) =>
        scoop.key === 'researcher' ? { ...scoop, state: 'working', phase: 'tool' } : scoop
      );
    }

    it('tracks the focused scoop with one listener and fill-derived pupils', () => {
      const add = vi.spyOn(document, 'addEventListener');
      const element = mountFocused('researcher', toolRoster());
      const focused = avatar(element) as HTMLElement;
      const pupil = focused.shadowRoot?.querySelector('.pupil-l') as SVGGElement;
      const pupilRect = pupil.querySelector('rect') as SVGRectElement;

      expect(focused.getAttribute('type')).toBe('scoop');
      expect(Number(pupilRect.getAttribute('width')) / 2).toBeCloseTo(
        18 * (1 + (12 / 35) * 1.2),
        2
      );
      expect(add.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(1);

      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1200, clientY: 40 }));
      expect(pupil.getAttribute('transform')).not.toBe('translate(0,0)');
      add.mockRestore();
    });

    it('leaves the pointer alone for the self-directed activities', () => {
      const add = vi.spyOn(document, 'addEventListener');
      // researcher is `working` with no phase → thinking → saccades, not the pointer.
      const element = mountFocused('researcher');
      expect(avatar(element)?.getAttribute('activity')).toBe('thinking');
      expect(add.mock.calls.some(([type]) => type === 'pointermove')).toBe(false);

      element.active = 'designer';
      expect(avatar(element)?.getAttribute('activity')).toBe('idle');
      expect(add.mock.calls.some(([type]) => type === 'pointermove')).toBe(false);
      add.mockRestore();
    });

    it('maps every lifecycle onto the avatar activity channel', () => {
      const element = mountFocused('researcher', toolRoster());
      expect(avatar(element)?.getAttribute('activity')).toBe('working');

      element.active = 'triage';
      expect(avatar(element)?.hasAttribute('activity')).toBe(false);

      element.active = 'tester';
      expect(avatar(element)?.getAttribute('eyes')).toBe('dead');
      expect(avatar(element)?.hasAttribute('activity')).toBe(false);
    });

    it('promotes an awaiting scoop out of idle and forwards the gaze target', () => {
      const element = mountFocused('designer');
      element.gazeTarget = '#composer';
      expect(avatar(element)?.getAttribute('activity')).toBe('idle');
      expect(avatar(element)?.getAttribute('gaze-target')).toBe('#composer');

      element.scoops = ROSTER.map((scoop) =>
        scoop.key === 'designer' ? { ...scoop, awaiting: true } : scoop
      );
      expect(avatar(element)?.getAttribute('activity')).toBe('awaiting');
    });

    it('forwards the expression transients to the focused avatar', () => {
      const element = mountFocused('designer');
      const focused = avatar(element) as SliccAgentAvatar;

      element.scrutinize();
      expect(focused.expression.lidBottom).toBeGreaterThanOrEqual(0);
      element.glower();
      element.wake();
      // The forwarding contract: the tabs never reach past the avatar's public API.
      expect(typeof focused.scrutinize).toBe('function');
      expect(typeof focused.glower).toBe('function');
      expect(typeof focused.wake).toBe('function');
    });

    it('never binds pointer tracking for dead eyes', () => {
      const add = vi.spyOn(document, 'addEventListener');
      const element = mountFocused('tester');
      expect(avatar(element)?.getAttribute('eyes')).toBe('dead');
      expect(add.mock.calls.some(([type]) => type === 'pointermove')).toBe(false);
      add.mockRestore();
    });

    it('removes the pointer listener when disconnected', () => {
      const add = vi.spyOn(document, 'addEventListener');
      const remove = vi.spyOn(document, 'removeEventListener');
      const element = mountFocused('researcher', toolRoster());
      const listener = add.mock.calls.find(([type]) => type === 'pointermove')?.[1];

      element.remove();

      expect(listener).toBeDefined();
      expect(remove).toHaveBeenCalledWith('pointermove', listener);
      add.mockRestore();
      remove.mockRestore();
    });

    it('does not bind pointer tracking when reduced motion is requested', () => {
      const realMatchMedia = window.matchMedia;
      const add = vi.spyOn(document, 'addEventListener');
      window.matchMedia = vi.fn().mockReturnValue({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as typeof window.matchMedia;
      try {
        mountFocused('researcher', toolRoster());
        expect(add.mock.calls.some(([type]) => type === 'pointermove')).toBe(false);
      } finally {
        window.matchMedia = realMatchMedia;
        add.mockRestore();
      }
    });

    it('stops tracking and recentres pupils when reduced motion changes', () => {
      const realMatchMedia = window.matchMedia;
      let motionListener: EventListener | undefined;
      const query = {
        matches: false,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: vi.fn((_type: string, listener: EventListener) => {
          motionListener = listener;
        }),
        removeEventListener: vi.fn(),
      };
      window.matchMedia = vi.fn().mockReturnValue(query) as typeof window.matchMedia;
      try {
        const element = mountFocused('researcher', toolRoster());
        const pupil = avatar(element)?.shadowRoot?.querySelector('.pupil-l') as SVGGElement;
        document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1200, clientY: 40 }));
        expect(pupil.getAttribute('transform')).not.toBe('translate(0,0)');

        query.matches = true;
        motionListener?.(new Event('change'));
        expect(pupil.getAttribute('transform')).toBe('translate(0,0)');
      } finally {
        window.matchMedia = realMatchMedia;
      }
    });

    it('keeps the avatar footprint fixed at 26px', () => {
      const element = mountFocused('researcher');
      const bounds = (avatar(element) as HTMLElement).getBoundingClientRect();
      expect(bounds.width).toBe(26);
      expect(bounds.height).toBe(26);
    });
  });

  describe('overflow reflow', () => {
    it('sizes a one-tab frame to its tab without reserving an overflow footprint', () => {
      const element = mount(rosterOf(1), 720);
      element.reflow();
      const frame = element.querySelector('.slicc-agent-tabs__track-frame') as HTMLElement;
      const track = element.querySelector('.slicc-agent-tabs__track') as HTMLElement;
      const tabWidth = segment(element, 'cone').getBoundingClientRect().width;
      const trackStyle = getComputedStyle(track);
      const frameStyle = getComputedStyle(frame);
      const expectedWidth =
        tabWidth +
        Number.parseFloat(trackStyle.paddingLeft) +
        Number.parseFloat(trackStyle.paddingRight) +
        Number.parseFloat(frameStyle.borderLeftWidth) +
        Number.parseFloat(frameStyle.borderRightWidth);

      expect(frame.getBoundingClientRect().width).toBeCloseTo(expectedWidth, 1);
      expect(trackStyle.paddingRight).toBe('2px');
      expect(frame.getBoundingClientRect().width).toBeLessThan(element.clientWidth / 2);
    });

    it.each([1, 2, 6, 12])(
      'reaches the same overflow fixed point across forced reflows for %i scoops',
      (count) => {
        const element = mount(rosterOf(count), 220);
        const states = Array.from({ length: 4 }, () => {
          element.reflow();
          return {
            overflow: element.classList.contains('has-overflow'),
            hidden: segments(element).filter((item) => item.classList.contains('hide')).length,
            items: overflow(element).items.length,
          };
        });
        expect(states.slice(1)).toEqual([states[0], states[0], states[0]]);
        expect(states[0].hidden).toBe(states[0].items);
      }
    );

    it('keeps the DOM and arithmetic overflow reserves in the same state', () => {
      const element = mount(rosterOf(1), 220);
      const track = element.querySelector('.slicc-agent-tabs__track') as HTMLElement;
      element.reflow();
      expect(element.classList.contains('has-overflow')).toBe(false);
      expect(getComputedStyle(track).paddingRight).toBe('2px');

      element.scoops = rosterOf(12);
      element.reflow();
      expect(element.classList.contains('has-overflow')).toBe(true);
      expect(getComputedStyle(track).paddingRight).toBe('41px');
    });

    it('never reserves overflow space when the non-hideable first tab is the only tab', () => {
      const element = mount(rosterOf(1), 40);
      const track = element.querySelector('.slicc-agent-tabs__track') as HTMLElement;
      const toggle = vi.spyOn(element.classList, 'toggle');

      element.reflow();

      expect(toggle).not.toHaveBeenCalledWith('has-overflow', true);
      expect(element.classList.contains('has-overflow')).toBe(false);
      expect(overflow(element).items).toHaveLength(0);
      expect(getComputedStyle(track).paddingRight).toBe('2px');
      toggle.mockRestore();
    });

    it('settles at every pixel across the fit boundary and keeps tabs clear of the trigger', () => {
      const element = mount(rosterOf(6), 200);
      const track = element.querySelector('.slicc-agent-tabs__track') as HTMLElement;
      const trigger = overflow(element).shadowRoot?.querySelector('[part="more"]') as HTMLElement;
      const visited = new Set<boolean>();

      for (let width = 200; width <= 560; width += 1) {
        element.style.width = `${width}px`;
        const states = Array.from({ length: 4 }, () => {
          element.reflow();
          return {
            overflow: element.classList.contains('has-overflow'),
            hidden: segments(element)
              .filter((item) => item.classList.contains('hide'))
              .map((item) => item.dataset.k),
            items: overflow(element).items.length,
            paddingRight: getComputedStyle(track).paddingRight,
          };
        });
        expect(states.slice(1), `reflow alternated at ${width}px`).toEqual([
          states[0],
          states[0],
          states[0],
        ]);
        visited.add(states[0].overflow);
        expect(states[0].items > 0).toBe(states[0].overflow);
        expect(states[0].paddingRight).toBe(states[0].overflow ? '41px' : '2px');
        if (states[0].overflow) {
          const visible = segments(element).filter((item) => !item.classList.contains('hide'));
          expect(visible.at(-1)?.getBoundingClientRect().right).toBeLessThanOrEqual(
            trigger.getBoundingClientRect().left
          );
        }
      }

      expect(visited).toEqual(new Set([true, false]));
    });

    it('uses the rendered sliccy width as its floor and ellipsizes long labels at the ceiling', () => {
      const element = mount(rosterOf(1));
      element.reflow();
      const sliccy = segment(element, 'cone');
      const style = getComputedStyle(sliccy);
      const context = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
      context.font = style.font;
      const expectedFloor =
        Math.ceil(
          context.measureText('sliccy').width +
            14 +
            Number.parseFloat(style.columnGap) +
            Number.parseFloat(style.paddingLeft) +
            Number.parseFloat(style.paddingRight)
        ) + 4;
      expect(sliccy.getBoundingClientRect().width).toBeCloseTo(expectedFloor, 1);
      expect(sliccy.getBoundingClientRect().width).toBeLessThan(72);

      const long = mount([
        { key: 'cone', type: 'cone', label: 'a very long agent label that must truncate' },
      ]);
      long.reflow();
      const longSegment = segment(long, 'cone');
      const label = longSegment.querySelector('.slicc-agent-tabs__label') as HTMLElement;
      expect(longSegment.getBoundingClientRect().width).toBeLessThanOrEqual(160);
      expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
      expect(getComputedStyle(label).textOverflow).toBe('ellipsis');
    });

    it('centres the clickable overflow trigger on the track frame', () => {
      const element = mount(rosterOf(6), 220);
      element.reflow();
      const frame = element.querySelector('.slicc-agent-tabs__track-frame') as HTMLElement;
      const trigger = overflow(element).shadowRoot?.querySelector('[part="more"]') as HTMLElement;
      const frameRect = frame.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const centreDelta = Math.abs(
        (frameRect.top + frameRect.bottom - triggerRect.top - triggerRect.bottom) / 2
      );
      expect(centreDelta).toBeLessThanOrEqual(1);
    });

    it('fits an unellipsized sliccy tab and overflow trigger in a real 360px viewport', async () => {
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      try {
        await page.viewport(360, originalViewport.height);
        expect(window.innerWidth).toBe(360);
        const element = mount(rosterOf(12), 360);
        element.reflow();
        const sliccy = segment(element, 'cone');
        const label = sliccy.querySelector('.slicc-agent-tabs__label') as HTMLElement;
        const frame = element.querySelector('.slicc-agent-tabs__track-frame') as HTMLElement;
        const focusedAvatar = avatar(element) as HTMLElement;
        const trigger = overflow(element).shadowRoot?.querySelector('[part="more"]') as HTMLElement;
        const sliccyRect = sliccy.getBoundingClientRect();
        const frameRect = frame.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        expect(element.clientWidth).toBe(360);
        expect(frameRect.width).toBeCloseTo(
          element.clientWidth -
            focusedAvatar.getBoundingClientRect().width -
            Number.parseFloat(getComputedStyle(element).columnGap),
          1
        );
        expect(triggerRect.width).toBeCloseTo(39, 1);
        expect(triggerRect.height).toBeCloseTo(24, 1);
        expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
        expect(sliccyRect.right).toBeLessThanOrEqual(triggerRect.left);
        expect(triggerRect.right).toBeLessThanOrEqual(frameRect.right);
      } finally {
        await page.viewport(originalViewport.width, originalViewport.height);
      }
    });

    it('hides a trailing contiguous set, never the cone, and reserves overflow room', () => {
      const element = mount(ROSTER, 250);
      element.reflow();
      const hidden = segments(element).filter((item) => item.classList.contains('hide'));
      expect(segment(element, 'cone').classList.contains('hide')).toBe(false);
      expect(hidden.length).toBeGreaterThan(0);
      expect(overflow(element).items).toHaveLength(hidden.length);
      expect(element.classList.contains('has-overflow')).toBe(true);
      expect(hidden.map((item) => item.dataset.k)).toEqual(
        segments(element)
          .slice(segments(element).length - hidden.length)
          .map((item) => item.dataset.k)
      );
    });

    it('feeds hidden descriptors through the composed tag with state and fill', () => {
      const element = mount(ROSTER, 180);
      element.reflow();
      const items = overflow(element).items as Array<{
        id: string;
        state?: string;
        fill?: number;
        eyes?: string;
      }>;
      expect(items.length).toBeGreaterThan(0);
      expect(items.find((item) => item.id === 'tester')).toMatchObject({
        state: 'broken',
        fill: 84,
        eyes: 'dead',
      });
    });

    it('restores every segment and clears overflow when widened', () => {
      const element = mount(ROSTER, 180);
      element.reflow();
      expect(overflow(element).items.length).toBeGreaterThan(0);
      element.style.width = '1000px';
      element.reflow();
      expect(segments(element).some((item) => item.classList.contains('hide'))).toBe(false);
      expect(overflow(element).items).toHaveLength(0);
      expect(element.classList.contains('has-overflow')).toBe(false);
    });

    it('re-emits an actual overflow row click with the canonical key payload', () => {
      const element = mount(ROSTER, 180);
      element.reflow();
      const item = overflow(element).items[0];
      const listener = vi.fn();
      element.addEventListener('slicc-scoop-select', (event) =>
        listener((event as CustomEvent<ScoopSelectDetail>).detail)
      );
      const overflowButton = overflow(element).shadowRoot?.querySelector(
        '.morebtn'
      ) as HTMLButtonElement;
      const overflowRow = overflow(element).shadowRoot?.querySelector(
        '.popup-row'
      ) as HTMLButtonElement;
      overflowButton.click();
      expect(overflow(element).open).toBe(true);
      overflowRow.click();
      expect(listener).toHaveBeenCalledWith({ id: item.id, key: item.id, label: item.label });
      expect(element.active).toBe(item.id);
      expect(overflow(element).open).toBe(false);
    });

    it('shows no overflow when the host is not laid out yet', () => {
      const element = mount(ROSTER, 180);
      element.style.display = 'none';
      element.reflow();
      expect(overflow(element).items).toHaveLength(0);
    });
  });

  describe('ResizeObserver lifecycle', () => {
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    async function waitForObserverReflow(): Promise<void> {
      await nextFrame();
      await nextFrame();
      await nextFrame();
    }

    function stubResizeObserver(): {
      callback: { current: ResizeObserverCallback | null };
      restore: () => void;
    } {
      const real = globalThis.ResizeObserver;
      const callback: { current: ResizeObserverCallback | null } = { current: null };
      class StubResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          callback.current = cb;
        }
        observe(): void {}
        disconnect(): void {}
      }
      globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
      return { callback, restore: () => (globalThis.ResizeObserver = real) };
    }

    it('defers and coalesces observer reflows onto one animation frame', async () => {
      const { callback, restore } = stubResizeObserver();
      try {
        const element = mount();
        await nextFrame();
        const reflow = vi.spyOn(element, 'reflow');
        const fire = callback.current as ResizeObserverCallback;
        fire([], element as unknown as ResizeObserver);
        fire([], element as unknown as ResizeObserver);
        expect(reflow).not.toHaveBeenCalled();
        await nextFrame();
        expect(reflow).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it('settles after crossing the fit/overflow boundary instead of oscillating', async () => {
      const element = mount(rosterOf(6), 220);
      await waitForObserverReflow();
      const reflow = vi.spyOn(element, 'reflow');
      const states: boolean[] = [];

      for (const width of [220, 320, 420, 520, 420, 320, 220]) {
        const before = reflow.mock.calls.length;
        element.style.width = `${width}px`;
        element.getBoundingClientRect();
        await waitForObserverReflow();
        const settled = reflow.mock.calls.length;
        states.push(element.classList.contains('has-overflow'));
        expect(settled - before).toBeLessThanOrEqual(2);
        await waitForObserverReflow();
        expect(reflow).toHaveBeenCalledTimes(settled);
      }

      expect(states).toContain(true);
      expect(states).toContain(false);
    });

    it('cancels a pending observer reflow on disconnect', async () => {
      const { callback, restore } = stubResizeObserver();
      try {
        const element = mount();
        await nextFrame();
        const reflow = vi.spyOn(element, 'reflow');
        (callback.current as ResizeObserverCallback)([], element as unknown as ResizeObserver);
        element.remove();
        await nextFrame();
        expect(reflow).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });
  });

  it('lays out as a flex row and hides overflow-collapsed segments with display none', () => {
    const element = mount(ROSTER, 180);
    element.reflow();
    expect(getComputedStyle(element).display).toBe('flex');
    expect(getComputedStyle(element).columnGap).toBe('8px');
    const hidden = segments(element).find((item) => item.classList.contains('hide')) as HTMLElement;
    expect(getComputedStyle(hidden).display).toBe('none');
  });
});
