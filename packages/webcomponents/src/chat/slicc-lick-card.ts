import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

// ---------------------------------------------------------------------------
// Lifted from proto/StellarRubySwift.html (`.lick` / `.lh` / `.bell` / `.lk` /
// `.lb` CSS ~L281-285, and the `lick(kind, html)` factory ~L1575). The prototype
// markup is:
//
//   <div class="lick">
//     <div class="lh"><span class="bell">🔔</span> lick · <kind> <span class="lk">event</span></div>
//     <div class="lb"><html></div>
//   </div>
//
// The prototype's 🔔 emoji in `.bell` is replaced here by a lucide icon chosen
// by lick kind (`webhook` / `clock` for cron / `workflow`), defaulting to `bell`
// — the library never ships emoji or bespoke unicode glyphs; every symbol comes
// from lucide via the shared helper.
//
// An amber-tinted rounded card with a bell-iconed "lick · <kind>" header, an
// amber "event" pill pushed to the right (`.lk`), and a body line (`.lb`) whose
// `<b>` spans go semibold. It slides in from the right via the `lickIn` keyframe.
//
// Theming: the prototype's dark overrides keyed off `body.dark`
// (`body.dark .lick` re-mixes the amber tint over `var(--canvas)` instead of
// `#fff`, and lightens the `.lh` text to `#e5b35a`). Inside a shadow root we
// can't match `body.dark .lick`, so — exactly like `slicc-add-menu` — those
// flips are reached via `:host-context(.dark)` / `:host-context([data-theme=
// "dark"])` plus the per-element `theme="dark"` override. The light defaults are
// reproduced verbatim (amber 9% over #fff, amber-45%/line border, #9a6300 header).
// ---------------------------------------------------------------------------

/** Pixel size of the lucide header icon (replaces the prototype `🔔`). */
const HEADER_ICON_SIZE = 14;
/** Default text of the right-aligned `.lk` pill (prototype: "event"). */
const DEFAULT_EVENT_LABEL = 'event';

/**
 * Lucide header icon per lick kind — every channel the webapp's lick UI
 * renders gets a fitting glyph (a webhook a `webhook`, a cron a `clock`, a
 * session reload a counter-clockwise rotate, …). Unknown / unset kinds keep
 * the prototype's default `bell`. The icon inherits the amber header color
 * via `stroke: currentColor`.
 */
const KIND_ICON: Record<string, string> = {
  webhook: 'webhook',
  cron: 'clock',
  workflow: 'workflow',
  'session-reload': 'rotate-ccw',
  navigate: 'compass',
  upgrade: 'circle-arrow-up',
  sprinkle: 'sparkles',
  fswatch: 'eye',
  'scoop-notify': 'bell-ring',
  'scoop-idle': 'moon',
  'scoop-wait': 'hourglass',
  'sudo-request': 'key-round',
};
/** Fallback header glyph (the prototype's `🔔`, now the lucide `bell`). */
const DEFAULT_KIND_ICON = 'bell';

/** Resolve the header icon name for a lick kind (case-insensitive; default `bell`). */
function iconForKind(kind: string | null): string {
  return (kind && KIND_ICON[kind.toLowerCase()]) || DEFAULT_KIND_ICON;
}

/** The result state of a lick card: pending (no glyph), confirmed, or dismissed. */
type LickState = 'pending' | 'confirmed' | 'dismissed';
/** Lucide glyph shown for each resolved (non-pending) result state. */
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
.lk{
  margin-left:auto;border-radius:26px;background:var(--lick-pill,var(--amber));
  color:var(--lick-pill-ink,color-mix(in srgb,var(--amber) 40%,#000));font-size:9px;font-weight:700;padding:1px 7px;
}

.lb{font-size:12.5px;color:var(--ink);line-height:1.4;}
.lb ::slotted(b),.lb b{font-weight:600;}
/* Collapsed hides the body but keeps the header card visible. */
:host([collapsed]) .lb{display:none;}

@keyframes lickIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
`;
const SHEET = sheet(STYLE);

/** Hair-spaced middot separator in the "lick · <kind>" header (prototype `&middot;`). */
const MIDDOT = '·';

/**
 * `<slicc-lick-card>` — the **lick notification card** from the prototype chat
 * thread (`.lick`). A lick is an external event (webhook / cron / workflow
 * completion); this is the amber-tinted card that announces one. It has a
 * kind-iconed "lick · <kind>" header (`.lh` + `.bell`) — a `webhook` / `clock`
 * (cron) / `workflow` lucide glyph, defaulting to `bell` — an amber "event" pill
 * shoved to the right (`.lk`), and a body line (`.lb`) that slides in from the
 * right via the `lickIn` keyframe. The card is right-aligned in the chat column
 * and shrinks to its content, keeping its right edge pinned across collapse.
 *
 * Self-contained shadow DOM. All surfaces theme via inherited tokens
 * (`--amber`, `--line`, `--canvas`, `--ink`, `--ui`); dark mode flips through the
 * library's `.dark` / `[data-theme="dark"]` / `body.dark` scopes (or the
 * per-element `theme` attribute), re-mixing the amber tint over `--canvas` and
 * lightening the header to `#e5b35a`, exactly as the prototype's `body.dark`
 * overrides do.
 *
 * Set the body via the `body` attribute (escaped plain text) or, for rich markup
 * with `<b>` emphasis, project content into the default slot.
 *
 * @attr kind - the lick kind shown after "lick · " in the header (e.g. "webhook")
 * @attr event-label - text of the right-aligned amber pill (default "event")
 * @attr hue - optional CSS color for the pill (scoop-originating licks carry
 *   the scoop's accent; default stays the amber event pill)
 * @attr count - collation count; at 2+ the pill reads "<event-label> ×<count>"
 * @attr body - body text (escaped); ignored when default-slot content is present
 * @attr no-animate - disable the `lickIn` slide-in entrance (static card)
 * @attr collapsible - make the header toggle body visibility on click/Enter/Space
 * @attr collapsed - hide the body (header card stays); reflected as it toggles
 * @attr theme - `light` | `dark`; per-element override of the inherited theme
 * @attr state - result state: `pending` (default / unset, no glyph), `confirmed`
 *   (green `circle-check`), or `dismissed` (red `circle-x` + the whole card mutes)
 * @csspart card - the outer `.lick` card
 * @csspart header - the `.lh` header row
 * @csspart bell - the `.bell` span wrapping the lucide kind `<svg>` (webhook/clock/workflow/bell)
 * @csspart kind - the "lick · <kind>" label span
 * @csspart event - the right-aligned amber `.lk` pill
 * @csspart status - the `.status` span wrapping the result glyph (confirmed/dismissed)
 * @csspart body - the `.lb` body line
 * @slot - rich body content (overrides the `body` attribute); `<b>` goes semibold
 * @fires slicc-lick-toggle - {collapsed:boolean} when a collapsible card toggles
 */
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
    this.#render();
  }

  disconnectedCallback(): void {
    this.#unbindHeader();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** The lick kind shown after "lick · " in the header. */
  get kind(): string | null {
    return this.getAttribute('kind');
  }

  set kind(value: string | null) {
    if (value == null) this.removeAttribute('kind');
    else this.setAttribute('kind', value);
  }

  /** Text of the right-aligned amber `.lk` pill (default "event"). */
  get eventLabel(): string | null {
    return this.getAttribute('event-label');
  }

  set eventLabel(value: string | null) {
    if (value == null) this.removeAttribute('event-label');
    else this.setAttribute('event-label', value);
  }

  /** Body text (escaped). Ignored when default-slot content is present. */
  get body(): string | null {
    return this.getAttribute('body');
  }

  set body(value: string | null) {
    if (value == null) this.removeAttribute('body');
    else this.setAttribute('body', value);
  }

  /**
   * Collation count: how many consecutive same-kind licks this card stands
   * for. At 2+ the event pill reads `<event-label> ×<count>`. Defaults to 1.
   */
  get count(): number {
    const n = Number.parseInt(this.getAttribute('count') ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  set count(value: number) {
    if (value > 1) this.setAttribute('count', String(value));
    else this.removeAttribute('count');
  }

  /** Whether the slide-in entrance animation is suppressed. */
  get noAnimate(): boolean {
    return this.hasAttribute('no-animate');
  }

  set noAnimate(value: boolean) {
    this.toggleAttribute('no-animate', value);
  }

  /** Whether the header toggles body visibility. */
  get collapsible(): boolean {
    return this.hasAttribute('collapsible');
  }

  set collapsible(value: boolean) {
    this.toggleAttribute('collapsible', value);
  }

  /** Whether the body is hidden (header card stays visible). */
  get collapsed(): boolean {
    return this.hasAttribute('collapsed');
  }

  set collapsed(value: boolean) {
    this.toggleAttribute('collapsed', value);
  }

  /** Per-element theme override for the card tokens. */
  get theme(): 'light' | 'dark' | null {
    const t = this.getAttribute('theme');
    return t === 'light' || t === 'dark' ? t : null;
  }

  set theme(value: 'light' | 'dark' | null) {
    if (value == null) this.removeAttribute('theme');
    else this.setAttribute('theme', value);
  }

  /**
   * Result state of the lick: `pending` (default / unset, no status glyph),
   * `confirmed` (green check), or `dismissed` (red cross + muted card). Unset or
   * unrecognized attribute values read back as `pending`.
   */
  get state(): LickState {
    const s = this.getAttribute('state');
    return s === 'confirmed' || s === 'dismissed' ? s : 'pending';
  }

  set state(value: LickState | null) {
    if (value == null || value === 'pending') this.removeAttribute('state');
    else this.setAttribute('state', value);
  }

  /** Toggle the collapsed state and emit `slicc-lick-toggle` (collapsible only). */
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
    // Scoop-originating licks tint the event pill with the scoop's accent;
    // white ink reads on every palette hue. Cleared back to the amber default.
    const hue = this.getAttribute('hue');
    if (hue) {
      this.style.setProperty('--lick-pill', hue);
      this.style.setProperty('--lick-pill-ink', '#fff');
    } else {
      this.style.removeProperty('--lick-pill');
      this.style.removeProperty('--lick-pill-ink');
    }
    const baseLabel = this.eventLabel ?? DEFAULT_EVENT_LABEL;
    // Collated cards announce their multiplicity in the pill: "session-reload ×2".
    const eventLabel = count > 1 ? `${baseLabel} ×${count}` : baseLabel;
    const body = this.body;
    const collapsible = this.collapsible;

    // Header label preserves the prototype's exact "lick · <kind>" wording with
    // a hair-space around the middot. When no kind is set we still show "lick ·".
    const kindText = kind ? `lick ${MIDDOT} ${kind}` : `lick ${MIDDOT}`;

    // Header affordance: a live lucide <svg> element inside the `.bell` span,
    // chosen by lick kind (webhook / cron / workflow), defaulting to `bell`.
    const bell = h('span', { class: 'bell', part: 'bell', 'aria-hidden': true });
    bell.append(iconEl(iconForKind(kind), { size: HEADER_ICON_SIZE }));

    // The header keeps the prototype's trailing-space text nodes after the bell
    // span and after the kind label (`</span> ` / `${kindHtml} `) verbatim.
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

    // Result glyph: a confirmed/dismissed lick gets a lucide status icon pinned
    // after the pill (green check / red cross); a pending card shows none.
    const state = this.state;
    if (state !== 'pending') {
      const status = h('span', { class: 'status', part: 'status', 'aria-hidden': true });
      status.append(iconEl(STATE_ICON[state], { size: HEADER_ICON_SIZE }));
      headerRow.append(status);
    }

    // Body: rich slotted content wins; otherwise the escaped `body` attribute
    // (a text node escapes by construction — no markup interpolation).
    const bodyRow = h('div', { class: 'lb', part: 'body' }, body != null ? body : h('slot'));

    const cardEl = h('div', { class: 'lick', part: 'card' }, headerRow, bodyRow);
    this.#root.replaceChildren(cardEl);

    this.#bindHeader();
  }

  /** Wire (or unwire) the header toggle affordance to match `collapsible`. */
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
