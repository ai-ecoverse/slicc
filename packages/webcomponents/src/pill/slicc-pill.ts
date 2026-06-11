import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

/**
 * Eye geometry inside the glyph SVG (viewBox `0 0 200 100`), lifted verbatim
 * from the prototype: a 38-radius sclera centred at x=55 (left) / x=145 (right),
 * y=50. The pupils track the cursor by translating within this coordinate space.
 */
const PUPIL_R = 18;
/** Maximum pupil travel in glyph-space units (prototype `MAX_OFFSET`). */
const MAX_OFFSET = 16;

/** Fill→pupil-scale ramp anchors (prototype): below 50 the pupil is flat (×1). */
const FILL_FLAT = 50;
/** At/above this fill the pupil is fully dilated (×`PUPIL_MAX`). */
const FILL_FULL = 85;
/** Maximum pupil dilation factor at full fill. */
const PUPIL_MAX = 2.2;

const LEFT_EYE = { cx: 55, cy: 50, r: 38 } as const;
const RIGHT_EYE = { cx: 145, cy: 50, r: 38 } as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an SVG-namespaced element with string attributes — no innerHTML. */
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>,
  ...children: SVGElement[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.appendChild(c);
  return el;
}

/** Per-type glyph framing: SVG viewBox, eye-band placement, and zoom factors. */
interface TypeConfig {
  /** Glyph SVG viewBox. */
  vb: string;
  /** Eye-band rectangle (percent of the icon box) the pupils live in. */
  eyes: { top: number; left: number; width: number; height: number };
  /** Resting zoom of the glyph inside the icon box. */
  zoom: number;
  /** Glyph SVG side length as a percent of the icon box. */
  glyph: number;
}

const TYPE: Record<'cone' | 'scoop', TypeConfig> = {
  cone: {
    vb: '70 330 440 570',
    eyes: { top: -18.5, left: 17, width: 70, height: 44 },
    zoom: 3.0,
    glyph: 96,
  },
  scoop: {
    vb: '0 0 580 470',
    eyes: { top: 30, left: 15, width: 70, height: 45 },
    zoom: 2.65,
    glyph: 96,
  },
};

/** Default accent per glyph type when no `color` attribute is supplied. */
const DEFAULT_COLOR: Record<'cone' | 'scoop', string> = { cone: '#D2691E', scoop: '#FFB6C1' };

/** Map a 0–100 fill level to a pupil-dilation factor (prototype `fillToPupil`). */
function fillToPupil(fill: number): number {
  if (fill <= FILL_FLAT) return 1;
  if (fill >= FILL_FULL) return PUPIL_MAX;
  return 1 + ((fill - FILL_FLAT) / (FILL_FULL - FILL_FLAT)) * (PUPIL_MAX - 1);
}

/** Parse a `#rgb`/`#rrggbb` hex string into 8-bit channels. */
function hexToRgb(h: string): { r: number; g: number; b: number } {
  let hex = h.replace('#', '');
  if (hex.length === 3)
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Clamp a channel to `[0,255]` and render it as a 2-digit hex pair. */
function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/**
 * Lighten (`amt > 0`) or darken (`amt < 0`) a hex color by mixing toward white
 * or black (prototype `shade`). Used to derive the cone outline/waffle and the
 * scoop outline from the single accent `color`.
 */
function shade(hex: string, amt: number): string {
  const { r, g, b } = hexToRgb(hex);
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  return toHex(r + (t - r) * p, g + (t - g) * p, b + (t - b) * p);
}

/** Procedural ice-cream-cone glyph (base fill, dark outline, lighter waffle). */
function coneInner(base: string, outline: string, waffle: string): SVGElement[] {
  return [
    svgEl('path', {
      d: 'M108.22,414.88l189.84,460.03c1.36,3.3,6.09,3.16,7.25-.22l159.34-463.34c.87-2.53-1.03-5.16-3.7-5.13l-349.18,3.32c-2.74.03-4.59,2.82-3.55,5.35Z',
      fill: base,
      stroke: outline,
      'stroke-linejoin': 'round',
      'stroke-width': 20,
    }),
    svgEl('path', {
      d: 'M261.93,482.48h0c15.03-15.03,4.46-40.72-16.79-40.83h0c-21.37-.11-32.14,25.72-17.03,40.83h0c9.34,9.34,24.48,9.34,33.82,0Z',
      fill: waffle,
    }),
    svgEl('path', {
      d: 'M384.85,527.49l-51.82,51.82c-2.24,2.24-2.24,5.86,0,8.1l55.71,55.71c2.24,2.24,5.86,2.24,8.1,0h0c.62-.62,1.08-1.36,1.37-2.19l26.52-77.11c.71-2.07.18-4.36-1.37-5.91l-30.41-30.41c-2.24-2.24-5.86-2.24-8.1,0Z',
      fill: waffle,
    }),
    svgEl('rect', {
      x: 274.59,
      y: 463.59,
      width: 84.73,
      height: 95.66,
      rx: 42.36,
      ry: 42.36,
      transform: 'translate(-268.79 373.91) rotate(-45)',
      fill: waffle,
    }),
    svgEl('rect', {
      x: 291.06,
      y: 603.84,
      width: 72.24,
      height: 90.24,
      rx: 36.12,
      ry: 36.12,
      transform: 'translate(-363.06 421.43) rotate(-45)',
      fill: waffle,
    }),
    svgEl('path', {
      d: 'M371.7,684.58l-25.94,25.94c-2.24,2.24-2.24,5.86,0,8.1l12.67,12.67c2.99,2.99,8.09,1.82,9.46-2.19l13.28-38.61c1.97-5.74-5.17-10.2-9.46-5.91Z',
      fill: waffle,
    }),
    svgEl('path', {
      d: 'M159.42,564.14l2.73,6.83c1.52,3.82,6.46,4.83,9.37,1.93l2.05-2.05c2.24-2.24,2.24-5.86,0-8.1l-4.78-4.78c-4.4-4.4-11.67.39-9.37,6.17Z',
      fill: waffle,
    }),
    svgEl('path', {
      d: 'M243.92,633.11l-48.65-48.65c-5.24-5.24-13.74-5.24-18.99,0h0c-3.8,3.8-4.97,9.49-2.98,14.47l27.77,69.54c3.58,8.95,15.14,11.33,21.96,4.51l20.89-20.89c5.24-5.24,5.24-13.74,0-18.99Z',
      fill: waffle,
    }),
    svgEl('path', {
      d: 'M211.32,533.1h0c14.11-14.11,14.11-36.98,0-51.08l-34.94-34.94c-.72-.72-.72-1.89,0-2.62h0c1.16-1.16.34-3.15-1.3-3.16l-11.23-.06c-25.62-.13-43.23,25.72-33.73,49.51l5.37,13.45c1.82,4.55,4.54,8.68,8,12.15l16.74,16.74c14.11,14.11,36.98,14.11,51.08,0Z',
      fill: waffle,
    }),
    svgEl('path', {
      d: 'M263.74,792.53h0c-5.69,5.69-7.45,14.23-4.46,21.71l22.5,56.36c6.92,17.34,31.68,16.74,37.75-.92l8.66-25.2c2.5-7.28.64-15.35-4.8-20.79l-31.17-31.17c-7.87-7.87-20.62-7.87-28.48,0Z',
      fill: waffle,
    }),
    svgEl('path', {
      d: 'M392.94,503.07l40.81-40.81c2.24-2.24,5.86-2.24,8.1,0l.06.06c2.24,2.24,2.24,5.86,0,8.1l-40.81,40.81c-2.24,2.24-2.24,5.86,0,8.1l22.48,22.48c2.99,2.99,8.09,1.82,9.46-2.19l30.71-89.32c1.27-3.71-1.47-7.57-5.39-7.59l-120.63-.6c-5.11-.03-7.69,6.16-4.08,9.77l51.18,51.18c2.24,2.24,5.86,2.24,8.1,0Z',
      fill: waffle,
    }),
    svgEl('rect', {
      x: 217.18,
      y: 527.25,
      width: 72.24,
      height: 95.66,
      rx: 36.12,
      ry: 36.12,
      transform: 'translate(-332.45 347.55) rotate(-45)',
      fill: waffle,
    }),
    svgEl('path', {
      d: 'M350.28,739.46h0c-9.24-9.24-24.22-9.24-33.46,0l-13.94,13.94c-9.24,9.24-9.24,24.22,0,33.46l6.81,6.81c12.37,12.37,33.42,7.5,39.1-9.04l7.13-20.75c2.94-8.55.75-18.03-5.64-24.42Z',
      fill: waffle,
    }),
    svgEl('path', {
      d: 'M234.18,749.12l13.2,33.06c1.52,3.82,6.46,4.83,9.37,1.93l9.93-9.93c2.24-2.24,2.24-5.86,0-8.1l-23.13-23.13c-4.4-4.4-11.67.39-9.37,6.17Z',
      fill: waffle,
    }),
    svgEl('rect', {
      x: 236.26,
      y: 661.25,
      width: 67.04,
      height: 90.24,
      rx: 33.52,
      ry: 33.52,
      transform: 'translate(-420.46 397.65) rotate(-45)',
      fill: waffle,
    }),
    svgEl('ellipse', {
      cx: 288.37,
      cy: 404.38,
      rx: 182.34,
      ry: 67.01,
      fill: base,
      stroke: outline,
      'stroke-miterlimit': 10,
      'stroke-width': 20,
    }),
  ];
}

/** Procedural scoop (cloud-blob) glyph (fill + dark outline). */
function scoopInner(fill: string, outline: string): SVGElement[] {
  return [
    svgEl('path', {
      d: 'M566.75,340.67c0-29.85-12.97-56.87-33.96-76.47,4.8-9.98,7.44-20.71,7.44-31.9,0-38.29-30.62-71.33-74.92-86.77.33-3.07.51-6.17.51-9.3,0-69.72-84.29-126.24-188.26-126.24s-188.26,56.52-188.26,126.24c0,4,.29,7.95.83,11.86-34.94,15.4-58.48,44.25-58.48,77.34,0,18.21,7.15,35.15,19.39,49.26-25.1,19.88-41.05,49.47-41.05,82.54,0,59.85,52.15,108.37,116.49,108.37,10.83,0,21.3-1.4,31.26-3.98,31.42,41.91,83.55,69.34,142.55,69.34,64.73,0,121.2-33,151.11-81.94,63.8-.57,115.34-48.85,115.34-108.34Z',
      fill,
      stroke: outline,
      'stroke-width': 20,
    }),
  ];
}

/** A live (open) eye: white sclera, black pupil with a catchlight highlight. */
function eyeOpen(cx: number, cy: number, r: number, side: 'l' | 'r', pr: number): SVGElement[] {
  // The wrapper g.eye-blink is the blink squash target (`:host([blink])`);
  // dead eyes are built without it, so they can never blink.
  return [
    svgEl(
      'g',
      { class: `eye-blink eye-${side}` },
      svgEl('circle', { cx, cy, r, fill: '#fff', stroke: '#000', 'stroke-width': 4 }),
      svgEl(
        'g',
        { class: `pupil pupil-${side}` },
        svgEl('circle', { cx, cy, r: pr, fill: '#000' }),
        svgEl('circle', {
          cx: cx - pr * 0.3,
          cy: cy - pr * 0.35,
          r: pr * 0.4,
          fill: '#fff',
        })
      )
    ),
  ];
}

/** A dead eye: white sclera crossed by an "X". */
function eyeDead(cx: number, cy: number, r: number): SVGElement[] {
  return [
    svgEl('circle', { cx, cy, r, fill: '#fff', stroke: '#000', 'stroke-width': 4 }),
    svgEl('line', {
      x1: cx - 15,
      y1: cy - 15,
      x2: cx + 15,
      y2: cy + 15,
      stroke: '#000',
      'stroke-width': 8,
      'stroke-linecap': 'round',
    }),
    svgEl('line', {
      x1: cx + 15,
      y1: cy - 15,
      x2: cx - 15,
      y2: cy + 15,
      stroke: '#000',
      'stroke-width': 8,
      'stroke-linecap': 'round',
    }),
  ];
}

/** Compose the eye-band SVG for the given state (`none` renders nothing). */
function eyesSvg(state: 'open' | 'none' | 'dead', pr: number): SVGSVGElement | null {
  if (state === 'none') return null;
  const L = LEFT_EYE;
  const R = RIGHT_EYE;
  const body =
    state === 'dead'
      ? [...eyeDead(L.cx, L.cy, L.r), ...eyeDead(R.cx, R.cy, R.r)]
      : [...eyeOpen(L.cx, L.cy, L.r, 'l', pr), ...eyeOpen(R.cx, R.cy, R.r, 'r', pr)];
  return svgEl(
    'svg',
    {
      class: 'eyes-svg',
      viewBox: '0 0 200 100',
      width: '100%',
      height: '100%',
      preserveAspectRatio: 'xMidYMid meet',
    },
    ...body
  );
}

/**
 * Translate a pupil group toward a target point, clamped to `maxOff`
 * (prototype `place`).
 */
function place(g: Element, cx: number, cy: number, mx: number, my: number, maxOff: number): void {
  const dx = mx - cx;
  const dy = my - cy;
  const d = Math.hypot(dx, dy);
  const c = Math.min(d, maxOff);
  const tx = d > 0 ? (dx / d) * c : 0;
  const ty = d > 0 ? (dy / d) * c : 0;
  g.setAttribute('transform', `translate(${tx},${ty})`);
}

/**
 * Per-instance stylesheet. `--accent` is set inline from the `color` attribute;
 * `--label` / `--icon-tint` are the component's own self-contained tokens,
 * resolved against `prefers-color-scheme` and overridden by the `theme`
 * attribute (these are internal to the pill, NOT the inherited design tokens).
 */
const PILL_STYLE = `
  :host{position:relative;display:inline-block;--pill-w:190px;--label:#eef1f6;--icon-tint:color-mix(in oklab,var(--accent) 22%,transparent);}
  @media (prefers-color-scheme: light){:host(:not([theme="dark"])){--label:#1b2030;--icon-tint:color-mix(in oklab,var(--accent) 30%,#fff);}}
  /* The library's class-based dark scope (body.dark / .dark / [data-theme=dark])
     reaches the host via :host-context, so the label stays readable in dark mode
     even when the OS prefers-color-scheme is light. Ordered BEFORE the explicit
     theme rules so a per-element theme="light"/"dark" attribute still overrides. */
  :host-context(.dark),:host-context([data-theme="dark"]){--label:#eef1f6;--icon-tint:color-mix(in oklab,var(--accent) 22%,transparent);}
  :host([theme="light"]){--label:#1b2030;--icon-tint:color-mix(in oklab,var(--accent) 30%,#fff);}
  :host([theme="dark"]){--label:#eef1f6;--icon-tint:color-mix(in oklab,var(--accent) 22%,transparent);}
  *{box-sizing:border-box;}
  .pill{position:relative;display:inline-flex;align-items:center;gap:8px;width:var(--pill-w);font:500 13px ui-sans-serif,system-ui,-apple-system,sans-serif;color:var(--accent);background:transparent;border:1.5px solid var(--accent);border-radius:9999px;padding:0 14px 0 0;cursor:pointer;line-height:1;overflow:hidden;transition:background .2s ease,color .2s ease;}
  .pill.active{background:var(--accent);} .pill.active .label{color:#fff;}
  .pill:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  .icon{position:relative;z-index:0;width:30px;height:30px;flex:0 0 auto;background:var(--icon-tint);}
  .icon-inner{position:absolute;inset:0;transform-origin:0 0;transform:translate(var(--tx),var(--ty)) scale(var(--zoom));transition:transform .4s cubic-bezier(.34,1.4,.5,1);}
  .pill:hover .icon-inner,.pill:focus-visible .icon-inner{transform:translate(var(--ox,0%),var(--oy,0%)) scale(var(--ozoom,1));}
  .glyph{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:var(--g);height:var(--g);display:block;overflow:visible;}
  .eyes{position:absolute;pointer-events:none;} .eyes-svg{display:block;overflow:visible;}
  /* Periodic eyelid blink (mirrors slicc-googly-eyes): a quick scaleY squash.
     The two eyes run different cycle lengths so the blink drifts in and out of
     sync and never feels metronomic. Dead eyes have no .eye-blink wrapper. */
  @keyframes slicc-pill-blink{0%,92%,100%{transform:scaleY(1);}96%{transform:scaleY(0.08);}}
  :host([blink]) .eye-blink{transform-box:fill-box;transform-origin:center;animation:slicc-pill-blink 3.4s ease-in-out infinite;}
  :host([blink]) .eye-blink.eye-r{animation-duration:4.6s;}
  @media (prefers-reduced-motion: reduce){:host([blink]) .eye-blink{animation:none;}}
  .label{position:relative;z-index:1;flex:1 1 auto;min-width:0;color:var(--label);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  /* Compact chip: just the eyes/glyph (no label), with the title on hover. The
     [compact] attribute forces it; a narrow / extension-sidebar viewport (≤560px)
     applies it automatically so the header switcher fits. */
  :host([compact]) .pill{width:auto;padding:0;}
  :host([compact]) .label{display:none;}
  @media (max-width:560px){ .pill{width:auto;padding:0;} .label{display:none;} }
  /* The hover title lives on the host (the .pill clips its overflow), shown only
     in compact mode on hover/focus. Dark pill, like the prototype dock .tip. */
  .tip{position:absolute;top:calc(100% + 7px);left:50%;transform:translateX(-50%) translateY(-3px);
    background:var(--ink);color:var(--canvas,#fff);font:500 11px ui-sans-serif,system-ui,sans-serif;
    white-space:nowrap;padding:3px 8px;border-radius:6px;opacity:0;pointer-events:none;
    transition:opacity .12s ease,transform .12s ease;z-index:30;display:none;}
  :host([compact]) .tip{display:block;}
  @media (max-width:560px){ .tip{display:block;} }
  :host([compact]:hover) .tip,:host([compact]:focus-within) .tip{opacity:1;transform:translateX(-50%);}
  @media (max-width:560px){ :host(:hover) .tip,:host(:focus-within) .tip{opacity:1;transform:translateX(-50%);} }
  @media (prefers-reduced-motion: reduce){ .tip{transition:none;} }
`;
const SHEET = sheet(PILL_STYLE);

/**
 * `<slicc-pill>` — the cone/scoop identity chip from the prototype. A rounded
 * pill with a procedurally-drawn ice-cream-cone or scoop glyph (derived entirely
 * from a single accent `color`), googly eyes whose pupils track the cursor, and
 * a right-aligned label. The accent fills the pill when `active`. Self-contained
 * shadow DOM; the icon tint / label color come from the pill's own internal
 * token set, honoring `prefers-color-scheme` and the `theme` attribute override.
 *
 * The cursor-tracking `mousemove` listener is added to the document only for the
 * cone (`type="cone"`) while `eyes="open"`, and is removed on disconnect or when
 * the eye state / type changes. Scoop chips render their open eyes statically (the
 * cone is the only avatar whose eyes follow the cursor); `dead`/`none` are inert.
 *
 * @attr type - `cone` | `scoop` (default `scoop`); selects the glyph
 * @attr color - accent hex; the glyph fill, outline, waffle and border derive from it
 * @attr eyes - `open` (default) | `none` | `dead`
 * @attr blink - boolean; periodic eyelid blink on open eyes (pure CSS; no-op
 *   for `dead`/`none`, disabled under prefers-reduced-motion)
 * @attr active - boolean; fills the pill with the accent (white label)
 * @attr label - the chip text (escaped); falls back to slotted content
 * @attr pupil - explicit pupil scale `0.3`–`2.4` (wins over `fill`)
 * @attr fill - `0`–`100` "fullness"; ramps pupil dilation when `pupil` is absent
 * @attr theme - `light` | `dark`; overrides `prefers-color-scheme` for the chip tokens
 * @csspart pill - the outer button
 * @csspart icon - the square glyph well (tinted background)
 * @csspart label - the right-aligned chip text (hidden when compact / narrow)
 * @slot - label content, used when the `label` attribute is absent
 */
export class SliccPill extends HTMLElement {
  static readonly observedAttributes = [
    'type',
    'color',
    'eyes',
    'active',
    'label',
    'pupil',
    'fill',
    'theme',
  ];

  readonly #root: ShadowRoot;
  #onMove: ((e: MouseEvent) => void) | null = null;
  #pupilL: Element | null = null;
  #pupilR: Element | null = null;
  #eyesSvg: Element | null = null;
  #maxOffset = MAX_OFFSET;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
    this.#bindTracking();
  }

  disconnectedCallback(): void {
    this.#stopTracking();
  }

  attributeChangedCallback(): void {
    if (!this.isConnected) return;
    this.#render();
    this.#bindTracking();
  }

  /** Glyph type — `cone` selects the cone glyph, anything else is `scoop`. */
  get type(): 'cone' | 'scoop' {
    return this.getAttribute('type') === 'cone' ? 'cone' : 'scoop';
  }

  set type(value: 'cone' | 'scoop') {
    this.setAttribute('type', value === 'cone' ? 'cone' : 'scoop');
  }

  /** Accent color hex (glyph + border derive from it). */
  get color(): string | null {
    return this.getAttribute('color');
  }

  set color(value: string | null) {
    if (value == null) this.removeAttribute('color');
    else this.setAttribute('color', value);
  }

  /** Eye state: `open` (cursor-tracking), `none`, or `dead`. */
  get eyeState(): 'open' | 'none' | 'dead' {
    const e = this.getAttribute('eyes');
    return e === 'none' || e === 'dead' ? e : 'open';
  }

  set eyeState(value: 'open' | 'none' | 'dead') {
    this.setAttribute('eyes', value);
  }

  /** Whether the accent fills the pill. */
  get active(): boolean {
    return this.hasAttribute('active');
  }

  set active(value: boolean) {
    this.toggleAttribute('active', value);
  }

  /**
   * Compact (icon-only) chip: the label is hidden, leaving just the eyes/glyph,
   * and the label appears as a hover/focus title. A narrow viewport (≤560px)
   * applies this automatically via CSS even without the attribute.
   */
  get compact(): boolean {
    return this.hasAttribute('compact');
  }

  set compact(value: boolean) {
    this.toggleAttribute('compact', value);
  }

  /** Chip label text. */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Theme override for the chip's internal tokens. */
  get theme(): 'light' | 'dark' | null {
    const t = this.getAttribute('theme');
    return t === 'light' || t === 'dark' ? t : null;
  }

  set theme(value: 'light' | 'dark' | null) {
    if (value == null) this.removeAttribute('theme');
    else this.setAttribute('theme', value);
  }

  /**
   * Resolved pupil scale: explicit `pupil` (clamped `0.3`–`2.4`) wins; otherwise
   * derived from `fill` (0–100) via `fillToPupil`; default `1`.
   */
  get pupilScale(): number {
    const p = Number.parseFloat(this.getAttribute('pupil') ?? '');
    if (Number.isFinite(p)) return Math.max(0.3, Math.min(2.4, p));
    const f = Number.parseFloat(this.getAttribute('fill') ?? '');
    return Number.isFinite(f) ? fillToPupil(Math.max(0, Math.min(100, f))) : 1;
  }

  #render(): void {
    const t = this.type;
    const cfg = TYPE[t];
    const color = this.color ?? DEFAULT_COLOR[t];
    const active = this.active;
    const label = this.label;
    const glyphInner =
      t === 'cone'
        ? coneInner(color, shade(color, -0.38), shade(color, 0.3))
        : scoopInner(color, shade(color, -0.32));
    const e = cfg.eyes;
    const ex = (e.left + e.width / 2) / 100;
    const ey = (e.top + e.height / 2) / 100;
    const tx = ((0.5 - cfg.zoom * ex) * 100).toFixed(2);
    const ty = ((0.5 - cfg.zoom * ey) * 100).toFixed(2);
    const ex0 = e.left / 100;
    const ex1 = (e.left + e.width) / 100;
    const ey0 = e.top / 100;
    const ey1 = (e.top + e.height) / 100;
    const bx0 = Math.min(0, ex0);
    const bx1 = Math.max(1, ex1);
    const by0 = Math.min(0, ey0);
    const by1 = Math.max(1, ey1);
    const oZoom = Math.min(1, 1 / Math.max(bx1 - bx0, by1 - by0));
    const ox = ((0.5 - (oZoom * (bx0 + bx1)) / 2) * 100).toFixed(2);
    const oy = ((0.5 - (oZoom * (by0 + by1)) / 2) * 100).toFixed(2);
    const pr = PUPIL_R * this.pupilScale;
    this.#maxOffset = Math.max(2, Math.min(MAX_OFFSET, LEFT_EYE.r - pr - 4));

    const glyph = svgEl(
      'svg',
      {
        class: 'glyph',
        viewBox: cfg.vb,
        preserveAspectRatio: 'xMidYMid meet',
        style: `--g:${cfg.glyph}%`,
      },
      ...glyphInner
    );

    const eyesNode = eyesSvg(this.eyeState, pr);
    const eyes = h('span', {
      class: 'eyes',
      style: `top:${e.top}%;left:${e.left}%;width:${e.width}%;height:${e.height}%`,
    });
    if (eyesNode) eyes.append(eyesNode);

    const iconInner = h(
      'span',
      {
        class: 'icon-inner',
        style: `--tx:${tx}%;--ty:${ty}%;--zoom:${cfg.zoom};--ox:${ox}%;--oy:${oy}%;--ozoom:${oZoom.toFixed(4)}`,
      },
      glyph,
      eyes
    );

    const icon = h('span', { class: 'icon', part: 'icon' }, iconInner);

    const labelEl = h('span', { class: 'label', part: 'label' }, label != null ? label : h('slot'));

    const button = h(
      'button',
      {
        class: `pill ${active ? 'active' : ''}`,
        part: 'pill',
        style: `--accent:${color}`,
        // Compact chips hide the visible label, so name the button for a11y.
        'aria-label': label || false,
      },
      icon,
      labelEl
    );

    // The hover title (shown only in compact mode) — a host-level sibling so the
    // .pill's `overflow: hidden` can't clip it.
    const tip = label
      ? h('span', { class: 'tip', part: 'tip', 'aria-hidden': 'true' }, label)
      : null;
    this.#root.replaceChildren(button, ...(tip ? [tip] : []));

    this.#pupilL = this.#root.querySelector('.pupil-l');
    this.#pupilR = this.#root.querySelector('.pupil-r');
    this.#eyesSvg = this.#root.querySelector('.eyes-svg');
  }

  /**
   * Add/remove the document mousemove listener to match the eye state. Only the
   * cone tracks the cursor — scoop chips keep their open eyes static — so the
   * listener is bound exclusively for `type="cone"` with `eyes="open"`.
   */
  #bindTracking(): void {
    const need = this.eyeState === 'open' && this.type === 'cone';
    if (need && !this.#onMove) {
      this.#onMove = (ev: MouseEvent) => this.#track(ev);
      document.addEventListener('mousemove', this.#onMove);
    } else if (!need && this.#onMove) {
      this.#stopTracking();
    }
  }

  #stopTracking(): void {
    if (!this.#onMove) return;
    document.removeEventListener('mousemove', this.#onMove);
    this.#onMove = null;
  }

  /** Map the cursor into glyph space and place both pupils toward it. */
  #track(ev: MouseEvent): void {
    if (!this.#eyesSvg || !this.#pupilL || !this.#pupilR) return;
    const r = this.#eyesSvg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const mx = (ev.clientX - r.left) * (200 / r.width);
    const my = (ev.clientY - r.top) * (100 / r.height);
    place(this.#pupilL, LEFT_EYE.cx, LEFT_EYE.cy, mx, my, this.#maxOffset);
    place(this.#pupilR, RIGHT_EYE.cx, RIGHT_EYE.cy, mx, my, this.#maxOffset);
  }
}

define('slicc-pill', SliccPill);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-pill': SliccPill;
  }
}
