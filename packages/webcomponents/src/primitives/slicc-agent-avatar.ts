import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PUPIL_R = 18;
const MAX_OFFSET = 16;

const TYPE = {
  cone: {
    viewBox: '70 330 440 570',
    eyes: { top: -18.5, left: 17, width: 70, height: 44 },
    zoom: 3,
  },
  scoop: {
    viewBox: '0 0 580 470',
    eyes: { top: 30, left: 15, width: 70, height: 45 },
    zoom: 2.65,
  },
} as const;

const DEFAULT_COLOR = { cone: '#D2691E', scoop: '#FFB6C1' } as const;
const LEFT_EYE = { cx: 55, cy: 50, r: 38 } as const;
const RIGHT_EYE = { cx: 145, cy: 50, r: 38 } as const;

const STYLE = `
:host{position:relative;display:block;width:26px;height:26px;overflow:hidden;pointer-events:none;--icon-tint:color-mix(in oklab,var(--accent) 30%,#fff);}
:host-context(.dark),:host-context([data-theme='dark']){--icon-tint:color-mix(in oklab,var(--accent) 22%,transparent);}
*{box-sizing:border-box;}
.icon{position:absolute;inset:0;overflow:hidden;background:radial-gradient(135% 145% at 20% 78%,var(--icon-tint) 42%,transparent 75%);}
.icon-inner{position:absolute;inset:0;transform-origin:0 0;transform:translate(var(--tx),var(--ty)) scale(var(--zoom));}
.glyph{position:absolute;left:50%;top:50%;width:96%;height:96%;overflow:visible;transform:translate(-50%,-50%);}
.eyes{position:absolute;pointer-events:none;}.eyes-svg{display:block;overflow:visible;}
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
  const normalized = value.length === 3 ? [...value].map((part) => part + part).join('') : value;
  const parsed = Number.parseInt(normalized, 16);
  if (!Number.isFinite(parsed)) return hex;
  const target = amount < 0 ? 0 : 255;
  const mix = (channel: number): string =>
    Math.round(channel + (target - channel) * Math.abs(amount))
      .toString(16)
      .padStart(2, '0');
  return `#${mix((parsed >> 16) & 255)}${mix((parsed >> 8) & 255)}${mix(parsed & 255)}`;
}

function coneGlyph(base: string): SVGElement[] {
  const outline = shade(base, -0.38);
  const waffle = shade(base, 0.3);
  return [
    svgEl('path', {
      d: 'M108.22,414.88l189.84,460.03c1.36,3.3,6.09,3.16,7.25-.22l159.34-463.34c.87-2.53-1.03-5.16-3.7-5.13l-349.18,3.32c-2.74.03-4.59,2.82-3.55,5.35Z',
      fill: base,
      stroke: outline,
      'stroke-linejoin': 'round',
      'stroke-width': 20,
    }),
    svgEl('path', {
      d: 'M137 488l248 248M177 447l229 229M162 611l167-167M205 714l187-187M249 817l119-119',
      fill: 'none',
      stroke: waffle,
      'stroke-linecap': 'round',
      'stroke-width': 24,
    }),
    svgEl('ellipse', {
      cx: 288.37,
      cy: 404.38,
      rx: 182.34,
      ry: 67.01,
      fill: base,
      stroke: outline,
      'stroke-width': 20,
    }),
  ];
}

function scoopGlyph(base: string): SVGElement[] {
  return [
    svgEl('path', {
      d: 'M566.75,340.67c0-29.85-12.97-56.87-33.96-76.47,4.8-9.98,7.44-20.71,7.44-31.9,0-38.29-30.62-71.33-74.92-86.77.33-3.07.51-6.17.51-9.3,0-69.72-84.29-126.24-188.26-126.24s-188.26,56.52-188.26,126.24c0,4,.29,7.95.83,11.86-34.94,15.4-58.48,44.25-58.48,77.34,0,18.21,7.15,35.15,19.39,49.26-25.1,19.88-41.05,49.47-41.05,82.54,0,59.85,52.15,108.37,116.49,108.37,10.83,0,21.3-1.4,31.26-3.98,31.42,41.91,83.55,69.34,142.55,69.34,64.73,0,121.2-33,151.11-81.94,63.8-.57,115.34-48.85,115.34-108.34Z',
      fill: base,
      stroke: shade(base, -0.32),
      'stroke-width': 20,
    }),
  ];
}

function eyeOpen(cx: number, side: 'l' | 'r', pupilRadius: number): SVGElement {
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
    svgEl('path', {
      d: `M${cx - 15} 35l30 30m0-30l-30 30`,
      fill: 'none',
      stroke: '#000',
      'stroke-linecap': 'round',
      'stroke-width': 8,
    }),
  ];
}

function pupilScale(fill: number): number {
  if (fill <= 50) return 1;
  if (fill >= 85) return 2.2;
  return 1 + ((fill - 50) / 35) * 1.2;
}

function placePupil(
  pupil: Element,
  cx: number,
  mouseX: number,
  mouseY: number,
  maxOffset: number
): void {
  const dx = mouseX - cx;
  const dy = mouseY - 50;
  const distance = Math.hypot(dx, dy);
  const travel = Math.min(distance, maxOffset);
  const x = distance > 0 ? (dx / distance) * travel : 0;
  const y = distance > 0 ? (dy / distance) * travel : 0;
  pupil.setAttribute('transform', `translate(${x},${y})`);
}

export class SliccAgentAvatar extends HTMLElement {
  static readonly observedAttributes = ['type', 'color', 'eyes', 'fill', 'blink', 'label'];

  readonly #root: ShadowRoot;
  #eyesSvg: SVGSVGElement | null = null;
  #pupilL: Element | null = null;
  #pupilR: Element | null = null;
  #maxOffset = MAX_OFFSET;
  readonly #onMove = (event: MouseEvent): void => this.#track(event);

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
    this.ownerDocument.addEventListener('mousemove', this.#onMove);
  }

  disconnectedCallback(): void {
    this.ownerDocument.removeEventListener('mousemove', this.#onMove);
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  #render(): void {
    const type = this.getAttribute('type') === 'cone' ? 'cone' : 'scoop';
    const config = TYPE[type];
    const color = this.getAttribute('color') ?? DEFAULT_COLOR[type];
    const fill = Math.max(0, Math.min(100, Number(this.getAttribute('fill')) || 0));
    const eyeState = this.getAttribute('eyes');
    const pupilRadius = PUPIL_R * pupilScale(fill);
    this.#maxOffset = Math.max(2, Math.min(MAX_OFFSET, LEFT_EYE.r - pupilRadius - 4));
    const glyph = svgEl(
      'svg',
      { class: 'glyph', viewBox: config.viewBox, preserveAspectRatio: 'xMidYMid meet' },
      ...(type === 'cone' ? coneGlyph(color) : scoopGlyph(color))
    );
    this.#eyesSvg = null;
    const eyes = h('span', {
      class: 'eyes',
      style: `top:${config.eyes.top}%;left:${config.eyes.left}%;width:${config.eyes.width}%;height:${config.eyes.height}%`,
    });
    if (eyeState !== 'none') {
      const children =
        eyeState === 'dead'
          ? [...eyeDead(LEFT_EYE.cx), ...eyeDead(RIGHT_EYE.cx)]
          : [eyeOpen(LEFT_EYE.cx, 'l', pupilRadius), eyeOpen(RIGHT_EYE.cx, 'r', pupilRadius)];
      this.#eyesSvg = svgEl(
        'svg',
        { class: 'eyes-svg', viewBox: '0 0 200 100', width: '100%', height: '100%' },
        ...children
      );
      eyes.append(this.#eyesSvg);
    }
    const centerX = (config.eyes.left + config.eyes.width / 2) / 100;
    const centerY = (config.eyes.top + config.eyes.height / 2) / 100;
    const inner = h(
      'span',
      {
        class: 'icon-inner',
        style: `--tx:${((0.5 - config.zoom * centerX) * 100).toFixed(2)}%;--ty:${((0.5 - config.zoom * centerY) * 100).toFixed(2)}%;--zoom:${config.zoom}`,
      },
      glyph,
      eyes
    );
    this.#root.replaceChildren(
      h('span', { class: 'icon', part: 'icon', style: `--accent:${color}` }, inner)
    );
    this.setAttribute('role', 'img');
    this.setAttribute('aria-label', `${this.getAttribute('label') ?? type} avatar`);
    this.#pupilL = this.#root.querySelector('.pupil-l');
    this.#pupilR = this.#root.querySelector('.pupil-r');
  }

  #track(event: MouseEvent): void {
    if (!this.#eyesSvg || !this.#pupilL || !this.#pupilR) return;
    const bounds = this.#eyesSvg.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const mouseX = (event.clientX - bounds.left) * (200 / bounds.width);
    const mouseY = (event.clientY - bounds.top) * (100 / bounds.height);
    placePupil(this.#pupilL, LEFT_EYE.cx, mouseX, mouseY, this.#maxOffset);
    placePupil(this.#pupilR, RIGHT_EYE.cx, mouseX, mouseY, this.#maxOffset);
  }
}

define('slicc-agent-avatar', SliccAgentAvatar);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-agent-avatar': SliccAgentAvatar;
  }
}
