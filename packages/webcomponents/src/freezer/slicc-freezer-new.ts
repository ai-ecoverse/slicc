import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';
import { attachLongPressGesture, type LongPressHandle } from '../internal/long-press.js';

const NEW_CHAT_ICON = 'square-pen';

const SPINNER_ICON = 'loader-circle';

const ICON_SIZE = 16;

const DEFAULT_LABEL = 'New chat';

const DOUBLE_CLICK_MS = 350;

const ACTIONS: ReadonlyArray<readonly [SessionAction, string, string]> = [
  ['new-chat-save', 'square-pen', 'New chat — save & extract memories'],
  ['new-chat-skip', 'fast-forward', 'New chat, fast — memories extracted later'],
  ['new-chat-erase', 'trash-2', 'Discard this chat — no freezer, no memories'],
  ['new-cone', 'plus', 'New cone — keep this chat, start another cone'],
  ['drop-cone', 'circle-minus', 'Drop this cone — freeze its chat, no memories'],
];

type NewChatAction = 'save' | 'skip' | 'erase';

type SessionAction = `new-chat-${NewChatAction}` | 'new-cone' | 'drop-cone';

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

  #gesture: LongPressHandle | null = null;

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
    if (name === 'progress' && this.#updateProgressInPlace()) return;
    if (this.isConnected) this.#render();
  }

  get expanded(): boolean {
    return this.hasAttribute('expanded');
  }

  set expanded(value: boolean) {
    this.toggleAttribute('expanded', value);
  }

  get label(): string {
    return this.getAttribute('label') ?? DEFAULT_LABEL;
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  get noSkip(): boolean {
    return this.hasAttribute('no-skip');
  }

  set noSkip(value: boolean) {
    this.toggleAttribute('no-skip', value);
  }

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

  get busy(): boolean {
    return this.hasAttribute('busy');
  }

  set busy(value: boolean) {
    this.toggleAttribute('busy', value);
  }

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

      (btn as HTMLButtonElement).disabled = busy;
      btn.addEventListener('click', () => {
        if (this.busy) return;
        this.#emit(action);
      });
      row.appendChild(btn);
    }
    return row;
  }

  #visibleActions(): ReadonlyArray<readonly [SessionAction, string, string]> {
    const cones = this.cones;
    return ACTIONS.filter(([action]) => {
      if (action === 'new-chat-skip') return !this.noSkip;
      if (action === 'new-cone') return cones !== null;
      if (action === 'drop-cone') return cones !== null && cones > 1;
      return true;
    });
  }

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

  #emit(type: SessionAction): void {
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
