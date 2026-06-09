import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';
import { iconSvg } from '../internal/icons.js';

/**
 * Confetti-sprinkle colors for the drifting particle field behind the dip,
 * lifted verbatim from the prototype `sprinkleField` (`cols`).
 */
const SPRINKLE_COLORS = ['#f43f5e', '#f59e0b', '#06b6d4', '#8b5cf6', '#ec4899', '#22c55e'] as const;
/** Particle count (prototype `for(let i=0;i<46;…)`). */
const PARTICLE_COUNT = 46;
/** Cursor-attraction radius in CSS px (prototype `72`). */
const ATTRACT_RADIUS = 72;
/** 2π. */
const TAU = 6.283185;

/** A single drifting sprinkle particle. */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  rv: number;
  s: number;
  col: string;
}

/** Uniform random in `[a, b)`. */
function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/**
 * The default canvas swatch group (prototype `pgrid[data-grp="canvas"]`):
 * warm page backgrounds, the first one pre-selected.
 */
const CANVAS_SWATCHES = [
  { color: '#faf6f1', label: 'paper' },
  { color: '#fff7ed', label: 'cream' },
  { color: '#f5f3ff', label: 'lilac' },
  { color: '#fef2f2', label: 'blush' },
] as const;

/**
 * The default accent swatch group (prototype `pgrid[data-grp="accent"]`):
 * vivid brand hues, the last one (`cone`) pre-selected.
 */
const ACCENT_SWATCHES = [
  { color: '#8b5cf6', label: 'violet' },
  { color: '#f43f5e', label: 'rose' },
  { color: '#06b6d4', label: 'cyan' },
  { color: '#ef7000', label: 'cone' },
] as const;

let dipSeq = 0;

/**
 * Per-instance stylesheet, lifted verbatim from the prototype dip
 * (`proto/StellarRubySwift.html` — `.dip`, `.sprk`, `.dh`, `.sg`, `.nm`, `.tag`,
 * `.dbody`, `.dprompt`, `.pgrid`, `.dfoot`, `.dapply`, `.dnote`). The hue token
 * `--c` (falling back to `--violet`) tints the header glyph chip (a lucide
 * `sparkles` icon) and the tag
 * pill; the frosted header and the swatch surfaces mix over the inherited
 * `--canvas`. Tokens (`--c`, `--canvas`, `--line`, `--violet`, `--ink`,
 * `--txt-2`, `--ui`) inherit through the shadow boundary and are NOT redeclared.
 */
const STYLE = `
:host {
  position: relative;
  display: block;
  border: 1px solid var(--line);
  border-radius: 13px;
  overflow: hidden;
  margin: 14px 0 6px;
  background: var(--canvas);
  box-shadow: rgba(10, 10, 10, .05) 0 4px 14px -6px;
  font-family: var(--ui);
}
canvas.sprk {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  display: block;
  pointer-events: none;
}
.dh, .dbody { position: relative; z-index: 1; }
.dh {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 13px;
  border-bottom: 1px solid var(--line);
  font-family: var(--ui);
  font-size: 12px;
  color: var(--txt-2);
  background: color-mix(in srgb, var(--canvas) 82%, transparent);
  backdrop-filter: blur(2px);
}
.sg {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: #fff;
  background: var(--c, var(--violet));
}
.sg svg { display: block; }
.nm { color: var(--ink); font-weight: 500; }
.tag {
  margin-left: auto;
  font-size: 10px;
  color: var(--c, var(--violet));
  background: color-mix(in srgb, var(--c, var(--violet)) 12%, #fff);
  border: 1px solid color-mix(in srgb, var(--c, var(--violet)) 30%, var(--line));
  border-radius: 26px;
  padding: 2px 9px;
}
.dbody { padding: 13px; }
.dprompt { font-size: 13px; color: var(--ink); margin: 0 0 11px; }
.pgrid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}
.pgrid.accent { margin-top: -2px; }
.dfoot { display: flex; align-items: center; gap: 10px; }
.dapply {
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: var(--violet);
  border: none;
  border-radius: 9999px;
  padding: 8px 16px;
  cursor: pointer;
}
.dapply:hover { filter: brightness(1.08); }
.dapply:focus-visible { outline: 2px solid var(--violet); outline-offset: 2px; }
.dnote { font-size: 11.5px; color: var(--txt-2); }
/* dark: the tag pill mixes over --canvas instead of #fff (prototype body.dark .dip .dh .tag) */
:host-context(.dark) .tag,
:host-context([data-theme="dark"]) .tag {
  background: color-mix(in srgb, var(--c, var(--violet)) 22%, var(--canvas));
  border-color: color-mix(in srgb, var(--c, var(--violet)) 38%, var(--line));
}
@media (prefers-reduced-motion: reduce) {
  canvas.sprk { display: none; }
}
`;

/** A swatch descriptor for one selectable palette cell. */
interface Swatch {
  readonly color: string;
  readonly label: string;
}

/**
 * `<slicc-dip>` — the in-chat interactive "Sprinkle Dip" card from the prototype
 * Hero-studio sprinkle (`proto/StellarRubySwift.html` — `.dip`). A rounded card
 * with a frosted `.dh` header (accent glyph chip `.sg` holding a lucide
 * `sparkles` icon, filename `.nm`, and a
 * `sprinkle · dip` `.tag` pill), a `.dbody` holding a `.dprompt` line and two
 * four-column `.pgrid` swatch grids (a `canvas` group and an `accent` group),
 * and a `.dfoot` with the `.dapply` apply button and a `.dnote` selection
 * summary. A drifting, cursor-reactive 2D particle field (`canvas.sprk`) sits
 * behind the content at `z-index: 0`.
 *
 * The swatch cells are composed BY TAG as `<slicc-palette-cell>` slotted
 * children — one per swatch, grouped by `group="canvas:<id>"` / `group="accent:<id>"`
 * (the per-instance id keeps two dips on the same page from clearing each
 * other's selection). The dip listens for the cells' composed, bubbling
 * `palette-select` events to keep the `.dnote` summary and its selection state
 * in sync; clicking `.dapply` emits a composed, bubbling `slicc-dip-apply`
 * carrying `{ canvas, accent }` (the chosen `{ color, label }` of each group).
 *
 * The particle field honors `prefers-reduced-motion: reduce` (no canvas, no
 * RAF loop) and pauses on disconnect (the loop cancels and the pointer / resize
 * listeners are removed).
 *
 * @attr name - the dip filename shown in the header `.nm` (default `palette.shtml`)
 * @attr hue - the accent hue (`--c`) tinting the glyph chip and tag pill
 * @attr prompt - the `.dprompt` instruction line (HTML-escaped)
 * @csspart card - the host card surface (also styleable via the element itself)
 * @csspart header - the frosted `.dh` header row
 * @csspart glyph - the accent `.sg` glyph chip
 * @csspart name - the filename `.nm`
 * @csspart tag - the `sprinkle · dip` `.tag` pill
 * @csspart body - the `.dbody`
 * @csspart prompt - the `.dprompt` line
 * @csspart grid-canvas - the canvas-group `.pgrid`
 * @csspart grid-accent - the accent-group `.pgrid`
 * @csspart apply - the `.dapply` button
 * @csspart note - the `.dnote` summary
 * @slot prompt - overrides the `.dprompt` content
 * @slot canvas - overrides the canvas-group cells (else composed from defaults)
 * @slot accent - overrides the accent-group cells (else composed from defaults)
 * @fires slicc-dip-apply - `{ canvas, accent }` chosen swatches, on Apply
 */
export class SliccDip extends HTMLElement {
  static readonly observedAttributes = ['name', 'hue', 'prompt'];

  readonly #root: ShadowRoot;
  readonly #id = `d${++dipSeq}`;

  #canvas: HTMLCanvasElement | null = null;
  #ctx: CanvasRenderingContext2D | null = null;
  #raf = 0;
  #ro: ResizeObserver | null = null;
  #particles: Particle[] = [];
  #w = 0;
  #h = 0;
  #mx = -999;
  #my = -999;

  #onPointerMove: ((e: PointerEvent) => void) | null = null;
  #onPointerLeave: (() => void) | null = null;
  #onSelect: ((e: Event) => void) | null = null;
  #onApply: (() => void) | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.#render();
    this.#bind();
    this.#startField();
  }

  disconnectedCallback(): void {
    this.#stopField();
    this.#unbind();
  }

  attributeChangedCallback(): void {
    if (!this.isConnected) return;
    this.#render();
    this.#bind();
    this.#startField();
  }

  /** The dip filename shown in the header (`.nm`). */
  get name(): string {
    return this.getAttribute('name') ?? 'palette.shtml';
  }

  set name(value: string | null) {
    if (value == null) this.removeAttribute('name');
    else this.setAttribute('name', value);
  }

  /** The accent hue (`--c`) tinting the glyph chip and tag pill. */
  get hue(): string | null {
    return this.getAttribute('hue');
  }

  set hue(value: string | null) {
    if (value == null) this.removeAttribute('hue');
    else this.setAttribute('hue', value);
  }

  /** The `.dprompt` instruction line. */
  get prompt(): string | null {
    return this.getAttribute('prompt');
  }

  set prompt(value: string | null) {
    if (value == null) this.removeAttribute('prompt');
    else this.setAttribute('prompt', value);
  }

  /** The currently selected canvas swatch, if any. */
  get selectedCanvas(): Swatch | null {
    return this.#selectedIn(`canvas:${this.#id}`);
  }

  /** The currently selected accent swatch, if any. */
  get selectedAccent(): Swatch | null {
    return this.#selectedIn(`accent:${this.#id}`);
  }

  #selectedIn(group: string): Swatch | null {
    const cell = this.querySelector<HTMLElement>(
      `slicc-palette-cell[group="${CSS.escape(group)}"][selected]`
    );
    if (!cell) return null;
    return { color: cell.getAttribute('color') ?? '', label: cell.getAttribute('label') ?? '' };
  }

  /** Build the light-DOM swatch cells for one group (composed BY TAG). */
  #buildGroup(group: string, swatches: readonly Swatch[], selectedLabel: string): void {
    const slotName = group.startsWith('canvas') ? 'canvas' : 'accent';
    if (this.querySelector(`slicc-palette-cell[slot="${slotName}"]`)) return; // user-supplied
    for (const sw of swatches) {
      const cell = this.ownerDocument.createElement('slicc-palette-cell');
      cell.setAttribute('slot', slotName);
      cell.setAttribute('color', sw.color);
      cell.setAttribute('label', sw.label);
      cell.setAttribute('group', group);
      if (sw.label === selectedLabel) cell.setAttribute('selected', '');
      this.appendChild(cell);
    }
  }

  #render(): void {
    const hue = this.hue;
    const styleHue = hue ? ` style="--c:${escapeHtml(hue)}"` : '';
    const promptHtml = this.prompt
      ? escapeHtml(this.prompt)
      : 'Tune the hero&rsquo;s <b>canvas</b> &amp; <b>accent</b>, then apply:';

    this.#root.innerHTML =
      `<style>${STYLE}</style>` +
      '<canvas class="sprk" part="field" aria-hidden="true"></canvas>' +
      `<div class="dh" part="header"${styleHue}>` +
      `<span class="sg" part="glyph">${iconSvg('sparkles', { size: 12 })}</span>` +
      `<span class="nm" part="name">${escapeHtml(this.name)}</span>` +
      '<span class="tag" part="tag">sprinkle · dip</span>' +
      '</div>' +
      `<div class="dbody" part="body"${styleHue}>` +
      `<p class="dprompt" part="prompt"><slot name="prompt">${promptHtml}</slot></p>` +
      '<div class="pgrid canvas" part="grid-canvas"><slot name="canvas"></slot></div>' +
      '<div class="pgrid accent" part="grid-accent"><slot name="accent"></slot></div>' +
      '<div class="dfoot">' +
      '<button class="dapply" part="apply" type="button">Apply to hero →</button>' +
      '<span class="dnote" part="note"></span>' +
      '</div></div>';

    // Compose the default swatch cells BY TAG (skipped if the user slotted any).
    this.#buildGroup(`canvas:${this.#id}`, CANVAS_SWATCHES, 'paper');
    this.#buildGroup(`accent:${this.#id}`, ACCENT_SWATCHES, 'cone');
    this.#updateNote();
  }

  /** Refresh the `.dnote` summary from the current group selections. */
  #updateNote(): void {
    const note = this.#root.querySelector('.dnote');
    if (!note) return;
    const cv = this.selectedCanvas?.label ?? 'paper';
    const ac = this.selectedAccent?.label ?? 'violet';
    note.textContent = `${cv} · ${ac}`;
  }

  #bind(): void {
    if (!this.#onSelect) {
      // Cells are slotted light-DOM children: their composed, bubbling
      // `palette-select` reaches us here. Keep the note (and selection) in sync.
      this.#onSelect = () => this.#updateNote();
      this.addEventListener('palette-select', this.#onSelect);
    }
    if (!this.#onApply) {
      this.#onApply = () => this.#apply();
    }
    const btn = this.#root.querySelector<HTMLButtonElement>('.dapply');
    btn?.addEventListener('click', this.#onApply);
  }

  #unbind(): void {
    if (this.#onSelect) {
      this.removeEventListener('palette-select', this.#onSelect);
      this.#onSelect = null;
    }
    this.#onApply = null;
  }

  /** Emit `slicc-dip-apply` with the chosen `{ canvas, accent }` swatches. */
  #apply(): void {
    this.#updateNote();
    this.dispatchEvent(
      new CustomEvent('slicc-dip-apply', {
        bubbles: true,
        composed: true,
        detail: { canvas: this.selectedCanvas, accent: this.selectedAccent },
      })
    );
  }

  /* ---- cursor-reactive sprinkle particle field (prototype `sprinkleField`) ---- */

  #prefersReducedMotion(): boolean {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  #startField(): void {
    this.#stopField();
    if (this.#prefersReducedMotion()) return;
    const cv = this.#root.querySelector<HTMLCanvasElement>('canvas.sprk');
    const ctx = cv?.getContext('2d') ?? null;
    if (!cv || !ctx) return;
    this.#canvas = cv;
    this.#ctx = ctx;
    this.#particles = [];

    this.#sizeField();
    if (typeof ResizeObserver === 'function') {
      this.#ro = new ResizeObserver(() => this.#sizeField());
      this.#ro.observe(this);
    }

    this.#onPointerMove = (e: PointerEvent) => {
      const r = this.getBoundingClientRect();
      this.#mx = e.clientX - r.left;
      this.#my = e.clientY - r.top;
    };
    this.#onPointerLeave = () => {
      this.#mx = -999;
      this.#my = -999;
    };
    this.addEventListener('pointermove', this.#onPointerMove);
    this.addEventListener('pointerleave', this.#onPointerLeave);

    this.#raf = requestAnimationFrame(() => this.#frame());
  }

  #stopField(): void {
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#ro?.disconnect();
    this.#ro = null;
    if (this.#onPointerMove) this.removeEventListener('pointermove', this.#onPointerMove);
    if (this.#onPointerLeave) this.removeEventListener('pointerleave', this.#onPointerLeave);
    this.#onPointerMove = null;
    this.#onPointerLeave = null;
  }

  /** Resize the canvas backing store to the card box and seed particles once. */
  #sizeField(): void {
    const cv = this.#canvas;
    const ctx = this.#ctx;
    if (!cv || !ctx) return;
    const r = this.getBoundingClientRect();
    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
    this.#w = r.width;
    this.#h = r.height || 90;
    cv.width = Math.max(1, Math.round(this.#w * dpr));
    cv.height = Math.max(1, Math.round(this.#h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.#particles.length) {
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        this.#particles.push({
          x: rnd(0, this.#w),
          y: rnd(0, this.#h),
          vx: rnd(-0.1, 0.1),
          vy: rnd(-0.08, 0.08),
          rot: rnd(0, TAU),
          rv: rnd(-0.014, 0.014),
          s: rnd(1.2, 2.2),
          col: SPRINKLE_COLORS[i % SPRINKLE_COLORS.length],
        });
      }
    }
  }

  /** Draw a rounded rect, falling back to arcTo where `roundRect` is absent. */
  #roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
    } else {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  /** One animation tick: integrate, wrap, and paint the sprinkles. */
  #frame(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.#w, this.#h);
    for (const p of this.#particles) {
      const dx = p.x - this.#mx;
      const dy = p.y - this.#my;
      const d2 = dx * dx + dy * dy;
      if (d2 < ATTRACT_RADIUS * ATTRACT_RADIUS) {
        const d = Math.sqrt(d2) || 1;
        const f = ((ATTRACT_RADIUS - d) / ATTRACT_RADIUS) * 0.5;
        p.vx += (dx / d) * f;
        p.vy += (dy / d) * f;
      }
      p.vx *= 0.95;
      p.vy *= 0.95;
      p.x += p.vx + 0.04;
      p.y += p.vy;
      p.rot += p.rv;
      if (p.x < -6) p.x = this.#w + 6;
      if (p.x > this.#w + 6) p.x = -6;
      if (p.y < -6) p.y = this.#h + 6;
      if (p.y > this.#h + 6) p.y = -6;
      const len = p.s * 4;
      const th = p.s * 1.55;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = p.col;
      this.#roundRect(-len / 2, -th / 2, len, th, th / 2);
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#fff';
      this.#roundRect(-len / 2 + th * 0.3, -th * 0.34, len - th * 0.6, th * 0.3, th * 0.15);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    this.#raf = requestAnimationFrame(() => this.#frame());
  }
}

define('slicc-dip', SliccDip);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-dip': SliccDip;
  }
}
