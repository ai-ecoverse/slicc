import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      'slicc-pill',
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

  it('reflects active and attention properties to attributes', () => {
    const element = mount();
    element.active = 'researcher';
    element.attention = 'designer';
    expect(element.getAttribute('active')).toBe('researcher');
    expect(element.getAttribute('attention')).toBe('designer');
    element.active = null;
    element.attention = null;
    expect(element.hasAttribute('active')).toBe(false);
    expect(element.hasAttribute('attention')).toBe(false);
  });

  it('focuses the first descriptor by default and updates avatar + selected segment', () => {
    const element = mount();
    expect(avatar(element)?.getAttribute('type')).toBe('cone');
    expect(avatar(element)?.hasAttribute('track')).toBe(true);
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
    expect(avatar(element)?.getAttribute('label')).toBe('Sliccy');
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
    it('maps idle and working to arcs, with a centre pin only for working', () => {
      const element = mount();
      expect(
        segment(element, 'designer').querySelector('.slicc-agent-tabs__glyph-arc')
      ).toBeTruthy();
      expect(
        getComputedStyle(
          segment(element, 'designer').querySelector('.slicc-agent-tabs__glyph-pin') as SVGElement
        ).display
      ).toBe('none');
      expect(
        segment(element, 'researcher').querySelector('.slicc-agent-tabs__glyph-arc')
      ).toBeTruthy();
      expect(
        segment(element, 'researcher').querySelector('.slicc-agent-tabs__glyph-pin')
      ).toBeTruthy();
      expect(
        getComputedStyle(
          segment(element, 'researcher').querySelector('.slicc-agent-tabs__glyph-pin') as SVGElement
        ).display
      ).not.toBe('none');
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

    it('derives legacy state from dead eyes and attention when state is omitted', () => {
      const element = mount([
        { key: 'cone', eyes: 'open' },
        { key: 'busy', eyes: 'open' },
        { key: 'failed', eyes: 'dead' },
      ]);
      element.attention = 'busy';
      expect(segment(element, 'cone').dataset.state).toBe('idle');
      expect(segment(element, 'busy').dataset.state).toBe('working');
      expect(segment(element, 'failed').dataset.state).toBe('broken');
    });

    it('renders attention independently when explicit state remains idle', () => {
      const element = mount([{ key: 'cone' }, { key: 'paused', state: 'idle' }]);
      element.attention = 'paused';
      expect(segment(element, 'paused').dataset.state).toBe('idle');
      expect(segment(element, 'paused').dataset.attention).toBe('true');
      expect(segment(element, 'paused').getAttribute('aria-label')).toContain('needs attention');
      expect(segment(element, 'cone').hasAttribute('data-attention')).toBe(false);

      element.attention = 'cone';
      expect(segment(element, 'paused').hasAttribute('data-attention')).toBe(false);
      expect(segment(element, 'paused').getAttribute('aria-label')).not.toContain(
        'needs attention'
      );
      expect(segment(element, 'cone').dataset.attention).toBe('true');
    });

    it('renders attention as a layout-neutral outline over broken and selected states', () => {
      const element = mount([{ key: 'cone' }, { key: 'failed', state: 'broken', eyes: 'dead' }]);
      element.active = 'failed';
      const failed = segment(element, 'failed');
      const before = failed.getBoundingClientRect();

      element.attention = 'failed';
      const attentionStyle = getComputedStyle(failed);
      const after = failed.getBoundingClientRect();

      expect(failed.dataset.state).toBe('broken');
      expect(failed.getAttribute('aria-selected')).toBe('true');
      expect(attentionStyle.outlineStyle).toBe('solid');
      expect(attentionStyle.outlineWidth).toBe('2px');
      expect(attentionStyle.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(attentionStyle.animationName).toBe('slicc-agent-tabs-attention');
      expect(attentionStyle.animationPlayState).toBe('running');
      expect(attentionStyle.boxShadow).not.toBe('none');
      expect(
        getComputedStyle(failed.querySelector('.slicc-agent-tabs__status-glyph') as SVGElement)
          .color
      ).not.toBe(attentionStyle.outlineColor);
      expect(after.width).toBeCloseTo(before.width);
      expect(after.height).toBeCloseTo(before.height);
      expect(getComputedStyle(segment(element, 'cone')).animationPlayState).toBe('paused');
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

    it('keeps the sweep and attention outline but stops their motion under reduced motion', () => {
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
      const reducedAttentionRule = [...(media?.cssRules ?? [])].find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText.includes('__segment')
      );
      const attentionRule = [...(style.sheet?.cssRules ?? [])].find(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.selectorText.includes('[data-attention=')
      );
      expect(reducedArcRule?.style.animationName).toBe('none');
      expect(reducedArcRule?.style.transform).toBe('rotate(-90deg)');
      expect(reducedAttentionRule?.style.animationName).toBe('none');
      expect(attentionRule?.style.getPropertyValue('--slicc-agent-tabs-attention-outline')).toBe(
        'var(--ink)'
      );
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

    it('keeps the avatar and overflow trigger keyboard reachable but outside tab semantics', () => {
      const element = mount(ROSTER, 180);
      element.reflow();
      const avatarButton = avatar(element)?.shadowRoot?.querySelector(
        'button'
      ) as HTMLButtonElement;
      const overflowButton = overflow(element).shadowRoot?.querySelector(
        '.morebtn'
      ) as HTMLButtonElement;

      expect(avatarButton.tabIndex).toBe(0);
      expect(avatarButton.getAttribute('role')).not.toBe('tab');
      avatarButton.focus();
      expect(avatar(element)?.shadowRoot?.activeElement).toBe(avatarButton);
      expect(overflowButton.tabIndex).toBe(0);
      expect(overflowButton.getAttribute('role')).not.toBe('tab');
      overflowButton.focus();
      expect(overflow(element).shadowRoot?.activeElement).toBe(overflowButton);
    });
  });

  describe('overflow reflow', () => {
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

    it('re-emits overflow selection with the canonical key payload', () => {
      const element = mount(ROSTER, 180);
      element.reflow();
      const item = overflow(element).items[0];
      const listener = vi.fn();
      element.addEventListener('slicc-scoop-select', (event) =>
        listener((event as CustomEvent<ScoopSelectDetail>).detail)
      );
      overflow(element).dispatchEvent(
        new CustomEvent('slicc-scoop-select', {
          detail: { id: item.id, label: item.label ?? item.id },
          bubbles: true,
          composed: true,
        })
      );
      expect(listener).toHaveBeenCalledWith({ id: item.id, key: item.id, label: item.label });
      expect(element.active).toBe(item.id);
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
