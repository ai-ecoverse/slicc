import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

const STYLE = `
:host{display:inline-block;}
.switcher-more{position:relative;}
.morebtn{position:relative;display:none;font:inherit;font-size:13px;font-weight:600;color:var(--txt-2);background:transparent;border:1px solid var(--line);border-radius:9999px;height:var(--ctl-h,30px);padding:0 11px;cursor:pointer;line-height:1;align-items:center;}
/* Hidden scoops with unread output. The grid's cells are 3px and already
   severity-coded, so the aggregate rides the button's own corner instead — in
   ink rather than a hue, because it stands for several agents at once. */
.morebtn[data-unread]::after{position:absolute;top:1px;right:1px;width:6px;height:6px;border-radius:50%;background:var(--ink);box-shadow:0 0 0 1.5px var(--canvas);content:'';}
.morebtn:hover{background:var(--ghost);color:var(--ink);}
:host([count]:not([count="0"])) .morebtn,.switcher-more.has-overflow .morebtn{display:inline-flex;}
.overflow-grid{display:grid;grid-template:repeat(3,3px)/repeat(3,3px);gap:2px;width:13px;height:13px;flex:0 0 13px;}
.overflow-grid-cell{display:grid;width:3px;height:3px;place-items:center;border-radius:50%;background:color-mix(in srgb,var(--txt-3) 12%,transparent);box-shadow:inset 0 0 0 .75px color-mix(in srgb,var(--txt-3) 28%,transparent);}
.overflow-grid-cell[data-dot-state="idle"]{background:var(--txt-3);box-shadow:none;}
.overflow-grid-cell[data-dot-state="broken"]{background:var(--red);box-shadow:none;}
.overflow-grid-cell[data-dot-state="working"]{background:var(--green);box-shadow:none;}
.overflow-grid-cell[data-dot-state="near-limit"]{background:var(--amber);box-shadow:none;}
.overflow-grid-cell--plus{position:relative;overflow:visible;color:var(--txt-2);background:transparent;box-shadow:none;}
.overflow-plus-bar{position:absolute;top:50%;left:50%;background:currentColor;transform:translate(-50%,-50%);}
.overflow-plus-bar--horizontal{width:4px;height:1px;}
.overflow-plus-bar--vertical{width:1px;height:4px;}
.pop{display:none;position:absolute;top:calc(100% + 6px);left:0;width:184px;z-index:20;flex-direction:column;gap:4px;}
.switcher-more.open .pop{display:flex;}
.popup-row{box-sizing:border-box;display:flex;align-items:center;gap:7px;width:100%;min-height:30px;padding:0 9px;color:var(--ink);font:500 11px/1 var(--ui);text-align:left;border:1px solid var(--line);border-radius:7px;background:var(--canvas);box-shadow:0 3px 10px color-mix(in srgb,var(--ink) 8%,transparent);cursor:pointer;animation:scoopReveal .24s ease both;animation-delay:calc(var(--i,0) * 45ms);}
.popup-label{flex:1 1 auto;}
.popup-state{color:var(--txt-3);font-size:9px;font-variant-numeric:tabular-nums;}
.status-glyph{flex:0 0 14px;width:14px;height:14px;overflow:visible;color:var(--hue);}
.glyph-base{fill:none;stroke:color-mix(in srgb,currentColor 30%,var(--line));}
.glyph-arc{fill:none;stroke:currentColor;stroke-linecap:round;transform:rotate(-90deg);transform-box:fill-box;transform-origin:center;}
.glyph-pin{fill:currentColor;}
/* Same mark, same geometry as the strip's own unread dot (see
   \`slicc-agent-tabs\`), halo in the row's surface. */
.glyph-unread{fill:var(--hue);stroke:var(--canvas);}
.popup-row[data-state="working"] .glyph-arc{animation:scoopArc 10.8s linear infinite;}
.popup-row[data-state="broken"] .status-glyph{color:var(--red);}
.broken-x{stroke:currentColor;stroke-linecap:round;}
.initializing-ring{fill:none;stroke:currentColor;stroke-dasharray:1.7 1.7;}
@keyframes scoopReveal{from{opacity:0;transform:translateY(-4px);}to{opacity:1;transform:none;}}
@keyframes scoopArc{from{transform:rotate(-90deg);}to{transform:rotate(270deg);}}
@media (prefers-reduced-motion:reduce){.popup-row{animation:none;}.popup-row[data-state="working"] .glyph-arc{animation:none;transform:rotate(-90deg);}}
`;
const SHEET = sheet(STYLE);

type OverflowDotState = 'broken' | 'near-limit' | 'working' | 'idle';
type AgentState = 'working' | 'broken' | 'initializing' | 'idle';

const GRID_FILL_ORDER = [4, 5, 3, 7, 1, 6, 2, 0, 8] as const;
const SVG_NS = 'http://www.w3.org/2000/svg';
const ARC_RADIUS = 5;
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;

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

function boundedFill(fill: number | undefined): number {
  return typeof fill === 'number' && Number.isFinite(fill) ? Math.max(0, Math.min(100, fill)) : 0;
}

function itemState(item: SliccScoopOverflowItem): AgentState {
  return item.state ?? 'idle';
}

function arcDash(fill: number): number {
  const sweep = 90 + boundedFill(fill) * 2.7;
  return (sweep / 360) * ARC_CIRCUMFERENCE;
}

function statusGlyph(state: AgentState, fill: number, unread = 0): SVGSVGElement {
  const children: SVGElement[] = [];
  if (state === 'initializing') {
    children.push(
      svgEl('circle', {
        class: 'initializing-ring',
        cx: 7,
        cy: 7,
        r: ARC_RADIUS,
        'stroke-width': 1.7,
      })
    );
  } else {
    children.push(
      svgEl('circle', {
        class: 'glyph-base',
        cx: 7,
        cy: 7,
        r: ARC_RADIUS,
        'stroke-width': 1.5,
      })
    );
  }
  if (state === 'working' || state === 'idle') {
    children.push(
      svgEl('circle', {
        class: 'glyph-arc',
        cx: 7,
        cy: 7,
        r: ARC_RADIUS,
        'stroke-width': 2,
        'stroke-dasharray': `${arcDash(fill).toFixed(3)} ${ARC_CIRCUMFERENCE.toFixed(3)}`,
        'stroke-dashoffset': 0,
      })
    );
  }
  if (state === 'working') {
    children.push(svgEl('circle', { class: 'glyph-pin', cx: 7, cy: 7, r: 1.25 }));
  }
  if (state === 'broken') {
    children.push(
      svgEl('line', {
        class: 'broken-x',
        x1: 4.8,
        y1: 4.8,
        x2: 9.2,
        y2: 9.2,
        'stroke-width': 1.8,
      }),
      svgEl('line', {
        class: 'broken-x',
        x1: 9.2,
        y1: 4.8,
        x2: 4.8,
        y2: 9.2,
        'stroke-width': 1.8,
      })
    );
  }

  if (unread > 0) {
    children.push(
      svgEl('circle', { class: 'glyph-unread', cx: 10.89, cy: 3.11, r: 2.4, 'stroke-width': 1.5 })
    );
  }
  return svgEl(
    'svg',
    {
      class: 'status-glyph',
      viewBox: '0 0 14 14',
      width: 14,
      height: 14,
      'aria-hidden': 'true',
    },
    ...children
  );
}

function itemUnread(item: SliccScoopOverflowItem): number {
  return typeof item.unread === 'number' && Number.isFinite(item.unread)
    ? Math.max(0, Math.floor(item.unread))
    : 0;
}

function dotState(item: SliccScoopOverflowItem): OverflowDotState {
  if (item.state === 'broken') return 'broken';
  if ((item.fill ?? 0) >= 75) return 'near-limit';
  if (item.state === 'working') return 'working';
  return 'idle';
}

function dotSeverity(state: OverflowDotState): number {
  if (state === 'broken') return 3;
  if (state === 'near-limit') return 2;
  if (state === 'working') return 1;
  return 0;
}

function hiddenSummary(items: SliccScoopOverflowItem[]): string {
  const worst = items.reduce<OverflowDotState>((current, item) => {
    const state = dotState(item);
    return dotSeverity(state) > dotSeverity(current) ? state : current;
  }, 'idle');
  const stateLabel = worst === 'near-limit' ? 'near context limit' : worst;
  const unread = items.reduce((total, item) => total + itemUnread(item), 0);
  const unreadLabel = unread > 0 ? `; ${unread} unread message${unread === 1 ? '' : 's'}` : '';
  return `${items.length} hidden scoop${items.length === 1 ? '' : 's'}; worst state ${stateLabel}${unreadLabel}`;
}

function gridCell(state?: OverflowDotState, plus = false): HTMLElement {
  if (plus) {
    return h(
      'span',
      { class: 'overflow-grid-cell overflow-grid-cell--plus', 'aria-hidden': 'true' },
      h('span', { class: 'overflow-plus-bar overflow-plus-bar--horizontal' }),
      h('span', { class: 'overflow-plus-bar overflow-plus-bar--vertical' })
    );
  }
  const attributes: Record<string, string> = {
    class: 'overflow-grid-cell',
    'aria-hidden': 'true',
  };
  if (state) attributes['data-dot-state'] = state;
  return h('span', attributes);
}

function overflowGrid(items: SliccScoopOverflowItem[]): HTMLElement {
  const represented = items
    .map((item, order) => ({ order, state: dotState(item) }))
    .sort((a, b) => dotSeverity(b.state) - dotSeverity(a.state) || a.order - b.order)
    .slice(0, items.length > 9 ? 8 : 9);
  const cells = Array.from({ length: GRID_FILL_ORDER.length }, () => gridCell());
  represented.forEach((entry, position) => {
    cells[GRID_FILL_ORDER[position]] = gridCell(entry.state);
  });
  if (items.length > 9) cells[GRID_FILL_ORDER.at(-1)!] = gridCell(undefined, true);
  return h(
    'span',
    {
      class: 'overflow-grid',
      role: 'img',
      'aria-label': hiddenSummary(items),
      'data-hidden-count': String(items.length),
    },
    ...cells
  );
}

export interface SliccScoopOverflowItem {
  id: string;

  label?: string;

  type?: 'cone' | 'scoop';

  color?: string;

  eyes?: 'open' | 'none' | 'dead';

  state?: 'working' | 'broken' | 'initializing' | 'idle';

  fill?: number;

  unread?: number;
}

export interface SliccScoopSelectDetail {
  id: string;

  key: string;

  label: string;
}

export class SliccScoopOverflow extends HTMLElement {
  static readonly observedAttributes = ['open'];

  readonly #root: ShadowRoot;

  #items: SliccScoopOverflowItem[] = [];

  #wrap!: HTMLDivElement;
  #moreBtn!: HTMLButtonElement;
  #moreSlot!: HTMLSlotElement;
  #pop!: HTMLDivElement;

  readonly #onDoc = (e: MouseEvent): void => {
    if (this.open && !this.contains(e.target as Node)) this.close();
  };

  readonly #onKeyDown = (e: KeyboardEvent): void => {
    if (!this.open || e.key !== 'Escape') return;
    e.preventDefault();
    this.close();
    this.#moreBtn.focus();
  };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  disconnectedCallback(): void {
    document.removeEventListener('click', this.#onDoc);
    document.removeEventListener('keydown', this.#onKeyDown);
  }

  attributeChangedCallback(name: string): void {
    if (name === 'open' && this.#wrap) this.#syncOpen();
  }

  get items(): SliccScoopOverflowItem[] {
    return this.#items;
  }

  set items(value: SliccScoopOverflowItem[]) {
    this.#items = Array.isArray(value) ? value : [];
    if (this.isConnected) this.#renderPop();
  }

  get count(): number {
    return this.#items.length;
  }

  get hasOverflow(): boolean {
    return this.#items.length > 0;
  }

  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    this.toggleAttribute('open', value);
  }

  show(): void {
    if (this.open) return;
    this.open = true;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
  }

  toggle(): void {
    this.open = !this.open;
  }

  #render(): void {
    this.#moreSlot = h('slot', { name: 'more' }, overflowGrid(this.#items)) as HTMLSlotElement;
    this.#moreBtn = h(
      'button',
      {
        class: 'morebtn',
        part: 'more',
        type: 'button',
        title: 'More scoops',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
      },
      this.#moreSlot
    ) as HTMLButtonElement;
    this.#pop = h('div', { class: 'pop', part: 'pop', role: 'menu' }) as HTMLDivElement;
    this.#wrap = h(
      'div',
      { class: 'switcher-more', part: 'wrap' },
      this.#moreBtn,
      this.#pop
    ) as HTMLDivElement;

    this.#moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.#root.replaceChildren(this.#wrap);

    this.#renderPop();
    this.#syncOpen();
  }

  #renderPop(): void {
    const n = this.#items.length;

    if (n > 0) this.setAttribute('count', String(n));
    else this.removeAttribute('count');
    this.#wrap.classList.toggle('has-overflow', n > 0);
    this.#moreBtn.setAttribute('aria-haspopup', 'true');
    const summary = hiddenSummary(this.#items);
    this.#moreBtn.setAttribute('aria-label', `${summary}. Show hidden scoops`);
    const unread = this.#items.reduce((total, item) => total + itemUnread(item), 0);
    if (unread > 0) this.#moreBtn.setAttribute('data-unread', String(unread));
    else this.#moreBtn.removeAttribute('data-unread');
    this.#moreSlot.replaceChildren(overflowGrid(this.#items));

    if (n === 0) {
      this.#pop.replaceChildren(h('slot', { name: 'empty' }));
      if (this.open) this.close();
      return;
    }

    const rows: HTMLButtonElement[] = [];
    this.#items.forEach((item, i) => {
      const id = item.id;
      const label = item.label ?? item.id;
      const state = itemState(item);
      const fill = boundedFill(item.fill);
      const unread = itemUnread(item);
      const unreadLabel = unread > 0 ? `, ${unread} unread message${unread === 1 ? '' : 's'}` : '';

      const row = h(
        'button',
        {
          class: 'popup-row',
          part: 'row',
          type: 'button',
          role: 'menuitem',
          'aria-label': `${label}: ${state}, ${fill}% context fill${unreadLabel}`,
          'data-state': state,
          'data-k': id,
          ...(unread > 0 ? { 'data-unread': String(unread) } : {}),
          style: `--hue:${item.color ?? 'var(--rose)'};--i:${i}`,
        },
        statusGlyph(state, fill, unread),
        h('span', { class: 'popup-label' }, label),
        h('span', { class: 'popup-state' }, `${state} · ${fill}%`)
      ) as HTMLButtonElement;
      row.addEventListener('click', () => {
        const k = row.dataset.k ?? '';
        const found = this.#items.find((it) => it.id === k);
        this.#select(k, found?.label ?? k);
      });
      rows.push(row);
    });
    this.#pop.replaceChildren(...rows);
  }

  #syncOpen(): void {
    const open = this.open;
    this.#wrap.classList.toggle('open', open);
    this.#moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');

    document.removeEventListener('click', this.#onDoc);
    document.removeEventListener('keydown', this.#onKeyDown);
    if (open) {
      document.addEventListener('click', this.#onDoc);
      document.addEventListener('keydown', this.#onKeyDown);
    }
  }

  #select(id: string, label: string): void {
    this.dispatchEvent(
      new CustomEvent<SliccScoopSelectDetail>('slicc-scoop-select', {
        detail: { id, key: id, label },
        bubbles: true,
        composed: true,
      })
    );
    this.close();
  }
}

define('slicc-scoop-overflow', SliccScoopOverflow);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-scoop-overflow': SliccScoopOverflow;
  }
  interface HTMLElementEventMap {
    'slicc-scoop-select': CustomEvent<SliccScoopSelectDetail>;
  }
}
