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
    expect(SliccAgentAvatar.observedAttributes).toEqual([
      'type',
      'color',
      'eyes',
      'fill',
      'connection',
    ]);
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

  it('lets disconnected static replace lifecycle pupils with noise while keeping the outline', () => {
    const element = mount({ eyes: 'dead', connection: 'disconnected', fill: '75' });
    const staticEye = element.shadowRoot?.querySelector('.eye-static');
    expect(staticEye).not.toBeNull();
    expect(staticEye?.children[2]?.classList.contains('noise')).toBe(true);
    expect(staticEye?.children[3]?.classList.contains('eye-outline')).toBe(true);
    expect(element.shadowRoot?.querySelector('.pupil')).toBeNull();
    expect(element.shadowRoot?.querySelectorAll('.eyes-svg line')).toHaveLength(0);

    element.setAttribute('connection', 'connected');
    expect(element.shadowRoot?.querySelectorAll('.eyes-svg line')).toHaveLength(4);
    expect(element.shadowRoot?.querySelector('.noise')).toBeNull();
  });

  it('renders the exact frozen xorshift32 frame under reduced motion without starting a loop', () => {
    const motionQuery = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(motionQuery);
    const interval = vi.spyOn(window, 'setInterval');
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame');

    const element = mount({
      eyes: 'open',
      connection: 'disconnected',
      style: 'width:20px;height:20px',
    });
    const groups = element.shadowRoot?.querySelectorAll<SVGGElement>('.noise');
    const cells = groups?.[0]?.querySelectorAll('rect');
    expect(groups).toHaveLength(2);
    expect(groups?.[0]?.getAttribute('data-seed')).toBe('1372365086');
    expect(groups?.[1]?.getAttribute('data-seed')).toBe('3559353205');
    expect(
      Array.from(cells ?? [])
        .slice(0, 12)
        .map((cell) => cell.getAttribute('fill'))
    ).toEqual([
      'rgb(36% 36% 36%)',
      'rgb(68% 68% 68%)',
      'rgb(68% 68% 68%)',
      'rgb(36% 36% 36%)',
      'rgb(36% 36% 36%)',
      'rgb(36% 36% 36%)',
      'rgb(8% 8% 8%)',
      'rgb(68% 68% 68%)',
      'rgb(68% 68% 68%)',
      'rgb(94% 94% 94%)',
      'rgb(36% 36% 36%)',
      'rgb(68% 68% 68%)',
    ]);
    expect(cells).toHaveLength(225);
    expect(cells?.[0]?.getAttribute('opacity')).toBe('0.72');
    expect(groups?.[0]?.getAttribute('data-cell-size')).toBe('1');
    expect(interval).not.toHaveBeenCalled();
    expect(animationFrame).not.toHaveBeenCalled();
  });

  it('uses iOS reference-date frame seeds at exactly 12 fps and clears the interval', () => {
    const motionQuery = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(motionQuery);
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2001, 0, 1) + 1000);
    const interval = vi.spyOn(window, 'setInterval');
    const clear = vi.spyOn(window, 'clearInterval');

    const element = mount({ eyes: 'static' });
    const groups = element.shadowRoot?.querySelectorAll<SVGGElement>('.noise');
    expect(groups?.[0]?.getAttribute('data-seed')).toBe('995431858');
    expect(groups?.[1]?.getAttribute('data-seed')).toBe('3200180185');
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 1000 / 12);

    element.remove();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('normalizes an animated zero seed to the iOS frozen seed', () => {
    const zeroSeedFrame = 968_638_734;
    const frameTimeMs = Math.ceil((zeroSeedFrame * 1000) / 12);
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2001, 0, 1) + frameTimeMs);

    const element = mount({ eyes: 'static', style: 'width:20px;height:20px' });
    const leftNoise = element.shadowRoot?.querySelector<SVGGElement>('.noise-l');
    expect(leftNoise?.getAttribute('data-seed')).toBe('1372365086');
    expect(leftNoise?.querySelectorAll('rect')).toHaveLength(225);
    expect(
      Array.from(leftNoise?.querySelectorAll('rect') ?? [])
        .slice(0, 4)
        .map((cell) => cell.getAttribute('fill'))
    ).toEqual(['rgb(36% 36% 36%)', 'rgb(68% 68% 68%)', 'rgb(68% 68% 68%)', 'rgb(36% 36% 36%)']);
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
