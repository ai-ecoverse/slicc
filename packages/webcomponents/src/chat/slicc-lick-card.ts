import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

const HEADER_ICON_SIZE = 14;

const DEFAULT_EVENT_LABEL = 'event';

const KIND_ICON: Record<string, string> = {
  webhook: 'webhook',
  cron: 'clock',
  workflow: 'workflow',
  bash: 'square-terminal',
  'session-reload': 'rotate-ccw',
  navigate: 'compass',
  discovery: 'radar',
  upgrade: 'circle-arrow-up',
  sprinkle: 'sparkles',

  gelatiere: 'ice-cream-cone',
  fswatch: 'eye',
  'scoop-notify': 'bell-ring',
  'scoop-idle': 'moon',
  'scoop-wait': 'hourglass',
  'sudo-request': 'key-round',
};

const DEFAULT_KIND_ICON = 'bell';

function iconForKind(kind: string | null): string {
  return (kind && KIND_ICON[kind.toLowerCase()]) || DEFAULT_KIND_ICON;
}

type LickState = 'pending' | 'confirmed' | 'dismissed';

const STATE_ICON: Record<Exclude<LickState, 'pending'>, string> = {
  confirmed: 'circle-check',
  dismissed: 'circle-x',
};

const STYLE = `
:host{
  /* Licks are right-aligned in the chat column (mirroring the lickIn slide-in
     from the right): the host is a full-width flex row that pushes the card to
     the right edge, and the card shrinks to its content. This keeps the right
     edge pinned across collapse/expand — the card width changes with content,
     but it always hugs the column's right side. */
  display:flex;justify-content:flex-end;width:100%;
  font-family:var(--ui,"adobe-clean","Inter",system-ui,sans-serif);
  /* light defaults, lifted verbatim from the prototype */
  --lick-bg:color-mix(in srgb,var(--amber) 9%,#fff);
  --lick-border:color-mix(in srgb,var(--amber) 45%,var(--line));
  --lick-head:color-mix(in srgb,var(--amber) 65%,var(--deep));
  /* result-state glyph colors (confirmed green / dismissed red). */
  --lick-confirm:#16a34a;
  --lick-dismiss:#dc2626;
}
/* Dark flips via the library's outer scopes (.dark / [data-theme="dark"] / body.dark);
   :host-context reaches the light-DOM ancestor from inside the shadow root, and the
   theme attribute is the per-element override — same pattern as slicc-add-menu. */
:host-context(.dark),:host-context([data-theme="dark"]),:host([theme="dark"]){
  --lick-bg:color-mix(in srgb,var(--amber) 18%,var(--canvas));
  --lick-border:color-mix(in srgb,var(--amber) 40%,var(--line));
  --lick-head:color-mix(in srgb,var(--amber) 75%,var(--ink));
  /* lightened result glyphs for dark surfaces, mirroring the header flip. */
  --lick-confirm:#4ade80;
  --lick-dismiss:#f87171;
}
:host([theme="light"]){
  --lick-bg:color-mix(in srgb,var(--amber) 9%,#fff);
  --lick-border:color-mix(in srgb,var(--amber) 45%,var(--line));
  --lick-head:color-mix(in srgb,var(--amber) 65%,var(--deep));
  --lick-confirm:#16a34a;
  --lick-dismiss:#dc2626;
}
*{box-sizing:border-box;}

.lick{
  margin:2px 0 16px;
  /* Shrink to content and cap the width so the right-aligned card never spans
     the full column; the body wraps within this cap. */
  max-width:85%;
  min-width:0;
  overflow:hidden;
  border:1px solid var(--lick-border);
  background:var(--lick-bg);
  border-radius:12px;
  padding:10px 12px;
  box-shadow:rgba(10,10,10,.05) 0 4px 14px -6px;
  animation:lickIn .4s ease both;
}
/* Static (no entrance) — for already-settled cards and reduced-motion. */
:host([no-animate]) .lick{animation:none;}
@media (prefers-reduced-motion: reduce){.lick{animation:none;}}
/* Dismissed cards mute: the amber tint desaturates to the neutral line/canvas
   mix (theme-aware on both ends) and the whole card dims. Placed after the theme
   blocks so it wins the token override at equal specificity in either theme. */
:host([state="dismissed"]){
  --lick-bg:color-mix(in srgb,var(--line) 8%,var(--canvas));
  --lick-border:var(--line);
}
:host([state="dismissed"]) .lick{opacity:.62;}

.lh{
  display:flex;align-items:center;gap:7px;
  min-width:0;
  font-family:var(--ui);font-size:10.5px;color:var(--lick-head);
  margin-bottom:4px;
}
/* The lucide bell icon inherits the header color via stroke:currentColor. */
.lh .bell{display:inline-flex;flex:0 0 auto;align-items:center;color:var(--lick-head);}
.lh .bell svg{display:block;}
/* Result glyph (confirmed/dismissed) sits at the header's right edge after the
   pill; it inherits its color from the per-state tokens via stroke:currentColor. */
.lh .status{display:inline-flex;flex:0 0 auto;align-items:center;margin-left:6px;}
.lh .status svg{display:block;}
:host([state="confirmed"]) .status{color:var(--lick-confirm);}
:host([state="dismissed"]) .status{color:var(--lick-dismiss);}
/* The clickable affordance only exists while collapsible. */
:host([collapsible]) .lh{cursor:pointer;user-select:none;}
.lh .kind{
  min-width:0;flex:1 1 auto;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.lk{
  margin-left:auto;border-radius:26px;background:var(--lick-pill,var(--amber));
  color:var(--lick-pill-ink,color-mix(in srgb,var(--amber) 40%,#000));font-size:9px;font-weight:700;padding:1px 7px;
  flex:0 1 auto;min-width:0;max-width:min(50%,14rem);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}

.lb{
  font-size:12.5px;color:var(--ink);line-height:1.4;
  /* A lick body is arbitrary rendered markdown (cron payloads arrive as fenced
     JSON). Nothing in it may push past the card and drag the chat column
     sideways: the body is its own min-width:0 box, long unbroken tokens break
     rather than overflow, and any slotted block is capped at the body width.
     The slotted <pre> itself wraps via the document-level sheet below —
     ::slotted() can't reach into a slotted subtree. */
  min-width:0;overflow-wrap:anywhere;
}
.lb ::slotted(*){max-width:100%;min-width:0;}
.lb ::slotted(b),.lb b{font-weight:600;}
/* Collapsed hides the body but keeps the header card visible. */
:host([collapsed]) .lb{display:none;}

@keyframes lickIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
`;
const SHEET = sheet(STYLE);

const SLOTTED_STYLE = `
slicc-lick-card pre{
  white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;
  max-width:100%;overflow-x:auto;margin:6px 0;
}
slicc-lick-card code{overflow-wrap:anywhere;word-break:break-word;}
slicc-lick-card pre code{white-space:inherit;}
slicc-lick-card a{overflow-wrap:anywhere;}
slicc-lick-card img{max-width:100%;height:auto;}
slicc-lick-card table{display:block;max-width:100%;width:fit-content;overflow-x:auto;}
slicc-lick-card > *{min-width:0;max-width:100%;}
`;

const SLOTTED_STYLE_ID = 'slicc-lick-card-slotted-style';

function ensureSlottedStyle(doc: Document): void {
  if (doc.getElementById(SLOTTED_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = SLOTTED_STYLE_ID;
  style.textContent = SLOTTED_STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const MIDDOT = '·';

export class SliccLickCard extends HTMLElement {
  static readonly observedAttributes = [
    'kind',
    'event-label',
    'body',
    'count',
    'no-animate',
    'collapsible',
    'collapsed',
    'theme',
    'hue',
    'state',
  ];

  readonly #root: ShadowRoot;
  #onHeaderClick: ((e: MouseEvent) => void) | null = null;
  #onHeaderKey: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    ensureSlottedStyle(this.ownerDocument);
    this.#render();
  }

  disconnectedCallback(): void {
    this.#unbindHeader();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  get kind(): string | null {
    return this.getAttribute('kind');
  }

  set kind(value: string | null) {
    if (value == null) this.removeAttribute('kind');
    else this.setAttribute('kind', value);
  }

  get eventLabel(): string | null {
    return this.getAttribute('event-label');
  }

  set eventLabel(value: string | null) {
    if (value == null) this.removeAttribute('event-label');
    else this.setAttribute('event-label', value);
  }

  get body(): string | null {
    return this.getAttribute('body');
  }

  set body(value: string | null) {
    if (value == null) this.removeAttribute('body');
    else this.setAttribute('body', value);
  }

  get count(): number {
    const n = Number.parseInt(this.getAttribute('count') ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  set count(value: number) {
    if (value > 1) this.setAttribute('count', String(value));
    else this.removeAttribute('count');
  }

  get noAnimate(): boolean {
    return this.hasAttribute('no-animate');
  }

  set noAnimate(value: boolean) {
    this.toggleAttribute('no-animate', value);
  }

  get collapsible(): boolean {
    return this.hasAttribute('collapsible');
  }

  set collapsible(value: boolean) {
    this.toggleAttribute('collapsible', value);
  }

  get collapsed(): boolean {
    return this.hasAttribute('collapsed');
  }

  set collapsed(value: boolean) {
    this.toggleAttribute('collapsed', value);
  }

  get theme(): 'light' | 'dark' | null {
    const t = this.getAttribute('theme');
    return t === 'light' || t === 'dark' ? t : null;
  }

  set theme(value: 'light' | 'dark' | null) {
    if (value == null) this.removeAttribute('theme');
    else this.setAttribute('theme', value);
  }

  get state(): LickState {
    const s = this.getAttribute('state');
    return s === 'confirmed' || s === 'dismissed' ? s : 'pending';
  }

  set state(value: LickState | null) {
    if (value == null || value === 'pending') this.removeAttribute('state');
    else this.setAttribute('state', value);
  }

  toggle(): void {
    if (!this.collapsible) return;
    this.collapsed = !this.collapsed;
    this.dispatchEvent(
      new CustomEvent('slicc-lick-toggle', {
        detail: { collapsed: this.collapsed },
        bubbles: true,
        composed: true,
      })
    );
  }

  #render(): void {
    const kind = this.kind ?? '';
    const count = this.count;

    const hue = this.getAttribute('hue');
    if (hue) {
      this.style.setProperty('--lick-pill', hue);
      this.style.setProperty('--lick-pill-ink', '#fff');
    } else {
      this.style.removeProperty('--lick-pill');
      this.style.removeProperty('--lick-pill-ink');
    }
    const baseLabel = this.eventLabel ?? DEFAULT_EVENT_LABEL;

    const eventLabel = count > 1 ? `${baseLabel} ×${count}` : baseLabel;
    const body = this.body;
    const collapsible = this.collapsible;

    const kindText = kind ? `lick ${MIDDOT} ${kind}` : `lick ${MIDDOT}`;

    const bell = h('span', { class: 'bell', part: 'bell', 'aria-hidden': true });
    bell.append(iconEl(iconForKind(kind), { size: HEADER_ICON_SIZE }));

    const headerProps: Record<string, string | number | boolean> = {
      class: 'lh',
      part: 'header',
    };
    if (collapsible) {
      headerProps.tabindex = '0';
      headerProps.role = 'button';
      headerProps['aria-expanded'] = this.collapsed ? 'false' : 'true';
    }
    const headerRow = h(
      'div',
      headerProps,
      bell,
      ' ',
      h('span', { class: 'kind', part: 'kind' }, `${kindText} `),
      h('span', { class: 'lk', part: 'event' }, eventLabel)
    );

    const state = this.state;
    if (state !== 'pending') {
      const status = h('span', { class: 'status', part: 'status', 'aria-hidden': true });
      status.append(iconEl(STATE_ICON[state], { size: HEADER_ICON_SIZE }));
      headerRow.append(status);
    }

    const bodyRow = h('div', { class: 'lb', part: 'body' }, body != null ? body : h('slot'));

    const cardEl = h('div', { class: 'lick', part: 'card' }, headerRow, bodyRow);
    this.#root.replaceChildren(cardEl);

    this.#bindHeader();
  }

  #bindHeader(): void {
    this.#unbindHeader();
    if (!this.collapsible) return;
    const header = this.#root.querySelector('.lh');
    if (!header) return;
    this.#onHeaderClick = () => this.toggle();
    this.#onHeaderKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggle();
      }
    };
    header.addEventListener('click', this.#onHeaderClick as EventListener);
    header.addEventListener('keydown', this.#onHeaderKey as EventListener);
  }

  #unbindHeader(): void {
    const header = this.#root.querySelector('.lh');
    if (header && this.#onHeaderClick) {
      header.removeEventListener('click', this.#onHeaderClick as EventListener);
    }
    if (header && this.#onHeaderKey) {
      header.removeEventListener('keydown', this.#onHeaderKey as EventListener);
    }
    this.#onHeaderClick = null;
    this.#onHeaderKey = null;
  }
}

define('slicc-lick-card', SliccLickCard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-lick-card': SliccLickCard;
  }
}
