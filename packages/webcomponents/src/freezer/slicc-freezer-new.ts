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
 * The three gesture actions, surfaced as a directly-clickable legend in expanded
 * mode: `[event-suffix, lucide icon, label]`. Mirrors the production new-session
 * PressButton wiring (`packages/webapp/src/ui/layout.ts`): single click saves +
 * extracts memories, double click skips memory (back-filled later), long press
 * erases the current chat from history.
 */
const OPTIONS: ReadonlyArray<readonly [NewChatAction, string, string]> = [
  ['save', 'archive', 'Save & start new'],
  ['skip', 'fast-forward', 'New chat — skip memory'],
  ['erase', 'trash-2', 'Erase & start new'],
];

/** The three new-chat gesture outcomes (event suffix). */
type NewChatAction = 'save' | 'skip' | 'erase';

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

/* .fznew-options — the three gesture actions, surfaced as a small legend of
   directly-clickable rows. Hidden at rest; in expanded mode they are revealed
   only on hover or keyboard focus (focus-within), so the rail stays calm by
   default and the legend is a discoverable hover affordance rather than
   persistent chrome. Collapsed, the press gesture on the badge is the only
   affordance. */
.fznew-options { display: none; }
:host([expanded]:hover) .fznew-options,
:host([expanded]:focus-within) .fznew-options {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 2px 0 4px;
  padding-left: 38px;
}
.fznew-opt {
  appearance: none;
  background: transparent;
  border: none;
  margin: 0;
  font: inherit;
  font-family: var(--ui);
  font-size: 11px;
  font-weight: 500;
  color: var(--txt-3);
  text-align: left;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.fznew-opt:hover { background: var(--ghost); color: var(--ink); }
.fznew-opt:focus-visible { outline: 2px solid var(--ctx); outline-offset: 1px; }
.fznew-opt svg { display: block; flex: 0 0 auto; }

/* .fznew-spinner — busy/pending progress: the badge glyph swaps to a spinning
   lucide loader the moment the new-chat work is kicked off (optimistically on a
   save click, or whenever the host sets the busy attribute), so there is
   immediate feedback before any save/reload completes. */
.fznew-spinner { display: grid; place-items: center; color: var(--ctx); }
.fznew-spinner svg { display: block; animation: slicc-fznew-spin 0.8s linear infinite; }
@keyframes slicc-fznew-spin { to { transform: rotate(360deg); } }

/* Respect prefers-reduced-motion: no fade, no spin — just hold the static end
   state (the loader glyph still shows, it simply does not rotate). */
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
 * lands inside the double-click window is treated as the second click. In
 * expanded mode the three actions are also surfaced as a small directly-clickable
 * legend below the button so the hidden gestures are discoverable — the legend is
 * revealed only on hover / keyboard focus (focus-within), not persistently;
 * collapsed, the press gesture on the badge is the only affordance.
 *
 * On a save activation (and whenever the host sets the `busy` attribute) the
 * badge glyph swaps to a spinning lucide loader, giving immediate "work is
 * happening" feedback before the save + reload completes; the spin is held static
 * under `prefers-reduced-motion: reduce`.
 *
 * @attr expanded - boolean; reveals the fading "New chat" label + the options legend
 * @attr label - the label text / accessible name (default "New chat")
 * @attr busy - boolean; swaps the badge glyph for a spinning loader (entered
 *   optimistically on a save click; also host-drivable)
 * @csspart button - the inner `<button>` element (the `.fznew` node)
 * @csspart badge - the circular `.nico` icon badge
 * @csspart icon - the lucide `<svg>` glyph inside the badge
 * @csspart spinner - the busy-state spinner wrapper around the loader glyph
 * @csspart label - the `.nlbl` text span
 * @csspart options - the `.fznew-options` legend (expanded, hover/focus only)
 * @csspart option-save / option-skip / option-erase - the three legend buttons
 * @slot icon - overrides the default lucide glyph inside the badge
 * @slot - default slot overrides the label text
 * @fires new-chat-save - single click: save + extract memories, then new chat
 * @fires new-chat-skip - double click: new chat without memories (back-filled)
 * @fires new-chat-erase - long press / modifier-click: new chat erasing this one
 */
export class SliccFreezerNew extends HTMLElement {
  static readonly observedAttributes = ['expanded', 'label', 'busy'];

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

  attributeChangedCallback(): void {
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

  #render(): void {
    const label = this.label;
    const busy = this.busy;

    const glyph = busy
      ? h(
          'span',
          { class: 'fznew-spinner', part: 'spinner' },
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
    this.#root.replaceChildren(button, this.#buildOptions());
  }

  /**
   * Build the expanded-mode options legend: three directly-clickable rows, one per
   * gesture outcome. Hidden by CSS unless `[expanded]`.
   */
  #buildOptions(): HTMLElement {
    const wrap = h('div', { class: 'fznew-options', part: 'options' });
    for (const [action, icon, text] of OPTIONS) {
      const optBtn = h(
        'button',
        { class: `fznew-opt fznew-opt--${action}`, part: `option-${action}`, type: 'button' },
        iconEl(icon, { size: 13 }),
        h('span', { class: 'fznew-opt__text' }, text)
      );
      optBtn.addEventListener('click', () => this.#emit(action));
      wrap.appendChild(optBtn);
    }
    return wrap;
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
          this.#emit('skip');
          return;
        }
        this.#emit('erase');
      },
      onShortClick: () => {
        if (this.#pendingShortTimer !== null) {
          this.#clearPendingShort();
          this.#emit('skip');
          return;
        }
        this.#pendingShortTimer = setTimeout(() => {
          this.#pendingShortTimer = null;
          this.#emit('save');
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

  /** Dispatch the composed, bubbling `new-chat-<action>` event. */
  #emit(action: NewChatAction): void {
    // Optimistic progress: a save kicks off a save + memory-extract + reload, so
    // surface the spinner immediately on activation (before the host does any
    // async work / reload). The host may also drive `busy` directly.
    if (action === 'save') this.busy = true;
    this.dispatchEvent(new CustomEvent(`new-chat-${action}`, { bubbles: true, composed: true }));
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
  }
}
