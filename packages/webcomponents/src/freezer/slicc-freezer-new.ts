import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { attachLongPressGesture, type LongPressHandle } from '../internal/long-press.js';

/**
 * New-chat glyph — a **lucide** `square-pen` icon rendered via the shared
 * `iconEl` helper (never emoji or bespoke unicode). Sized ~16px to sit inside
 * the 28px circular `.nico` badge; the stroke inherits `currentColor`, so the
 * badge's `--ctx` context accent drives the glyph color.
 */
const NEW_CHAT_ICON = 'square-pen';
/**
 * Busy/pending glyph — a **lucide** `loader-circle` swapped into the badge while
 * the new-chat work is in flight, spun via CSS (held static under
 * `prefers-reduced-motion`).
 */
const SPINNER_ICON = 'loader-circle';
/** Rendered lucide glyph size (px) inside the 28×28 `.nico` badge. */
const ICON_SIZE = 16;

const DEFAULT_LABEL = 'New chat';

/**
 * Double-click window (ms). A first short click is held this long to see whether
 * a second click lands; matches `<slicc-press-button>`'s default so the
 * three-state gesture (single / double / long-press) reads identically here.
 */
const DOUBLE_CLICK_MS = 350;

/**
 * The session actions, surfaced as one row of icon buttons in expanded mode:
 * `[event name, lucide icon, tooltip]`. The first three mirror the collapsed
 * badge's press gesture (`packages/webapp/src/ui/layout.ts`): single click
 * saves + extracts memories, double click skips memory (back-filled later),
 * long press erases the current chat from history. The last two exist only
 * when the host reports a cone count (`cones` attribute, #2272): a new cone
 * is always offered, dropping one only while more than one cone exists.
 */
const ACTIONS: ReadonlyArray<readonly [SessionAction, string, string]> = [
  ['new-chat-save', 'square-pen', 'New chat — save & extract memories'],
  ['new-chat-skip', 'fast-forward', 'New chat, fast — memories extracted later'],
  ['new-chat-erase', 'trash-2', 'Discard this chat — no freezer, no memories'],
  ['new-cone', 'plus', 'New cone — keep this chat, start another cone'],
  ['drop-cone', 'circle-minus', 'Drop this cone — freeze its chat, no memories'],
];

/** The three new-chat gesture outcomes (event suffix). */
type NewChatAction = 'save' | 'skip' | 'erase';
/** Every event the row can fire (the gesture outcomes plus the cone actions). */
type SessionAction = `new-chat-${NewChatAction}` | 'new-cone' | 'drop-cone';

/**
 * Per-instance stylesheet. Mirrors the prototype's `.fznew` / `.nico` / `.nlbl`
 * rules. The prototype gates the expanded geometry on the parent `.freezer.open`
 * class; here that maps to the `expanded` boolean attribute on `:host`. All
 * colors/spacing/fonts use inherited prototype tokens (--ctx, --canvas, --line,
 * --ghost, --ink, --ui) so the badge tint and dark mode adapt automatically —
 * the `--ctx` color-mix into `--canvas`/`--line` flips with the theme.
 */
const STYLE = `
:host { display: block; }
:host([hidden]) { display: none; }
*{ box-sizing: border-box; }

/* .fznew — full-width new-chat button at the top of the freezer rail */
.fznew {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 4px 8px;
  margin-bottom: 4px;
  border-radius: 8px;
  cursor: pointer;
  flex: 0 0 auto;
  background: transparent;
  border: none;
  color: var(--ink);
  font: inherit;
  font-family: var(--ui);
  text-align: left;
  width: 100%;
  transition: background-color .15s;
}
/* collapsed (icon-only) — prototype: .freezer:not(.open) .fznew */
:host(:not([expanded])) .fznew {
  gap: 0;
  justify-content: center;
  padding: 4px 0;
  width: auto;
  align-self: center;
}
.fznew:hover { background: var(--ghost); }
.fznew:focus-visible { outline: 2px solid var(--ctx); outline-offset: 2px; }

/* .nico — 28px circular icon badge, context-tinted with --ctx */
.nico {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ctx) 14%, var(--canvas));
  border: 1px solid color-mix(in srgb, var(--ctx) 40%, var(--line));
  color: var(--ctx);
  flex: 0 0 auto;
}
.nico svg { display: block; }

/* .nlbl — "New chat" label, fades in when expanded. Weight 500 (lighter than
   the prototype's 600) to sit with the rest of the rail's UI text. */
.nlbl {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0;
  transition: opacity .18s;
}
:host(:not([expanded])) .nlbl {
  width: 0;
  min-width: 0;
  flex: 0 0 0;
  overflow: hidden;
}
:host([expanded]) .nlbl {
  opacity: 1;
  transition: opacity .25s .15s;
}

/* .fznew-row — the expanded-mode action row: one 28px badge per session
   action, always in the DOM and always the same height, so hovering the rail
   never shifts the layout (#2272). Collapsed, the row is gone and the press
   gesture on the single badge is the only affordance. */
.fznew-row { display: none; }
:host([expanded]) .fznew {
  /* The expanded rail shows the row, not the single gesture badge. */
  display: none;
}
:host([expanded]) .fznew-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 4px 0;
  margin-bottom: 4px;
}
.fznew-act {
  appearance: none;
  margin: 0;
  padding: 0;
  /* Equal shares of the rail width — no trailing gap, whatever the count. */
  flex: 1 1 0;
  min-width: 0;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  cursor: pointer;
  color: var(--ctx);
  background: color-mix(in srgb, var(--ctx) 14%, var(--canvas));
  border: 1px solid color-mix(in srgb, var(--ctx) 40%, var(--line));
  transition: background-color .15s;
}
.fznew-act:hover { background: color-mix(in srgb, var(--ctx) 24%, var(--canvas)); }
.fznew-act:focus-visible { outline: 2px solid var(--ctx); outline-offset: 2px; }
.fznew-act svg { display: block; }
.fznew-act[disabled] { opacity: .45; cursor: default; }

/* .fznew-spinner — busy/pending progress: the badge glyph swaps to a spinning
   lucide loader the moment the new-chat work is kicked off (optimistically on a
   save click, or whenever the host sets the busy attribute), so there is
   immediate feedback before any save/reload completes. */
.fznew-spinner { display: grid; place-items: center; color: var(--ctx); position: relative; }
.fznew-spinner svg { display: block; animation: slicc-fznew-spin 0.8s linear infinite; }
@keyframes slicc-fznew-spin { to { transform: rotate(360deg); } }

/* .fznew-ring — determinate countdown ring drawn around the badge when the host
   drives the progress attribute (the new-session save race's 20s timer). A
   conic-gradient sweep filled to --fznew-progress (0..1) of a full turn,
   masked to a thin ring so the spinning loader still reads inside it. */
.fznew-ring {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  background: conic-gradient(
    var(--ctx) calc(var(--fznew-progress, 0) * 360deg),
    color-mix(in srgb, var(--ctx) 18%, transparent) 0
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
  pointer-events: none;
}

/* Respect prefers-reduced-motion: no fade, no spin — just hold the static end
   state (the loader glyph still shows, it simply does not rotate). The
   determinate ring stays — it conveys progress, not motion. */
@media (prefers-reduced-motion: reduce) {
  .fznew, .nlbl { transition: none; }
  .fznew-spinner svg { animation: none; }
}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-freezer-new>` — the **New Chat Affordance** at the top of the
 * prototype's freezer rail (`.fznew`): a full-width ghost-hover button wrapping
 * a 28px circular `.nico` badge (tinted with `--ctx`, the active context accent)
 * around a **lucide** `square-pen` new-chat glyph, plus a `.nlbl` "New chat"
 * label that fades in when the rail is expanded.
 *
 * The glyph is rendered via the shared `iconSvg` helper (never emoji or a
 * bespoke unicode symbol) and inherits the badge's `--ctx` color through
 * `currentColor`. Slotting a custom glyph into the named `icon` slot overrides
 * the lucide default.
 *
 * The prototype gates the expanded label on the parent `.freezer.open` class;
 * this self-contained element exposes that as the `expanded` boolean attribute.
 * Collapsed it is icon-only (label width 0, centered); expanded the label fades
 * in. The badge tint, hover ghost, and dark mode all derive from inherited
 * tokens, so theme/context changes flip it automatically. The label fade is
 * suppressed (held at its end state) under `prefers-reduced-motion: reduce`.
 *
 * The badge is a **three-state** affordance mirroring the production new-session
 * PressButton contract (same gesture core, `internal/long-press.ts`): a single
 * click saves the chat + extracts memories before starting fresh
 * (`new-chat-save`), a double click starts a new chat without memories — they are
 * back-filled later (`new-chat-skip`), and a long press (or modifier-click)
 * erases the current chat from history (`new-chat-erase`). A modifier-click that
 * lands inside the double-click window is treated as the second click.
 *
 * In expanded mode the single gesture badge is replaced by one row of icon
 * buttons — save / fast / discard, plus new-cone and drop-cone when the host
 * sets `cones` — each with a tooltip and accessible name. The row is always in
 * the DOM at a fixed height, so hovering never shifts the rail (#2272).
 * Collapsed, the press gesture on the badge is the only affordance.
 *
 * On a save activation (and whenever the host sets the `busy` attribute) the
 * badge glyph swaps to a spinning lucide loader, giving immediate "work is
 * happening" feedback before the save + reload completes; the spin is held static
 * under `prefers-reduced-motion: reduce`.
 *
 * When the memory decision is not the user's to make (the host runs a
 * background memory curator — agentic memory), the `no-skip` attribute reduces
 * the affordance to TWO outcomes: with a saved transcript (`save`) and without
 * (`erase`). The skip row disappears from the legend, and a short click commits
 * `save` immediately — no double-click deferral window, so the common gesture
 * gets faster too. Long press / modifier-click stays `erase`.
 *
 * @attr expanded - boolean; swaps the gesture badge for the action row
 * @attr cones - number; how many cones the host has. Absent hides both cone
 *   actions; any value shows new-cone; a value above 1 also shows drop-cone
 * @attr label - the label text / accessible name (default "New chat")
 * @attr no-skip - boolean; two-outcome mode — hides the skip row and commits a
 *   short click as `save` immediately (no double-click window)
 * @attr busy - boolean; swaps the badge glyph for a spinning loader (entered
 *   optimistically on a save click; also host-drivable)
 * @attr progress - number 0..1; while busy, draws a determinate countdown ring
 *   around the badge filled to this fraction (host-driven by the save race's
 *   20s timer). Absent → the busy state is the plain indeterminate spinner.
 * @csspart button - the inner `<button>` element (the `.fznew` node)
 * @csspart badge - the circular `.nico` icon badge
 * @csspart icon - the lucide `<svg>` glyph inside the badge
 * @csspart spinner - the busy-state spinner wrapper around the loader glyph
 * @csspart ring - the determinate progress ring drawn around the spinner
 * @csspart label - the `.nlbl` text span
 * @csspart row - the `.fznew-row` action row (expanded only)
 * @csspart action-new-chat-save / action-new-chat-skip / action-new-chat-erase /
 *   action-new-cone / action-drop-cone - the row's buttons
 * @slot icon - overrides the default lucide glyph inside the badge
 * @slot - default slot overrides the label text
 * @fires new-chat-save - single click: save + extract memories, then new chat
 * @fires new-chat-skip - double click: new chat without memories (back-filled)
 * @fires new-chat-erase - long press / modifier-click: new chat erasing this one
 * @fires new-cone - row only: start another cone, keeping this chat where it is
 * @fires drop-cone - row only (cones > 1): freeze this cone's chat and remove it
 */
export class SliccFreezerNew extends HTMLElement {
  static readonly observedAttributes = [
    'expanded',
    'label',
    'busy',
    'progress',
    'no-skip',
    'cones',
  ];

  readonly #root: ShadowRoot;
  #button: HTMLButtonElement | null = null;
  /** Live gesture handle on the current button (re-armed on every render). */
  #gesture: LongPressHandle | null = null;
  /** Pending first-click timer used to disambiguate single vs double click. */
  #pendingShortTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  disconnectedCallback(): void {
    this.#gesture?.destroy();
    this.#gesture = null;
    this.#clearPendingShort();
  }

  attributeChangedCallback(name: string): void {
    // Progress updates fire on a fast timer; when the ring already exists,
    // mutate its CSS var in place rather than re-rendering — a full render
    // would rebuild the loader <svg> and restart its spin animation each tick.
    if (name === 'progress' && this.#updateProgressInPlace()) return;
    if (this.isConnected) this.#render();
  }

  /** Whether the rail is expanded (label fades in). Reflected to `expanded`. */
  get expanded(): boolean {
    return this.hasAttribute('expanded');
  }

  set expanded(value: boolean) {
    this.toggleAttribute('expanded', value);
  }

  /** Label text / accessible name (reflected to the `label` attribute). */
  get label(): string {
    return this.getAttribute('label') ?? DEFAULT_LABEL;
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /**
   * Two-outcome mode: the skip row is hidden and a short click commits `save`
   * immediately (no double-click window). Reflected to the `no-skip` attribute.
   */
  get noSkip(): boolean {
    return this.hasAttribute('no-skip');
  }

  set noSkip(value: boolean) {
    this.toggleAttribute('no-skip', value);
  }

  /**
   * How many cones the host has, or `null` when cone management is not
   * offered (attribute absent — the default, and what a follower or a host
   * that opted out of `multiple-cones` leaves). Any count shows the new-cone
   * action; a count above one also shows drop-cone. Reflected to `cones`.
   */
  get cones(): number | null {
    const raw = this.getAttribute('cones');
    if (raw == null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  set cones(value: number | null) {
    if (value == null) this.removeAttribute('cones');
    else this.setAttribute('cones', String(Math.max(0, Math.floor(value))));
  }

  /**
   * Busy/pending state. When set, the badge glyph swaps to a spinning loader so
   * there is immediate "work is happening" feedback. Hosts can drive it directly
   * (`el.busy = true` before the async save), and a save click also enters it
   * optimistically. Reflected to the `busy` attribute.
   */
  get busy(): boolean {
    return this.hasAttribute('busy');
  }

  set busy(value: boolean) {
    this.toggleAttribute('busy', value);
  }

  /**
   * Determinate progress (0..1) for the busy-state countdown ring. `null`
   * (attribute absent) → the plain indeterminate spinner. Out-of-range values
   * are clamped. Reflected to the `progress` attribute; only renders a ring
   * while {@link busy}.
   */
  get progress(): number | null {
    const raw = this.getAttribute('progress');
    if (raw == null) return null;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
  }

  set progress(value: number | null) {
    if (value == null) this.removeAttribute('progress');
    else this.setAttribute('progress', String(Math.min(1, Math.max(0, value))));
  }

  /**
   * Fast-path for streaming `progress` updates: if the ring is already in the
   * DOM (busy + progress present), just update its `--fznew-progress` var and
   * skip the full re-render. Returns false when a full render is needed to add
   * or remove the ring (busy/progress just toggled).
   */
  #updateProgressInPlace(): boolean {
    const ring = this.#root.querySelector('.fznew-ring') as HTMLElement | null;
    if (!ring || !this.busy || !this.hasAttribute('progress')) return false;
    ring.style.setProperty('--fznew-progress', String(this.progress ?? 0));
    return true;
  }

  #render(): void {
    const label = this.label;
    const busy = this.busy;
    const showRing = busy && this.hasAttribute('progress');

    const glyph = busy
      ? h(
          'span',
          { class: 'fznew-spinner', part: 'spinner' },
          showRing
            ? h('span', {
                class: 'fznew-ring',
                part: 'ring',
                style: `--fznew-progress:${this.progress ?? 0}`,
              })
            : null,
          iconEl(SPINNER_ICON, { size: ICON_SIZE, part: 'icon' })
        )
      : h('slot', { name: 'icon' }, iconEl(NEW_CHAT_ICON, { size: ICON_SIZE, part: 'icon' }));
    const badge = h('span', { class: 'nico', part: 'badge' }, glyph);
    const labelNode = h('span', { class: 'nlbl', part: 'label' }, h('slot', null, label));

    const button = h(
      'button',
      {
        class: 'fznew',
        part: 'button',
        type: 'button',
        'aria-label': label,
        title: label,
        'aria-busy': busy ? 'true' : undefined,
      },
      badge,
      labelNode
    ) as HTMLButtonElement;

    this.#button = button;
    this.#attachGesture(button);
    this.#root.replaceChildren(button, this.#buildRow(busy, showRing));
  }

  /**
   * Build the expanded-mode action row: one icon badge per session action,
   * each with a tooltip + accessible name. Hidden by CSS unless `[expanded]`.
   * The save badge carries the busy spinner / progress ring so the feedback
   * is the same whichever mode the rail is in.
   */
  #buildRow(busy: boolean, showRing: boolean): HTMLElement {
    const row = h('div', {
      class: 'fznew-row',
      part: 'row',
      role: 'group',
      'aria-label': this.label,
    });
    for (const [action, icon, text] of this.#visibleActions()) {
      const isSave = action === 'new-chat-save';
      const glyph =
        isSave && busy
          ? h(
              'span',
              { class: 'fznew-spinner' },
              showRing
                ? h('span', {
                    class: 'fznew-ring',
                    style: `--fznew-progress:${this.progress ?? 0}`,
                  })
                : null,
              iconEl(SPINNER_ICON, { size: ICON_SIZE })
            )
          : iconEl(icon, { size: ICON_SIZE });
      const btn = h(
        'button',
        {
          class: `fznew-act fznew-act--${action}`,
          part: `action-${action}`,
          type: 'button',
          title: text,
          'aria-label': text,
          'aria-busy': isSave && busy ? 'true' : undefined,
        },
        glyph
      );
      // While a session action is in flight every OTHER action is a race:
      // New chat and Drop cone both archive, clear and (for a drop) unregister
      // a cone, guarded only by their own separate in-flight flags, and their
      // read-modify-write of the freezer index would interleave. `busy` is the
      // one signal that a run is open, so it disables the whole row, not just
      // the badge it spins.
      (btn as HTMLButtonElement).disabled = busy;
      btn.addEventListener('click', () => {
        if (this.busy) return;
        this.#emit(action);
      });
      row.appendChild(btn);
    }
    return row;
  }

  /** The actions the row shows for the current `no-skip` / `cones` state. */
  #visibleActions(): ReadonlyArray<readonly [SessionAction, string, string]> {
    const cones = this.cones;
    return ACTIONS.filter(([action]) => {
      if (action === 'new-chat-skip') return !this.noSkip;
      if (action === 'new-cone') return cones !== null;
      if (action === 'drop-cone') return cones !== null && cones > 1;
      return true;
    });
  }

  /**
   * Arm the three-state press gesture on the button, re-using the shared
   * long-press contract and layering the same double-click deferral
   * `<slicc-press-button>` uses: a first short click is held for
   * {@link DOUBLE_CLICK_MS} to see whether a second click lands (→ `skip`),
   * otherwise it commits as `save`; a long press / modifier-click is `erase`
   * (unless a double-click is already pending, in which case the modifier-click
   * is the second click → `skip`).
   */
  #attachGesture(button: HTMLButtonElement): void {
    this.#gesture?.destroy();
    this.#clearPendingShort();
    this.#gesture = attachLongPressGesture(button, {
      onLongPress: () => {
        if (this.#pendingShortTimer !== null) {
          this.#clearPendingShort();
          this.#emit('new-chat-skip');
          return;
        }
        this.#emit('new-chat-erase');
      },
      onShortClick: () => {
        // Two-outcome mode: no skip exists, so there is nothing to
        // disambiguate — commit the save immediately instead of holding the
        // click for the double-click window.
        if (this.noSkip) {
          this.#emit('new-chat-save');
          return;
        }
        if (this.#pendingShortTimer !== null) {
          this.#clearPendingShort();
          this.#emit('new-chat-skip');
          return;
        }
        this.#pendingShortTimer = setTimeout(() => {
          this.#pendingShortTimer = null;
          this.#emit('new-chat-save');
        }, DOUBLE_CLICK_MS);
      },
    });
  }

  #clearPendingShort(): void {
    if (this.#pendingShortTimer !== null) {
      clearTimeout(this.#pendingShortTimer);
      this.#pendingShortTimer = null;
    }
  }

  /** Dispatch the composed, bubbling session-action event. */
  #emit(type: SessionAction): void {
    // Optimistic progress: a save kicks off a save + memory-extract + reload, so
    // surface the spinner immediately on activation (before the host does any
    // async work / reload). The host may also drive `busy` directly.
    if (type === 'new-chat-save') this.busy = true;
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
  }
}

define('slicc-freezer-new', SliccFreezerNew);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-freezer-new': SliccFreezerNew;
  }
  interface HTMLElementEventMap {
    'new-chat-save': CustomEvent<void>;
    'new-chat-skip': CustomEvent<void>;
    'new-chat-erase': CustomEvent<void>;
    'new-cone': CustomEvent<void>;
    'drop-cone': CustomEvent<void>;
  }
}
