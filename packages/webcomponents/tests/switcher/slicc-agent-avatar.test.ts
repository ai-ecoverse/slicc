import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLINK_APEX_MS,
  DROWSE_START_LID,
  EYE_R,
  GLOWER_LID,
  GLOWER_MS,
  PUPIL_MIN_FRACTION,
  SCRUTINY_MS,
  SOCKET_MIN_RX,
} from '../../src/switcher/avatar-expression.js';
import { SliccAgentAvatar } from '../../src/switcher/slicc-agent-avatar.js';

function mount(attributes: Record<string, string> = {}): SliccAgentAvatar {
  const element = document.createElement('slicc-agent-avatar') as SliccAgentAvatar;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

/** Pupils are rects whose `rx` carries the shape channel; `width / 2` is the radius. */
function pupilRadius(element: SliccAgentAvatar): number {
  const pupil = element.shadowRoot?.querySelector('.pupil-l rect');
  return Number(pupil?.getAttribute('width')) / 2;
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
      'activity',
      'gaze-target',
      'drowse-delay',
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

  it('keeps the legacy face when no activity is set: no lids, no brows, no loop', () => {
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame');
    const element = mount({ eyes: 'open', fill: '20' });

    expect(element.shadowRoot?.querySelector('.brow-l')).toBeNull();
    expect(element.shadowRoot?.querySelector('.lid-clip')).toBeNull();
    expect(element.shadowRoot?.querySelector('.avatar[data-expressive]')).toBeNull();
    expect(element.activity).toBeNull();
    expect(animationFrame).not.toHaveBeenCalled();

    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1000, clientY: 1000 }));
    expect(travelMagnitude(element)).toBeGreaterThan(0);
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

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function socketRadius(element: SliccAgentAvatar, side: 'l' | 'r' = 'l'): number {
  return Number(element.shadowRoot?.querySelector(`.eye-body-${side} .socket`)?.getAttribute('rx'));
}

function pupilCorner(element: SliccAgentAvatar): number {
  return Number(element.shadowRoot?.querySelector('.pupil-l rect')?.getAttribute('rx'));
}

function lidClip(element: SliccAgentAvatar, side: 'l' | 'r' = 'l'): SVGRectElement {
  return element.shadowRoot?.querySelector(`.eye-${side} .lid-clip`) as SVGRectElement;
}

function chord(element: SliccAgentAvatar, edge: 'top' | 'bottom'): SVGLineElement {
  return element.shadowRoot?.querySelector(`.eye-l .lid-${edge}`) as SVGLineElement;
}

function reducedMotion(): void {
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList);
}

describe('slicc-agent-avatar expression kit', () => {
  beforeEach(() => document.body.replaceChildren());

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('reflects the expression attributes to properties and back', () => {
    const element = mount({ activity: 'thinking' });
    expect(element.activity).toBe('thinking');
    expect(element.drowseDelay).toBe(90);
    expect(element.gazeTarget).toBeNull();

    element.activity = 'working';
    expect(element.getAttribute('activity')).toBe('working');
    element.gazeTarget = '#composer';
    expect(element.getAttribute('gaze-target')).toBe('#composer');
    element.drowseDelay = 5;
    expect(element.getAttribute('drowse-delay')).toBe('5');
    expect(element.drowseDelay).toBe(5);

    element.activity = null;
    expect(element.hasAttribute('activity')).toBe(false);
    element.gazeTarget = null;
    expect(element.hasAttribute('gaze-target')).toBe(false);
  });

  it('builds the eye as a rect whose rx carries the shape channel', () => {
    const element = mount({ activity: 'idle' });
    // A rect with rx = half its side IS a circle — one attribute, both platforms.
    expect(socketRadius(element)).toBeCloseTo(EYE_R, 1);
    expect(element.shadowRoot?.querySelector('.eye-body-l .socket')?.tagName).toBe('rect');
    expect(element.shadowRoot?.querySelector('.avatar[data-expressive]')).not.toBeNull();
    expect(element.expression.shape).toBe(0);
  });

  it('commits the working square under a blink instead of sliding it in', async () => {
    const element = mount({ activity: 'thinking', fill: '0' });
    expect(socketRadius(element)).toBeCloseTo(EYE_R, 1);

    element.setAttribute('activity', 'working');
    await nextFrame();
    // Mid-blink the lid is down and the shape has NOT changed yet.
    const group = element.shadowRoot?.querySelector('.eye-blink') as SVGGElement;
    expect(group.style.transform).toBe('scaleY(0.08)');
    expect(socketRadius(element)).toBeCloseTo(EYE_R, 1);

    await wait(BLINK_APEX_MS + 80);
    expect(socketRadius(element)).toBeCloseTo(SOCKET_MIN_RX, 1);
    expect(socketRadius(element, 'r')).toBeCloseTo(SOCKET_MIN_RX, 1);
    expect(pupilCorner(element)).toBeCloseTo(18 * PUPIL_MIN_FRACTION, 1);
    expect(element.expression.shape).toBe(1);
    expect(group.style.transform).toBe('scaleY(1)');
  });

  it('returns to the circle when the tool call ends', async () => {
    const element = mount({ activity: 'working', fill: '0' });
    // The first paint is instant — no shape ever slides in front of the user.
    expect(socketRadius(element)).toBeCloseTo(SOCKET_MIN_RX, 1);

    element.setAttribute('activity', 'thinking');
    await wait(BLINK_APEX_MS + 80);
    expect(socketRadius(element)).toBeCloseTo(EYE_R, 1);
  });

  it('shows the quizzical brows only while thinking', async () => {
    const element = mount({ activity: 'idle' });
    const brow = element.shadowRoot?.querySelector('.brow-l') as SVGLineElement;
    expect(brow).not.toBeNull();
    expect(brow.getAttribute('opacity')).toBe('0');
    expect(element.expression.browsVisible).toBe(false);

    element.setAttribute('activity', 'thinking');
    await nextFrame();
    expect(brow.getAttribute('opacity')).toBe('1');
    expect(element.expression.browsVisible).toBe(true);
    // One brow cocked, the other settled — never a symmetric pair.
    const { left, right } = element.expression.brows;
    expect(Math.sign(left.raise)).not.toBe(Math.sign(right.raise));

    element.setAttribute('activity', 'awaiting');
    await nextFrame();
    expect(brow.getAttribute('opacity')).toBe('0');
  });

  it('re-cocks the brows at a blink apex while thinking', async () => {
    const element = mount({ activity: 'thinking', blink: '' });
    await nextFrame();
    const before = element.expression.brows;

    element.wake(); // any blink re-cocks; wake() fires one on demand
    await wait(BLINK_APEX_MS + 60);
    expect(element.expression.brows).not.toEqual(before);
  });

  it('cuts a top lid across the eye for the glower and releases it', async () => {
    const element = mount({ activity: 'thinking' });
    const openY = Number(lidClip(element).getAttribute('y'));
    expect(chord(element, 'top').getAttribute('display')).toBe('none');

    element.glower();
    await wait(600);
    expect(element.expression.lidTop).toBeGreaterThan(0.2);
    expect(Number(lidClip(element).getAttribute('y'))).toBeGreaterThan(openY + 20);
    expect(chord(element, 'top').getAttribute('display')).toBe('inline');
    // The chord closes the outline exactly at the cut.
    expect(Number(chord(element, 'top').getAttribute('y1'))).toBeCloseTo(
      Number(lidClip(element).getAttribute('y')),
      1
    );

    await wait(GLOWER_MS - 300);
    expect(element.expression.lidTop).toBeLessThan(GLOWER_LID / 2);
  });

  it('raises a bottom lid for exactly one second per scrutinize() call', async () => {
    const element = mount({ activity: 'awaiting', 'drowse-delay': '600' });
    element.scrutinize();
    await wait(400);
    expect(element.expression.lidBottom).toBeGreaterThan(0.1);
    expect(chord(element, 'bottom').getAttribute('display')).toBe('inline');

    // Each keystroke re-arms the full second from the last call.
    element.scrutinize();
    await wait(700);
    expect(element.expression.lidBottom).toBeGreaterThan(0.1);

    await wait(SCRUTINY_MS);
    expect(element.expression.lidBottom).toBeLessThan(0.05);
  });

  it('drowses under a descending top lid while awaiting, and wakes back up', async () => {
    const element = mount({ activity: 'awaiting', 'drowse-delay': '0' });
    await wait(1500);
    const drowsing = element.expression.lidTop;
    // Past the soft arrival lid: the cut is descending.
    expect(drowsing).toBeGreaterThan(DROWSE_START_LID);

    element.wake();
    await nextFrame();
    // The pop is a transient on the pupil, so context fill stays honest.
    expect(element.expression.pupilRadius).toBeGreaterThan(18);

    await wait(500);
    expect(element.expression.lidTop).toBeLessThan(drowsing);
    expect(element.expression.pupilRadius).toBeCloseTo(18, 0);
  });

  it('anchors the awaiting gaze at the gaze-target and falls back to down-centre', async () => {
    const target = document.createElement('div');
    target.id = 'gaze-probe';
    target.style.cssText = 'position:fixed;right:0;bottom:0;width:60px;height:30px';
    document.body.append(target);

    const anchored = mount({ activity: 'awaiting', 'gaze-target': '#gaze-probe' });
    await wait(300);
    expect(anchored.expression.gaze.x).toBeGreaterThan(100);
    expect(anchored.expression.gaze.y).toBeGreaterThan(50);

    const unanchored = mount({ activity: 'awaiting' });
    await wait(300);
    expect(unanchored.expression.gaze.x).toBeCloseTo(100, 0);
    expect(unanchored.expression.gaze.y).toBeGreaterThan(55);
  });

  it('moves its own gaze while thinking and idle, ignoring the pointer', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const element = mount({ activity: 'thinking' });
    expect(add.mock.calls.some(([type]) => type === 'pointermove')).toBe(false);

    await nextFrame();
    const first = translateXY(element, 'l');
    await wait(250);
    const second = translateXY(element, 'l');
    expect(second).not.toEqual(first);

    element.setAttribute('activity', 'idle');
    await wait(250);
    expect(translateXY(element, 'l')).not.toEqual(second);
  });

  it('keeps tracking the pointer while a tool call runs', () => {
    const element = mount({ activity: 'working' });
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: -1000, clientY: -1000 }));
    const [x] = translateXY(element, 'l');
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1000, clientY: 1000 }));
    expect(translateXY(element, 'l')[0]).toBeGreaterThan(x);
  });

  it('freezes shape, lids and brows while the connection is in trouble', async () => {
    const element = mount({ activity: 'working', connection: 'connected' });
    expect(element.expression.shape).toBe(1);

    element.setAttribute('connection', 'disconnected');
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    element.setAttribute('activity', 'thinking');
    element.glower();
    await wait(300);

    // Static outranks everything: the square stays, no morph, no new frames.
    expect(element.expression.shape).toBe(1);
    expect(Number(element.shadowRoot?.querySelector('.socket')?.getAttribute('rx'))).toBeCloseTo(
      SOCKET_MIN_RX,
      1
    );
    expect(element.expression.lidTop).toBe(0);
    expect(frame).not.toHaveBeenCalled();

    element.setAttribute('connection', 'connected');
    await wait(BLINK_APEX_MS + 120);
    expect(socketRadius(element)).toBeCloseTo(EYE_R, 1);
  });

  it('applies activity changes instantly and skips every motion under reduced motion', () => {
    reducedMotion();
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    const element = mount({ activity: 'thinking', blink: '' });

    element.setAttribute('activity', 'working');
    expect(socketRadius(element)).toBeCloseTo(SOCKET_MIN_RX, 1);
    expect(element.expression.shape).toBe(1);

    element.glower();
    expect(element.expression.lidTop).toBe(GLOWER_LID);

    element.wake();
    // No pop, no blink, no loop.
    expect(element.expression.pupilRadius).toBeCloseTo(18, 5);
    expect((element.shadowRoot?.querySelector('.eye-blink') as SVGGElement).style.transform).toBe(
      ''
    );
    expect(frame).not.toHaveBeenCalled();

    element.setAttribute('activity', 'idle');
    expect(translateXY(element, 'l')).toEqual([0, 0]);
  });

  it('parks the brows at the base pose under reduced motion', () => {
    reducedMotion();
    const element = mount({ activity: 'thinking' });
    const brow = element.shadowRoot?.querySelector('.brow-l') as SVGLineElement;
    expect(brow.getAttribute('opacity')).toBe('1');
    expect(element.expression.brows.left.raise).toBe(-9);
    expect(element.expression.brows.right.raise).toBe(2);
  });

  it('turns the engine on for a transient even without an activity attribute', async () => {
    const element = mount({ eyes: 'open' });
    expect(element.shadowRoot?.querySelector('.lid-clip')).toBeNull();

    element.glower();
    await wait(500);
    expect(element.shadowRoot?.querySelector('.lid-clip')).not.toBeNull();
    expect(element.expression.lidTop).toBeGreaterThan(0.2);
  });

  it('stops every timer and frame when disconnected', async () => {
    const element = mount({ activity: 'thinking', blink: '' });
    await nextFrame();
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const clear = vi.spyOn(window, 'clearInterval');

    element.remove();

    expect(cancel).toHaveBeenCalled();
    expect(clear).toHaveBeenCalled();
  });

  it('leaves dead eyes untouched by the expression kit', () => {
    const element = mount({ activity: 'working', eyes: 'dead' });
    expect(element.shadowRoot?.querySelectorAll('.eyes-svg line')).toHaveLength(4);
    expect(element.shadowRoot?.querySelector('.brow-l')).toBeNull();
    expect(element.shadowRoot?.querySelector('.lid-clip')).toBeNull();
  });
});
