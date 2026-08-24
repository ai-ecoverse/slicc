import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_BROWS,
  BLINK_APEX_MS,
  BLINK_SQUISH,
  DROWSE_START_LID,
  EYE_R,
  GLOWER_LID,
  GLOWER_MS,
  PUPIL_MIN_FRACTION,
  SCRUTINY_MS,
  SOCKET_MIN_RX,
} from '../../src/switcher/avatar-expression.js';
import { REAL_AVATAR_CLOCK, SliccAgentAvatar } from '../../src/switcher/slicc-agent-avatar.js';
import { ManualClock } from './manual-clock.js';

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

/** Mount an avatar already running on a manual clock (set BEFORE connecting). */
function mountStepped(attributes: Record<string, string> = {}): [SliccAgentAvatar, ManualClock] {
  const element = document.createElement('slicc-agent-avatar') as SliccAgentAvatar;
  const clock = new ManualClock();
  element.clock = clock;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return [element, clock];
}

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

  it('runs on the real clock unless it is swapped for a steppable one', () => {
    const element = mount({ activity: 'idle' });
    expect(element.clock).toBe(REAL_AVATAR_CLOCK);
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

  it('commits the working square under a blink instead of sliding it in', () => {
    const [element, clock] = mountStepped({ activity: 'thinking', fill: '0' });
    expect(socketRadius(element)).toBeCloseTo(EYE_R, 1);

    element.setAttribute('activity', 'working');
    clock.advance(16);
    // Mid-blink the lid is down and the shape has NOT changed yet.
    const group = element.shadowRoot?.querySelector('.eye-blink') as SVGGElement;
    expect(group.style.transform).toBe(`scaleY(${BLINK_SQUISH})`);
    expect(socketRadius(element)).toBeCloseTo(EYE_R, 1);

    clock.advance(BLINK_APEX_MS);
    expect(socketRadius(element)).toBeCloseTo(SOCKET_MIN_RX, 1);
    expect(socketRadius(element, 'r')).toBeCloseTo(SOCKET_MIN_RX, 1);
    expect(pupilCorner(element)).toBeCloseTo(18 * PUPIL_MIN_FRACTION, 1);
    expect(element.expression.shape).toBe(1);
    expect(group.style.transform).toBe('scaleY(1)');
  });

  it('returns to the circle when the tool call ends', () => {
    const [element, clock] = mountStepped({ activity: 'working', fill: '0' });
    // The first paint is instant — no shape ever slides in front of the user.
    expect(socketRadius(element)).toBeCloseTo(SOCKET_MIN_RX, 1);

    element.setAttribute('activity', 'thinking');
    clock.advance(BLINK_APEX_MS + 32);
    expect(socketRadius(element)).toBeCloseTo(EYE_R, 1);
  });

  it('shows the quizzical brows only while thinking', () => {
    const [element, clock] = mountStepped({ activity: 'idle' });
    const brow = element.shadowRoot?.querySelector('.brow-l') as SVGLineElement;
    expect(brow).not.toBeNull();
    expect(brow.getAttribute('opacity')).toBe('0');
    expect(element.expression.browsVisible).toBe(false);

    element.setAttribute('activity', 'thinking');
    clock.advance(16);
    expect(brow.getAttribute('opacity')).toBe('1');
    expect(element.expression.browsVisible).toBe(true);
    // One brow cocked, the other settled — never a symmetric pair.
    const { left, right } = element.expression.brows;
    expect(Math.sign(left.raise)).not.toBe(Math.sign(right.raise));

    element.setAttribute('activity', 'awaiting');
    clock.advance(16);
    expect(brow.getAttribute('opacity')).toBe('0');
  });

  it('paints the brows OUTSIDE the roundrect crop, on a matching zoom layer', () => {
    const [element] = mountStepped({ activity: 'thinking' });
    const root = element.shadowRoot as ShadowRoot;
    const crop = root.querySelector('.crop') as HTMLElement;
    const layer = root.querySelector('.brow-layer') as HTMLElement;

    // The crop, not the tile, owns the roundrect — that is what the brows escape.
    expect(getComputedStyle(crop).overflow).toBe('hidden');
    expect(getComputedStyle(root.querySelector('.avatar') as HTMLElement).overflow).toBe('visible');
    // Sockets stay inside the crop; brows do not.
    expect(crop.querySelector('.eyes-svg')).not.toBeNull();
    expect(crop.querySelector('.brow-l')).toBeNull();
    expect(layer.querySelector('.brow-l')).not.toBeNull();
    expect(layer.querySelector('.eyes-svg')).toBeNull();
    // Both layers ride the identical zoom/pan, or the brows would drift off the eyes.
    expect(layer.getAttribute('style')).toBe(
      (crop.querySelector('.icon-inner') as HTMLElement).getAttribute('style')
    );
  });

  it('holds the brows still through a blink instead of folding them onto the eye', () => {
    const [element, clock] = mountStepped({ activity: 'thinking', fill: '0' });
    const browGroup = element.shadowRoot?.querySelector('.brow-group-l') as SVGGElement;
    const eyeGroup = element.shadowRoot?.querySelector('.eye-blink.eye-l') as SVGGElement;

    element.wake();
    clock.advance(16);
    // The lid squashes; the brows — which now paint outside the crop, where the
    // squash would fold them flat onto the eyeball — do not follow it.
    expect(eyeGroup.style.transform).toBe(`scaleY(${BLINK_SQUISH})`);
    expect(browGroup.style.transform).toBe('');

    clock.advance(BLINK_APEX_MS + 16);
    expect(browGroup.style.transform).toBe('');
  });

  it('builds no brow layer for the faces that have no brows', () => {
    expect(
      mount({ activity: 'thinking', eyes: 'dead' }).shadowRoot?.querySelector('.brow-layer')
    ).toBeNull();
    expect(
      mount({ activity: 'thinking', eyes: 'none' }).shadowRoot?.querySelector('.brow-layer')
    ).toBeNull();
    // The legacy face (no activity) never had brows either.
    expect(mount().shadowRoot?.querySelector('.brow-layer')).toBeNull();
  });

  it('re-cocks the brows at a blink apex while thinking', () => {
    const [element, clock] = mountStepped({ activity: 'thinking', blink: '' });
    clock.advance(16);
    const before = element.expression.brows;

    element.wake(); // any blink re-cocks; wake() fires one on demand
    clock.advance(BLINK_APEX_MS + 16);
    expect(element.expression.brows).not.toEqual(before);
  });

  it('cuts a top lid across the eye for the glower and releases it', () => {
    const [element, clock] = mountStepped({ activity: 'thinking' });
    const openY = Number(lidClip(element).getAttribute('y'));
    expect(chord(element, 'top').getAttribute('display')).toBe('none');

    element.glower();
    clock.advance(600);
    expect(element.expression.lidTop).toBeGreaterThan(0.2);
    expect(Number(lidClip(element).getAttribute('y'))).toBeGreaterThan(openY + 20);
    expect(chord(element, 'top').getAttribute('display')).toBe('inline');
    // The chord closes the outline exactly at the cut.
    expect(Number(chord(element, 'top').getAttribute('y1'))).toBeCloseTo(
      Number(lidClip(element).getAttribute('y')),
      1
    );

    // Released a full second after the 2.6s window, with time to ease back.
    clock.advance(GLOWER_MS + 1000);
    expect(element.expression.lidTop).toBeLessThan(0.01);
    expect(chord(element, 'top').getAttribute('display')).toBe('none');
  });

  it('raises a bottom lid for exactly one second per scrutinize() call', () => {
    const [element, clock] = mountStepped({ activity: 'awaiting', 'drowse-delay': '600' });
    element.scrutinize();
    clock.advance(400);
    expect(element.expression.lidBottom).toBeGreaterThan(0.1);
    expect(chord(element, 'bottom').getAttribute('display')).toBe('inline');

    // Each keystroke re-arms the full second from the last call.
    element.scrutinize();
    clock.advance(700);
    expect(element.expression.lidBottom).toBeGreaterThan(0.1);

    // 300ms past the re-armed deadline the target is 0; 700ms more to ease back.
    clock.advance(SCRUTINY_MS);
    expect(element.expression.lidBottom).toBeLessThan(0.01);
    expect(chord(element, 'bottom').getAttribute('display')).toBe('none');
  });

  it('drowses under a descending top lid while awaiting, and wakes back up', () => {
    const [element, clock] = mountStepped({ activity: 'awaiting', 'drowse-delay': '0' });
    clock.advance(1500);
    const drowsing = element.expression.lidTop;
    // Past the soft arrival lid: the cut is descending.
    expect(drowsing).toBeGreaterThan(DROWSE_START_LID);

    element.wake();
    clock.advance(16);
    // The pop is a transient on the pupil, so context fill stays honest.
    expect(element.expression.pupilRadius).toBeGreaterThan(18);

    clock.advance(500);
    expect(element.expression.lidTop).toBeLessThan(drowsing);
    expect(element.expression.pupilRadius).toBeCloseTo(18, 0);
  });

  it('anchors the awaiting gaze at the gaze-target and falls back to down-centre', () => {
    const target = document.createElement('div');
    target.id = 'gaze-probe';
    target.style.cssText = 'position:fixed;right:0;bottom:0;width:60px;height:30px';
    document.body.append(target);

    const [anchored, anchoredClock] = mountStepped({
      activity: 'awaiting',
      'gaze-target': '#gaze-probe',
    });
    anchoredClock.advance(300);
    expect(anchored.expression.gaze.x).toBeGreaterThan(100);
    expect(anchored.expression.gaze.y).toBeGreaterThan(50);

    const [unanchored, unanchoredClock] = mountStepped({ activity: 'awaiting' });
    unanchoredClock.advance(300);
    expect(unanchored.expression.gaze.x).toBeCloseTo(100, 0);
    expect(unanchored.expression.gaze.y).toBeGreaterThan(55);
  });

  it('moves its own gaze while thinking and idle, ignoring the pointer', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const [element, clock] = mountStepped({ activity: 'thinking' });
    expect(add.mock.calls.some(([type]) => type === 'pointermove')).toBe(false);

    clock.advance(16);
    const first = translateXY(element, 'l');
    clock.advance(250);
    const second = translateXY(element, 'l');
    expect(second).not.toEqual(first);

    element.setAttribute('activity', 'idle');
    clock.advance(250);
    expect(translateXY(element, 'l')).not.toEqual(second);
  });

  it('keeps tracking the pointer while a tool call runs', () => {
    const element = mount({ activity: 'working' });
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: -1000, clientY: -1000 }));
    const [x] = translateXY(element, 'l');
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1000, clientY: 1000 }));
    expect(translateXY(element, 'l')[0]).toBeGreaterThan(x);
  });

  it('freezes shape, lids and brows while the connection is in trouble', () => {
    const [element, clock] = mountStepped({ activity: 'working', connection: 'connected' });
    // Pin the interleaving: let the square settle FIRST, then freeze.
    clock.advance(500);
    expect(element.expression.shape).toBe(1);
    expect(socketRadius(element)).toBeCloseTo(SOCKET_MIN_RX, 1);

    element.setAttribute('connection', 'disconnected');
    // Static outranks everything: the loop stops rather than morphing.
    expect(clock.pendingFrames).toBe(0);

    element.setAttribute('activity', 'thinking');
    element.glower();
    clock.advance(600);
    expect(clock.pendingFrames).toBe(0);
    expect(element.expression.shape).toBe(1);
    expect(Number(element.shadowRoot?.querySelector('.socket')?.getAttribute('rx'))).toBeCloseTo(
      SOCKET_MIN_RX,
      1
    );
    expect(element.expression.lidTop).toBe(0);

    // Reconnecting releases the freeze: the pending circle commits under a blink.
    element.setAttribute('connection', 'connected');
    clock.advance(BLINK_APEX_MS + 200);
    expect(element.expression.shape).toBe(0);
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

  it('turns the engine on for a transient even without an activity attribute', () => {
    const [element, clock] = mountStepped({ eyes: 'open' });
    expect(element.shadowRoot?.querySelector('.lid-clip')).toBeNull();

    element.glower();
    clock.advance(500);
    expect(element.shadowRoot?.querySelector('.lid-clip')).not.toBeNull();
    expect(element.expression.lidTop).toBeGreaterThan(0.2);
  });

  it('stops every frame and timer when disconnected', () => {
    const [element, clock] = mountStepped({ activity: 'thinking', blink: '' });
    clock.advance(16);
    expect(clock.pendingFrames).toBeGreaterThan(0);
    expect(clock.pendingTimers).toBeGreaterThan(0);

    element.remove();

    expect(clock.pendingFrames).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    // Nothing repaints after teardown.
    const before = socketRadius(element);
    clock.advance(1000);
    expect(socketRadius(element)).toBe(before);
  });

  it('drops transients and re-primes the shape when the expression is reset', () => {
    const [element, clock] = mountStepped({ activity: 'working', blink: '' });
    clock.advance(500);
    element.glower();
    element.scrutinize();
    clock.advance(400);
    expect(element.expression.lidTop).toBeGreaterThan(0.2);
    expect(element.expression.lidBottom).toBeGreaterThan(0.1);

    // A reused avatar must not carry one agent's expression onto the next.
    element.setAttribute('activity', 'thinking');
    element.resetExpression();

    expect(element.expression.lidTop).toBe(0);
    expect(element.expression.lidBottom).toBe(0);
    expect(element.expression.brows).toEqual(BASE_BROWS);
    // The new activity is adopted instantly — no blink-gated morph from the
    // previous agent's shape.
    expect(element.expression.shape).toBe(0);
    expect(socketRadius(element)).toBeCloseTo(EYE_R, 1);
    expect(chord(element, 'top').getAttribute('display')).toBe('none');
    expect(chord(element, 'bottom').getAttribute('display')).toBe('none');
  });

  it('leaves dead eyes untouched by the expression kit', () => {
    const element = mount({ activity: 'working', eyes: 'dead' });
    expect(element.shadowRoot?.querySelectorAll('.eyes-svg line')).toHaveLength(4);
    expect(element.shadowRoot?.querySelector('.brow-l')).toBeNull();
    expect(element.shadowRoot?.querySelector('.lid-clip')).toBeNull();
  });
});
