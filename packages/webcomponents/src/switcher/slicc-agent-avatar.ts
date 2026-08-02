import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PUPIL_R = 18;
const MAX_OFFSET = 16;
const LEFT_EYE = { cx: 55, cy: 50, r: 38 } as const;
const RIGHT_EYE = { cx: 145, cy: 50, r: 38 } as const;

interface TypeConfig {
  vb: string;
  eyes: { top: number; left: number; width: number; height: number };
  zoom: number;
  glyph: number;
}

const TYPE: Record<'cone' | 'scoop', TypeConfig> = {
  cone: {
    vb: '70 330 440 570',
    eyes: { top: -18.5, left: 17, width: 70, height: 44 },
    zoom: 3,
    glyph: 96,
  },
  scoop: {
    vb: '0 0 580 470',
    eyes: { top: 30, left: 15, width: 70, height: 45 },
    zoom: 2.65,
    glyph: 96,
  },
};

const DEFAULT_COLOR = { cone: '#D2691E', scoop: '#FFB6C1' } as const;

const STYLE = `
:host{display:block;width:26px;height:26px;pointer-events:none;}
.avatar{position:relative;display:block;width:100%;height:100%;overflow:hidden;border-radius:7px;background:color-mix(in srgb,var(--slicc-agent-tabs-hue) 18%,transparent);}
.icon-inner{position:absolute;inset:0;transform-origin:0 0;transform:translate(var(--tx),var(--ty)) scale(var(--zoom));}
.glyph{position:absolute;left:50%;top:50%;display:block;width:var(--g);height:var(--g);overflow:visible;transform:translate(-50%,-50%);}
.eyes{position:absolute;pointer-events:none;}
.eyes-svg{display:block;overflow:visible;}
@keyframes slicc-agent-avatar-blink{0%,92%,100%{transform:scaleY(1);}96%{transform:scaleY(.08);}}
:host([blink]) .eye-blink{transform-box:fill-box;transform-origin:center;animation:slicc-agent-avatar-blink 3.4s ease-in-out infinite;}
:host([blink]) .eye-r{animation-duration:4.6s;}
@media (prefers-reduced-motion:reduce){:host([blink]) .eye-blink{animation:none;}}
`;

const SHEET = sheet(STYLE);

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  ...children: SVGElement[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  element.append(...children);
  return element;
}

function shade(hex: string, amount: number): string {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((part) => `${part}${part}`).join('') : value;
  const parsed = Number.parseInt(full, 16);
  if (!Number.isFinite(parsed)) return hex;
  const target = amount < 0 ? 0 : 255;
  const mix = (channel: number): string =>
    Math.round(channel + (target - channel) * Math.abs(amount))
      .toString(16)
      .padStart(2, '0');
  return `#${mix((parsed >> 16) & 255)}${mix((parsed >> 8) & 255)}${mix(parsed & 255)}`;
}

function coneInner(base: string, outline: string, waffle: string): SVGElement[] {
  const shapes: Array<[keyof SVGElementTagNameMap, Record<string, string | number>]> = [
    [
      'path',
      {
        d: 'M108.22,414.88l189.84,460.03c1.36,3.3,6.09,3.16,7.25-.22l159.34-463.34c.87-2.53-1.03-5.16-3.7-5.13l-349.18,3.32c-2.74.03-4.59,2.82-3.55,5.35Z',
        fill: base,
        stroke: outline,
        'stroke-linejoin': 'round',
        'stroke-width': 20,
      },
    ],
    [
      'path',
      {
        d: 'M261.93,482.48h0c15.03-15.03,4.46-40.72-16.79-40.83h0c-21.37-.11-32.14,25.72-17.03,40.83h0c9.34,9.34,24.48,9.34,33.82,0Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M384.85,527.49l-51.82,51.82c-2.24,2.24-2.24,5.86,0,8.1l55.71,55.71c2.24,2.24,5.86,2.24,8.1,0h0c.62-.62,1.08-1.36,1.37-2.19l26.52-77.11c.71-2.07.18-4.36-1.37-5.91l-30.41-30.41c-2.24-2.24-5.86-2.24-8.1,0Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M371.7,684.58l-25.94,25.94c-2.24,2.24-2.24,5.86,0,8.1l12.67,12.67c2.99,2.99,8.09,1.82,9.46-2.19l13.28-38.61c1.97-5.74-5.17-10.2-9.46-5.91Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M159.42,564.14l2.73,6.83c1.52,3.82,6.46,4.83,9.37,1.93l2.05-2.05c2.24-2.24,2.24-5.86,0-8.1l-4.78-4.78c-4.4-4.4-11.67.39-9.37,6.17Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M243.92,633.11l-48.65-48.65c-5.24-5.24-13.74-5.24-18.99,0h0c-3.8,3.8-4.97,9.49-2.98,14.47l27.77,69.54c3.58,8.95,15.14,11.33,21.96,4.51l20.89-20.89c5.24-5.24,5.24-13.74,0-18.99Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M211.32,533.1h0c14.11-14.11,14.11-36.98,0-51.08l-34.94-34.94c-.72-.72-.72-1.89,0-2.62h0c1.16-1.16.34-3.15-1.3-3.16l-11.23-.06c-25.62-.13-43.23,25.72-33.73,49.51l5.37,13.45c1.82,4.55,4.54,8.68,8,12.15l16.74,16.74c14.11,14.11,36.98,14.11,51.08,0Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M263.74,792.53h0c-5.69,5.69-7.45,14.23-4.46,21.71l22.5,56.36c6.92,17.34,31.68,16.74,37.75-.92l8.66-25.2c2.5-7.28.64-15.35-4.8-20.79l-31.17-31.17c-7.87-7.87-20.62-7.87-28.48,0Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M392.94,503.07l40.81-40.81c2.24-2.24,5.86-2.24,8.1,0l.06.06c2.24,2.24,2.24,5.86,0,8.1l-40.81,40.81c-2.24,2.24-2.24,5.86,0,8.1l22.48,22.48c2.99,2.99,8.09,1.82,9.46-2.19l30.71-89.32c1.27-3.71-1.47-7.57-5.39-7.59l-120.63-.6c-5.11-.03-7.69,6.16-4.08,9.77l51.18,51.18c2.24,2.24,5.86,2.24,8.1,0Z',
        fill: waffle,
      },
    ],
  ];
  const rects = [
    [274.59, 463.59, 84.73, 95.66, 42.36, 'translate(-268.79 373.91) rotate(-45)'],
    [291.06, 603.84, 72.24, 90.24, 36.12, 'translate(-363.06 421.43) rotate(-45)'],
    [217.18, 527.25, 72.24, 95.66, 36.12, 'translate(-332.45 347.55) rotate(-45)'],
    [236.26, 661.25, 67.04, 90.24, 33.52, 'translate(-420.46 397.65) rotate(-45)'],
  ] as const;
  const result = shapes.map(([tag, attrs]) => svgEl(tag, attrs));
  result.push(
    ...rects.map(([x, y, width, height, radius, transform]) =>
      svgEl('rect', {
        x,
        y,
        width,
        height,
        rx: radius,
        ry: radius,
        transform,
        fill: waffle,
      })
    ),
    svgEl('ellipse', {
      cx: 288.37,
      cy: 404.38,
      rx: 182.34,
      ry: 67.01,
      fill: base,
      stroke: outline,
      'stroke-miterlimit': 10,
      'stroke-width': 20,
    })
  );
  return result;
}

function scoopInner(fill: string, outline: string): SVGElement[] {
  return [
    svgEl('path', {
      d: 'M566.75,340.67c0-29.85-12.97-56.87-33.96-76.47,4.8-9.98,7.44-20.71,7.44-31.9,0-38.29-30.62-71.33-74.92-86.77.33-3.07.51-6.17.51-9.3,0-69.72-84.29-126.24-188.26-126.24s-188.26,56.52-188.26,126.24c0,4,.29,7.95.83,11.86-34.94,15.4-58.48,44.25-58.48,77.34,0,18.21,7.15,34.25,19.39,49.26-25.1,19.88-41.05,49.47-41.05,82.54,0,59.85,52.15,108.37,116.49,108.37,10.83,0,21.3-1.4,31.26-3.98,31.42,41.91,83.55,69.34,142.55,69.34,64.73,0,121.2-33,151.11-81.94,63.8-.57,115.34-48.85,115.34-108.34Z',
      fill,
      stroke: outline,
      'stroke-width': 20,
    }),
  ];
}

function fillToPupilScale(fill: number): number {
  if (fill <= 50) return 1;
  if (fill >= 85) return 2.2;
  return 1 + ((fill - 50) / 35) * 1.2;
}

function eyeOpen(cx: number, side: 'l' | 'r', pupilRadius: number): SVGGElement {
  return svgEl(
    'g',
    { class: `eye-blink eye-${side}` },
    svgEl('circle', { cx, cy: 50, r: 38, fill: '#fff', stroke: '#000', 'stroke-width': 4 }),
    svgEl(
      'g',
      { class: `pupil pupil-${side}` },
      svgEl('circle', { cx, cy: 50, r: pupilRadius, fill: '#000' }),
      svgEl('circle', {
        cx: cx - pupilRadius * 0.3,
        cy: 50 - pupilRadius * 0.35,
        r: pupilRadius * 0.4,
        fill: '#fff',
      })
    )
  );
}

function eyeDead(cx: number): SVGElement[] {
  return [
    svgEl('circle', { cx, cy: 50, r: 38, fill: '#fff', stroke: '#000', 'stroke-width': 4 }),
    svgEl('line', {
      x1: cx - 15,
      y1: 35,
      x2: cx + 15,
      y2: 65,
      stroke: '#000',
      'stroke-width': 8,
      'stroke-linecap': 'round',
    }),
    svgEl('line', {
      x1: cx + 15,
      y1: 35,
      x2: cx - 15,
      y2: 65,
      stroke: '#000',
      'stroke-width': 8,
      'stroke-linecap': 'round',
    }),
  ];
}

function place(pupil: Element, cx: number, mx: number, my: number, maxOffset: number): void {
  const dx = mx - cx;
  const dy = my - 50;
  const distance = Math.hypot(dx, dy);
  const clamped = Math.min(distance, maxOffset);
  const tx = distance > 0 ? (dx / distance) * clamped : 0;
  const ty = distance > 0 ? (dy / distance) * clamped : 0;
  pupil.setAttribute('transform', `translate(${tx},${ty})`);
}

export class SliccAgentAvatar extends HTMLElement {
  static readonly observedAttributes = ['type', 'color', 'eyes', 'fill'];

  readonly #root: ShadowRoot;
  readonly #onPointerMove = (event: PointerEvent): void => this.#track(event);
  readonly #onMotionChange = (): void => this.#syncTracking();
  #motionQuery: MediaQueryList | null = null;
  #pupilL: Element | null = null;
  #pupilR: Element | null = null;
  #eyesSvg: SVGSVGElement | null = null;
  #maxOffset = MAX_OFFSET;
  #tracking = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.#motionQuery.addEventListener('change', this.#onMotionChange);
    this.#render();
    this.#syncTracking();
  }

  disconnectedCallback(): void {
    this.#stopTracking();
    this.#motionQuery?.removeEventListener('change', this.#onMotionChange);
    this.#motionQuery = null;
  }

  attributeChangedCallback(): void {
    if (!this.isConnected) return;
    this.#render();
    this.#syncTracking();
  }

  #render(): void {
    const type = this.getAttribute('type') === 'cone' ? 'cone' : 'scoop';
    const config = TYPE[type];
    const color = this.getAttribute('color') ?? DEFAULT_COLOR[type];
    const eyes = this.getAttribute('eyes');
    const fill = Math.max(
      0,
      Math.min(100, Number.parseFloat(this.getAttribute('fill') ?? '0') || 0)
    );
    const pupilRadius = PUPIL_R * fillToPupilScale(fill);
    this.#maxOffset = Math.max(2, Math.min(MAX_OFFSET, LEFT_EYE.r - pupilRadius - 4));
    const eyeX = (config.eyes.left + config.eyes.width / 2) / 100;
    const eyeY = (config.eyes.top + config.eyes.height / 2) / 100;
    const glyphInner =
      type === 'cone'
        ? coneInner(color, shade(color, -0.38), shade(color, 0.3))
        : scoopInner(color, shade(color, -0.32));
    const glyph = svgEl(
      'svg',
      {
        class: 'glyph',
        viewBox: config.vb,
        preserveAspectRatio: 'xMidYMid meet',
        style: `--g:${config.glyph}%`,
      },
      ...glyphInner
    );
    const eyeBody =
      eyes === 'dead'
        ? [...eyeDead(LEFT_EYE.cx), ...eyeDead(RIGHT_EYE.cx)]
        : eyes === 'none'
          ? []
          : [eyeOpen(LEFT_EYE.cx, 'l', pupilRadius), eyeOpen(RIGHT_EYE.cx, 'r', pupilRadius)];
    this.#eyesSvg = svgEl(
      'svg',
      {
        class: 'eyes-svg',
        viewBox: '0 0 200 100',
        width: '100%',
        height: '100%',
        preserveAspectRatio: 'xMidYMid meet',
      },
      ...eyeBody
    );
    const eyeBand = h('span', {
      class: 'eyes',
      style: `top:${config.eyes.top}%;left:${config.eyes.left}%;width:${config.eyes.width}%;height:${config.eyes.height}%`,
    });
    eyeBand.append(this.#eyesSvg);
    const inner = h(
      'span',
      {
        class: 'icon-inner',
        style: `--tx:${((0.5 - config.zoom * eyeX) * 100).toFixed(2)}%;--ty:${((0.5 - config.zoom * eyeY) * 100).toFixed(2)}%;--zoom:${config.zoom}`,
      },
      glyph,
      eyeBand
    );
    this.#root.replaceChildren(h('span', { class: 'avatar', 'aria-hidden': 'true' }, inner));
    this.#pupilL = this.#root.querySelector('.pupil-l');
    this.#pupilR = this.#root.querySelector('.pupil-r');
  }

  #syncTracking(): void {
    const shouldTrack = this.getAttribute('eyes') === 'open' && !this.#motionQuery?.matches;
    if (shouldTrack && !this.#tracking) {
      this.ownerDocument.addEventListener('pointermove', this.#onPointerMove);
      this.#tracking = true;
    } else if (!shouldTrack) {
      this.#stopTracking();
      this.#centerPupils();
    }
  }

  #stopTracking(): void {
    if (!this.#tracking) return;
    this.ownerDocument.removeEventListener('pointermove', this.#onPointerMove);
    this.#tracking = false;
  }

  #centerPupils(): void {
    this.#pupilL?.setAttribute('transform', 'translate(0,0)');
    this.#pupilR?.setAttribute('transform', 'translate(0,0)');
  }

  #track(event: PointerEvent): void {
    if (!this.#eyesSvg || !this.#pupilL || !this.#pupilR) return;
    const bounds = this.#eyesSvg.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const mx = (event.clientX - bounds.left) * (200 / bounds.width);
    const my = (event.clientY - bounds.top) * (100 / bounds.height);
    place(this.#pupilL, LEFT_EYE.cx, mx, my, this.#maxOffset);
    place(this.#pupilR, RIGHT_EYE.cx, mx, my, this.#maxOffset);
  }
}

define('slicc-agent-avatar', SliccAgentAvatar);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-agent-avatar': SliccAgentAvatar;
  }
}
