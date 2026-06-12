import { define } from '../internal/define.js';
import { append, h } from '../internal/dom.js';

/**
 * Scoped, document-level stylesheet for `<slicc-action-card>`, lifted verbatim
 * from the prototype's in-chat tool / git / PR card rules
 * (proto/StellarRubySwift.html `.tcard` / `.tcard.light` / `.prcard`).
 *
 * Light-DOM components cannot carry an inline `<style>` in a shadow root, so the
 * chrome is injected once into the host document (idempotent) and selected by
 * the host tag + scoped host class (`.slicc-action-card`). Everything is
 * var-driven (`--canvas`, `--line`, `--ink`, `--txt-2`, `--txt-3`, `--ghost`,
 * `--ui`, `--mono`, `--cyan`, `--violet`, `--amber`) so dark mode flips
 * automatically via the inherited theme scope — except the `.tb` terminal body,
 * which is intentionally a fixed dark shell surface (`#0c0c0e`), and the PR
 * brand hues (`#1f2328`, `#1a7f37`, `#cf222e`), which are fixed by design.
 */
const STYLE = `
slicc-action-card { display: block; }

/* in-chat tool / terminal / git card (.tcard) */
slicc-action-card .tcard {
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  margin: 2px 0 18px;
  background: var(--canvas);
}
slicc-action-card .tcard .th {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  font-family: var(--ui);
  font-size: 11px;
  color: var(--txt-2);
}
slicc-action-card .tcard .th .ic {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  font-size: 10px;
  /* --canvas, not #fff: --ink flips near-white in dark mode. */
  color: var(--canvas, #fff);
  background: var(--ink);
  flex: 0 0 auto;
}
slicc-action-card .tcard .th .ic.cy { background: var(--cyan); }
slicc-action-card .tcard .th .ic.vi { background: var(--violet); }
slicc-action-card .tcard .th .ic.am { background: var(--amber); }
slicc-action-card .tcard .th .ic.gh { background: #1f2328; }
slicc-action-card .tcard .th .nm { color: var(--ink); font-weight: 500; }
slicc-action-card .tcard .th .badge {
  margin-left: auto;
  font-size: 9px;
  border-radius: 26px;
  padding: 1px 8px;
  background: var(--ghost);
  color: var(--txt-2);
}
slicc-action-card .tcard .tb {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.65;
  padding: 10px 12px;
  background: #0c0c0e;
  color: #d6d6da;
  white-space: pre-wrap;
  overflow: auto;
}
slicc-action-card .tcard .tb .p { color: #7dd3fc; }
slicc-action-card .tcard .tb .ok { color: #22c55e; }
slicc-action-card .tcard .tb .mut { color: #8a8a92; }
slicc-action-card .tcard .tb .add { color: #22c55e; }
slicc-action-card .tcard .tb .del { color: #f87171; }
slicc-action-card .tcard .tb .warn { color: #fbbf24; }
slicc-action-card .tcard.light .tb { background: var(--canvas); color: var(--ink); }

/* PR card (.prcard) */
slicc-action-card .prcard {
  border: 1px solid var(--line);
  border-radius: 12px;
  margin: 2px 0 18px;
  background: var(--canvas);
  overflow: hidden;
}
slicc-action-card .prcard .ph {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 13px;
  font-family: var(--ui);
}
slicc-action-card .prcard .ph .gi {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: #1f2328;
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 12px;
  flex: 0 0 auto;
}
slicc-action-card .prcard .ph .pt { font-weight: 600; font-size: 13.5px; color: var(--ink); }
slicc-action-card .prcard .ph .pn { font-family: var(--ui); color: var(--txt-3); font-size: 12px; }
slicc-action-card .prcard .ph .open {
  margin-left: auto;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: #1a7f37;
  border-radius: 26px;
  padding: 3px 10px;
}
slicc-action-card .prcard .pmeta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 0 13px 12px;
  font-family: var(--ui);
  font-size: 11px;
  color: var(--txt-2);
}
slicc-action-card .prcard .pmeta b { color: var(--ink); }
slicc-action-card .prcard .pmeta .add { color: #1a7f37; }
slicc-action-card .prcard .pmeta .del { color: #cf222e; }
`;

const STYLE_ID = 'slicc-action-card-style';

/** Inject the scoped action-card stylesheet into a document once (idempotent). */
function ensureActionCardStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** The three card forms. `tool`/`light` render `.tcard`; `pr` renders `.prcard`. */
export type ActionCardVariant = 'tool' | 'light' | 'pr';

/** Icon glyph-chip tones for the `.tcard` header (`.ic` background). */
export type ActionCardTone = 'ink' | 'cy' | 'vi' | 'am' | 'gh';

const VARIANTS: ReadonlySet<string> = new Set(['tool', 'light', 'pr']);
const TONES: ReadonlySet<string> = new Set(['ink', 'cy', 'vi', 'am', 'gh']);

/**
 * `<slicc-action-card>` — the in-chat tool / git / PR card lifted from the
 * prototype chat stream (`.tcard` / `.tcard.light` / `.prcard`). Three forms,
 * selected by `variant`:
 *
 * - `tool` (default) — a `.tcard` with a `.th` header (a square `.ic` glyph chip
 *   tinted by `tone`, a `.nm` title, and an optional right-aligned `.badge`) over
 *   a `.tb` dark monospace terminal body. The body hosts slotted output spans:
 *   `.p` prompt, `.ok` success, `.mut` muted, `.add`/`.del` diff lines, `.warn`.
 * - `light` — identical to `tool` but the `.tb` body renders on the canvas
 *   surface (`var(--canvas)` / `var(--ink)`) instead of the dark terminal shell.
 * - `pr` — a `.prcard` with a `.ph` header (a `.gi` GitHub chip, a `.pt` title,
 *   a `.pn` number, and a green `.open` status pill) plus a `.pmeta` stats row
 *   (branch → main, file count, `+add` / `−del` deltas, checks). The header and
 *   meta come from attributes, but `pmeta`/`meta` slotted content overrides them.
 *
 * Light DOM (no shadow root): the host renders its own scaffold and relocates
 * light children into the body region so the host app can style it and slot
 * richer markup. The scoped chrome is injected once into the host document and
 * selected by the `slicc-action-card` tag + host class.
 *
 * The container is token-driven, so dark mode flips automatically. The `.tb`
 * terminal body stays a fixed dark shell (`#0c0c0e`) in the `tool` variant, and
 * the PR brand hues (`#1f2328` / `#1a7f37` / `#cf222e`) are fixed by design.
 *
 * @attr variant - `tool` (default) | `light` | `pr`; selects the card form
 * @attr glyph - the `.ic` glyph chip text (tool/light header), escaped
 * @attr tone - `ink` (default) | `cy` | `vi` | `am` | `gh`; the `.ic` chip tint
 * @attr title - the `.nm` (tool/light) or `.pt` (pr) header title, escaped
 * @attr badge - optional right-aligned `.badge` pill text (tool/light), escaped
 * @attr number - the PR `.pn` number text (e.g. `#128`), escaped
 * @attr status - the PR `.open` status pill text (default `Open`), escaped
 * @attr branch - the PR head→base branch summary (e.g. `warm-hero → main`)
 * @attr files - the PR file-count number (rendered bold + ` files`), escaped
 * @attr add - the PR `+add` delta count (e.g. `38` → `+38`), escaped
 * @attr del - the PR `−del` delta count (e.g. `21` → `−21`), escaped
 * @attr checks - the PR checks summary (e.g. `✓ passing`), escaped
 * @csspart card - the outer card chrome (`.tcard` or `.prcard`)
 * @csspart header - the header region (`.th` or `.ph`)
 * @csspart icon - the glyph chip (`.ic` for tool/light, `.gi` for pr)
 * @csspart title - the title text (`.nm` or `.pt`)
 * @csspart badge - the tool/light `.badge` pill
 * @csspart body - the tool/light `.tb` terminal body (the slot host)
 * @csspart status - the PR `.open` status pill
 * @csspart meta - the PR `.pmeta` stats row
 * @slot - default terminal body content (tool/light), relocated into `.tb`
 * @slot body - explicit alias for the default terminal body slot (tool/light)
 * @slot meta - overrides the PR `.pmeta` stats row content (pr)
 * @fires slicc-action-card-change - composed + bubbling; `detail.variant` on variant change
 */
export class SliccActionCard extends HTMLElement {
  static readonly observedAttributes = [
    'variant',
    'glyph',
    'tone',
    'title',
    'badge',
    'number',
    'status',
    'branch',
    'files',
    'add',
    'del',
    'checks',
  ];

  /** Slotted light children captured at first connect, re-homed on every render. */
  #slotted: ChildNode[] = [];
  #built = false;

  connectedCallback(): void {
    ensureActionCardStyle(this.ownerDocument);
    this.classList.add('slicc-action-card');
    this.#capture();
    this.#render();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.isConnected || oldValue === newValue) return;
    this.#render();
    if (name === 'variant') {
      this.dispatchEvent(
        new CustomEvent('slicc-action-card-change', {
          bubbles: true,
          composed: true,
          detail: { variant: this.variant },
        })
      );
    }
  }

  /** The card form — `tool` (default), `light`, or `pr`. */
  get variant(): ActionCardVariant {
    const v = this.getAttribute('variant');
    return v && VARIANTS.has(v) ? (v as ActionCardVariant) : 'tool';
  }

  set variant(value: ActionCardVariant) {
    this.setAttribute('variant', VARIANTS.has(value) ? value : 'tool');
  }

  /** The `.ic` glyph-chip text (tool/light header). */
  get glyph(): string | null {
    return this.getAttribute('glyph');
  }

  set glyph(value: string | null) {
    if (value == null) this.removeAttribute('glyph');
    else this.setAttribute('glyph', value);
  }

  /** The `.ic` chip tint — `ink` (default), `cy`, `vi`, `am`, or `gh`. */
  get tone(): ActionCardTone {
    const t = this.getAttribute('tone');
    return t && TONES.has(t) ? (t as ActionCardTone) : 'ink';
  }

  set tone(value: ActionCardTone) {
    this.setAttribute('tone', TONES.has(value) ? value : 'ink');
  }

  /** The header title (`.nm` for tool/light, `.pt` for pr). */
  get title(): string {
    return this.getAttribute('title') ?? '';
  }

  set title(value: string | null) {
    if (value == null) this.removeAttribute('title');
    else this.setAttribute('title', value);
  }

  /** Optional right-aligned `.badge` pill (tool/light). */
  get badge(): string | null {
    return this.getAttribute('badge');
  }

  set badge(value: string | null) {
    if (value == null) this.removeAttribute('badge');
    else this.setAttribute('badge', value);
  }

  /** The PR `.pn` number text (e.g. `#128`). */
  get number(): string | null {
    return this.getAttribute('number');
  }

  set number(value: string | null) {
    if (value == null) this.removeAttribute('number');
    else this.setAttribute('number', value);
  }

  /** The PR `.open` status pill text (default `Open`). */
  get status(): string | null {
    return this.getAttribute('status');
  }

  set status(value: string | null) {
    if (value == null) this.removeAttribute('status');
    else this.setAttribute('status', value);
  }

  /** The PR head→base branch summary (e.g. `warm-hero → main`). */
  get branch(): string | null {
    return this.getAttribute('branch');
  }

  set branch(value: string | null) {
    if (value == null) this.removeAttribute('branch');
    else this.setAttribute('branch', value);
  }

  /** The PR file-count number. */
  get files(): string | null {
    return this.getAttribute('files');
  }

  set files(value: string | null) {
    if (value == null) this.removeAttribute('files');
    else this.setAttribute('files', value);
  }

  /** The PR `+add` delta count (rendered as `+<add>`). */
  get add(): string | null {
    return this.getAttribute('add');
  }

  set add(value: string | null) {
    if (value == null) this.removeAttribute('add');
    else this.setAttribute('add', value);
  }

  /** The PR `−del` delta count (rendered as `−<del>`). */
  get del(): string | null {
    return this.getAttribute('del');
  }

  set del(value: string | null) {
    if (value == null) this.removeAttribute('del');
    else this.setAttribute('del', value);
  }

  /** The PR checks summary (e.g. `✓ passing`). */
  get checks(): string | null {
    return this.getAttribute('checks');
  }

  set checks(value: string | null) {
    if (value == null) this.removeAttribute('checks');
    else this.setAttribute('checks', value);
  }

  #render(): void {
    const variant = this.variant;
    if (variant === 'pr') this.#renderPr();
    else this.#renderTool(variant === 'light');
  }

  /** Render the `.tcard` (`tool`/`light`) form with the terminal body slot. */
  #renderTool(light: boolean): void {
    const glyph = this.glyph;
    const tone = this.tone;
    const title = this.title;
    const badge = this.badge;
    const iconClass = tone === 'ink' ? 'ic' : `ic ${tone}`;

    const header = h('div', { class: 'th', part: 'header' });
    append(header, [
      h('span', { class: iconClass, part: 'icon' }, glyph != null ? glyph : null),
      // Preserve the literal space that separated the chip from the title.
      ' ',
      h('span', { class: 'nm', part: 'title' }, title),
      badge != null ? h('span', { class: 'badge', part: 'badge' }, badge) : null,
    ]);

    const body = h('div', { class: 'tb', part: 'body' });
    body.append(...this.#slotted);

    const cardClass = light ? 'tcard light' : 'tcard';
    const card = h('div', { class: cardClass, part: 'card' }, header, body);

    this.replaceChildren(card);
  }

  /** Render the `.prcard` (`pr`) form: `.ph` header + `.pmeta` stats row. */
  #renderPr(): void {
    const title = this.title;
    const number = this.number;
    const status = this.status ?? 'Open';
    const branch = this.branch;
    const files = this.files;
    const add = this.add;
    const del = this.del;
    const checks = this.checks;

    const header = h('div', { class: 'ph', part: 'header' });
    append(header, [
      h('span', { class: 'gi', part: 'icon' }, '⎇'),
      h('span', { class: 'pt', part: 'title' }, title),
      number != null ? h('span', { class: 'pn', part: 'number' }, number) : null,
      h('span', { class: 'open', part: 'status' }, status),
    ]);

    const meta = h('div', { class: 'pmeta', part: 'meta' });

    // A `meta` slot wins over the attribute-derived stats row.
    const metaSlot = this.#slotted.filter(
      (n) => n instanceof HTMLElement && n.getAttribute('slot') === 'meta'
    );

    if (metaSlot.length > 0) {
      meta.append(...metaSlot);
    } else {
      append(meta, [
        branch != null ? h('span', null, branch) : null,
        files != null ? h('span', null, h('b', null, files), ' files') : null,
        add != null ? h('span', { class: 'add' }, `+${add}`) : null,
        del != null ? h('span', { class: 'del' }, `−${del}`) : null,
        checks != null
          ? h('span', null, 'checks ', h('b', { style: 'color:#1a7f37' }, checks))
          : null,
      ]);
    }

    const card = h('div', { class: 'prcard', part: 'card' }, header, meta);
    this.replaceChildren(card);
  }

  /**
   * Capture the host's original light children once, before we own the subtree,
   * so each re-render can re-home them into the body region. Idempotent across
   * re-connects.
   */
  #capture(): void {
    if (this.#built) return;
    this.#built = true;
    this.#slotted = Array.from(this.childNodes);
  }
}

define('slicc-action-card', SliccActionCard);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-action-card': SliccActionCard;
  }
  interface HTMLElementEventMap {
    'slicc-action-card-change': CustomEvent<{ variant: ActionCardVariant }>;
  }
}
