import { define } from '../internal/define.js';

import '../memory/slicc-palette-cell.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

const SPRINKLE_COLORS = ['#f43f5e', '#f59e0b', '#06b6d4', '#8b5cf6', '#ec4899', '#22c55e'] as const;

const PARTICLE_COUNT = 46;

const ATTRACT_RADIUS = 72;

const TAU = 6.283185;

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

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

const CANVAS_SWATCHES = [
  { color: '#faf6f1', label: 'paper' },
  { color: '#fff7ed', label: 'cream' },
  { color: '#f5f3ff', label: 'lilac' },
  { color: '#fef2f2', label: 'blush' },
] as const;

const ACCENT_SWATCHES = [
  { color: '#8b5cf6', label: 'violet' },
  { color: '#f43f5e', label: 'rose' },
  { color: '#06b6d4', label: 'cyan' },
  { color: '#ef7000', label: 'cone' },
] as const;

let dipSeq = 0;

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
const SHEET = sheet(STYLE);

interface Swatch {
  readonly color: string;
  readonly label: string;
}

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
    this.#root.adoptedStyleSheets = [SHEET];
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

  get name(): string {
    return this.getAttribute('name') ?? 'palette.shtml';
  }

  set name(value: string | null) {
    if (value == null) this.removeAttribute('name');
    else this.setAttribute('name', value);
  }

  get hue(): string | null {
    return this.getAttribute('hue');
  }

  set hue(value: string | null) {
    if (value == null) this.removeAttribute('hue');
    else this.setAttribute('hue', value);
  }

  get prompt(): string | null {
    return this.getAttribute('prompt');
  }

  set prompt(value: string | null) {
    if (value == null) this.removeAttribute('prompt');
    else this.setAttribute('prompt', value);
  }

  get selectedCanvas(): Swatch | null {
    return this.#selectedIn(`canvas:${this.#id}`);
  }

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

  #buildGroup(group: string, swatches: readonly Swatch[], selectedLabel: string): void {
    const slotName = group.startsWith('canvas') ? 'canvas' : 'accent';
    if (this.querySelector(`slicc-palette-cell[slot="${slotName}"]`)) return;
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

  #defaultPromptNodes(): Node[] {
    return [
      document.createTextNode('Tune the hero’s '),
      h('b', null, 'canvas'),
      document.createTextNode(' & '),
      h('b', null, 'accent'),
      document.createTextNode(', then apply:'),
    ];
  }

  #render(): void {
    const hue = this.hue;
    const hueStyle = hue ? `--c:${hue}` : undefined;

    const promptSlot = h('slot', { name: 'prompt' });
    if (this.prompt) promptSlot.append(this.prompt);
    else promptSlot.append(...this.#defaultPromptNodes());

    this.#root.replaceChildren(
      h('canvas', { class: 'sprk', part: 'field', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'dh', part: 'header', style: hueStyle },
        h('span', { class: 'sg', part: 'glyph' }, iconEl('sparkles', { size: 12 })),
        h('span', { class: 'nm', part: 'name' }, this.name),
        h('span', { class: 'tag', part: 'tag' }, 'sprinkle · dip')
      ),
      h(
        'div',
        { class: 'dbody', part: 'body', style: hueStyle },
        h('p', { class: 'dprompt', part: 'prompt' }, promptSlot),
        h('div', { class: 'pgrid canvas', part: 'grid-canvas' }, h('slot', { name: 'canvas' })),
        h('div', { class: 'pgrid accent', part: 'grid-accent' }, h('slot', { name: 'accent' })),
        h(
          'div',
          { class: 'dfoot' },
          h('button', { class: 'dapply', part: 'apply', type: 'button' }, 'Apply to hero →'),
          h('span', { class: 'dnote', part: 'note' })
        )
      )
    );

    this.#buildGroup(`canvas:${this.#id}`, CANVAS_SWATCHES, 'paper');
    this.#buildGroup(`accent:${this.#id}`, ACCENT_SWATCHES, 'cone');
    this.#updateNote();
  }

  #updateNote(): void {
    const note = this.#root.querySelector('.dnote');
    if (!note) return;
    const cv = this.selectedCanvas?.label ?? 'paper';
    const ac = this.selectedAccent?.label ?? 'violet';
    note.textContent = `${cv} · ${ac}`;
  }

  #bind(): void {
    if (!this.#onSelect) {
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
