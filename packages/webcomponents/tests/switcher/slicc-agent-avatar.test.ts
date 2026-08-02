import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccAgentAvatar } from '../../src/switcher/slicc-agent-avatar.js';

function mount(attributes: Record<string, string> = {}): SliccAgentAvatar {
  const element = document.createElement('slicc-agent-avatar') as SliccAgentAvatar;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

function pupilRadius(element: SliccAgentAvatar): number {
  const pupil = element.shadowRoot?.querySelector('.pupil-l circle');
  return Number(pupil?.getAttribute('r'));
}

function translateXY(element: SliccAgentAvatar, side: 'l' | 'r'): [number, number] {
  const transform =
    element.shadowRoot?.querySelector(`.pupil-${side}`)?.getAttribute('transform') ?? '';
  const match = /^translate\(([-\d.]+),([-\d.]+)\)$/.exec(transform);
  if (!match) throw new Error(`Missing pupil offset for ${side}`);
  return [Number(match[1]), Number(match[2])];
}

function travelMagnitude(element: SliccAgentAvatar): number {
  return Math.hypot(...translateXY(element, 'l'));
}

describe('slicc-agent-avatar', () => {
  beforeEach(() => document.body.replaceChildren());

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('registers and re-renders for every observed attribute', () => {
    expect(customElements.get('slicc-agent-avatar')).toBe(SliccAgentAvatar);
    expect(SliccAgentAvatar.observedAttributes).toEqual(['type', 'color', 'eyes', 'fill']);
    const element = mount({ type: 'scoop', color: '#123456', eyes: 'open', fill: '0' });

    let rendered = element.shadowRoot?.firstElementChild;
    element.setAttribute('type', 'cone');
    expect(element.shadowRoot?.firstElementChild).not.toBe(rendered);
    expect(element.shadowRoot?.querySelector('.glyph')?.getAttribute('viewBox')).toBe(
      '70 330 440 570'
    );

    rendered = element.shadowRoot?.firstElementChild;
    element.setAttribute('color', '#abcdef');
    expect(element.shadowRoot?.firstElementChild).not.toBe(rendered);
    expect(element.shadowRoot?.querySelector('.glyph path')?.getAttribute('fill')).toBe('#abcdef');

    rendered = element.shadowRoot?.firstElementChild;
    element.setAttribute('fill', '75');
    expect(element.shadowRoot?.firstElementChild).not.toBe(rendered);
    expect(pupilRadius(element)).toBeGreaterThan(18);

    rendered = element.shadowRoot?.firstElementChild;
    element.setAttribute('eyes', 'dead');
    expect(element.shadowRoot?.firstElementChild).not.toBe(rendered);
    expect(element.shadowRoot?.querySelector('.pupil')).toBeNull();
    expect(element.shadowRoot?.querySelectorAll('.eyes-svg line')).toHaveLength(4);
  });

  it('never binds pointer tracking for dead eyes', () => {
    const add = vi.spyOn(document, 'addEventListener');
    mount({ eyes: 'dead' });
    expect(add.mock.calls.some(([type]) => type === 'pointermove')).toBe(false);
  });

  it('removes pointer and reduced-motion listeners when disconnected', () => {
    const motionQuery = {
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(motionQuery);
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const element = mount({ eyes: 'open' });
    const pointerListener = add.mock.calls.find(([type]) => type === 'pointermove')?.[1];
    const motionListener = vi
      .mocked(motionQuery.addEventListener)
      .mock.calls.find(([type]) => type === 'change')?.[1];

    element.remove();

    expect(pointerListener).toBeDefined();
    expect(remove).toHaveBeenCalledWith('pointermove', pointerListener);
    expect(motionListener).toBeDefined();
    expect(motionQuery.removeEventListener).toHaveBeenCalledWith('change', motionListener);
  });

  it('increases pupil scale and decreases travel monotonically as fill rises', () => {
    const element = mount({ type: 'scoop', eyes: 'open' });
    const radii: number[] = [];
    const travel: number[] = [];
    for (const fill of [0, 60, 85]) {
      element.setAttribute('fill', String(fill));
      radii.push(pupilRadius(element));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1000, clientY: 1000 }));
      travel.push(travelMagnitude(element));
    }

    expect(radii[1]).toBeGreaterThan(radii[0]);
    expect(radii[2]).toBeGreaterThan(radii[1]);
    expect(travel[1]).toBeLessThan(travel[0]);
    expect(travel[2]).toBeLessThan(travel[1]);
  });

  it('tracks opposed cursor positions in the correct direction with both pupils', () => {
    const element = mount({ type: 'scoop', eyes: 'open' });
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: -1000, clientY: -1000 }));
    const topLeft = [translateXY(element, 'l'), translateXY(element, 'r')];

    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1000, clientY: 1000 }));
    const bottomRight = [translateXY(element, 'l'), translateXY(element, 'r')];

    for (let index = 0; index < topLeft.length; index += 1) {
      expect(bottomRight[index][0]).toBeGreaterThan(topLeft[index][0]);
      expect(bottomRight[index][1]).toBeGreaterThan(topLeft[index][1]);
    }
  });

  it('toggles blink only as a host attribute without re-rendering', () => {
    const element = mount({ eyes: 'open' });
    const rendered = element.shadowRoot?.firstElementChild;

    element.toggleAttribute('blink', true);
    expect(element.hasAttribute('blink')).toBe(true);
    expect(element.shadowRoot?.firstElementChild).toBe(rendered);
    expect(SliccAgentAvatar.observedAttributes).not.toContain('blink');

    element.toggleAttribute('blink', false);
    expect(element.hasAttribute('blink')).toBe(false);
    expect(element.shadowRoot?.firstElementChild).toBe(rendered);
  });
});
