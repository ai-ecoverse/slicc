import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * One follower row, already formatted by the caller. The component is
 * deliberately presentational: the leader's `ConnectedFollowerInfo` lives in
 * `@slicc/webapp` (a layer above), so the webapp maps it to these rows via
 * `ui/follower-presentation.ts` and the component never learns tray types.
 */
export interface FollowerHudRow {
  /** Stable row key — the follower's runtime id. */
  id: string;
  /** Lucide icon name for the follower kind (`smartphone`, `terminal`, …). */
  icon: string;
  /** Primary line, e.g. `iOS · phone-a1b2c3`. */
  title: string;
  /** Secondary line — the follower's MOTD or runtime tag. */
  detail?: string;
  /** Dot color: live, stalled/warning, or connecting/idle. */
  state: 'active' | 'warn' | 'idle';
  /** Right-aligned status text, e.g. `connected 4m`. */
  stateText: string;
  /** Capability chips, e.g. `can run commands`. */
  chips?: string[];
}

const STYLE = `
:host {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 100;
  display: block;
  pointer-events: none;
}
:host([open]) { pointer-events: auto; }

.card {
  display: none;
  flex-direction: column;
  min-width: 240px;
  max-width: 340px;
  background: var(--canvas);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  font-family: var(--ui);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ink);
  max-height: calc(100vh - 64px);
  overflow-x: hidden;
  overflow-y: auto;
}

:host([open]) .card { display: flex; }

.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.section-title {
  font-size: 9px;
  text-transform: uppercase;
  color: var(--txt-2);
  font-weight: 600;
  letter-spacing: 0.5px;
}

.row {
  display: grid;
  grid-template-columns: 16px 1fr auto;
  align-items: start;
  gap: 8px;
}

.row svg {
  display: block;
  width: 14px;
  height: 14px;
  margin-top: 1px;
  color: var(--txt-2);
}

.row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

.row-title {
  font-weight: 500;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-detail {
  color: var(--txt-2);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }

.chip {
  padding: 1px 6px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--ctx) 45%, transparent);
  color: var(--txt-2);
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.row-state {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--txt-2);
  font-size: 11px;
  white-space: nowrap;
}

.sdot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #22c55e;
}
.sdot[data-state='warn'] { background: #f59e0b; }
.sdot[data-state='idle'] { background: var(--txt-2); }

.empty { color: var(--txt-2); padding: 12px; }

.hint {
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  color: var(--txt-2);
  font-size: 11px;
}
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-follower-hud>` — a floating card listing the followers attached to
 * this leader. Anchored below its parent (the floatbar's followers segment)
 * and toggled with the `open` boolean attribute, mirroring
 * `<slicc-cost-overlay>`'s hover mechanics.
 *
 * Read-only by design: the HUD answers "who is on this session?" at a glance,
 * and the sync dialog's Status tab owns the actions.
 *
 * @attr open - boolean; shows the card when present
 * @property rows - array of {@link FollowerHudRow} — one per connected follower
 * @property hint - optional footer line (e.g. "Click for details")
 * @csspart card - the floating card surface
 * @csspart row - a single follower row
 */
export class SliccFollowerHud extends HTMLElement {
  static readonly observedAttributes = ['open'];

  readonly #root: ShadowRoot;
  #rows: FollowerHudRow[] = [];
  #hint: string | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** Whether the card is visible. */
  get open(): boolean {
    return this.hasAttribute('open');
  }

  set open(value: boolean) {
    this.toggleAttribute('open', !!value);
  }

  /** The follower rows to render. */
  get rows(): FollowerHudRow[] {
    return this.#rows;
  }

  set rows(value: FollowerHudRow[]) {
    this.#rows = value;
    if (this.isConnected) this.#render();
  }

  /** Optional footer hint line. */
  get hint(): string | null {
    return this.#hint;
  }

  set hint(value: string | null) {
    this.#hint = value && value.trim() !== '' ? value : null;
    if (this.isConnected) this.#render();
  }

  #render(): void {
    const count = this.#rows.length;
    const children: Node[] = [];

    if (count === 0) {
      children.push(h('div', { class: 'empty' }, 'No followers connected.'));
    } else {
      const rows = this.#rows.map((row) =>
        h(
          'div',
          { class: 'row', part: 'row' },
          iconEl(row.icon, { size: 14 }),
          h(
            'div',
            { class: 'row-main' },
            h('span', { class: 'row-title' }, row.title),
            row.detail ? h('span', { class: 'row-detail' }, row.detail) : false,
            row.chips && row.chips.length > 0
              ? h(
                  'div',
                  { class: 'chips' },
                  ...row.chips.map((chip) => h('span', { class: 'chip' }, chip))
                )
              : false
          ),
          h(
            'div',
            { class: 'row-state' },
            h('span', { class: 'sdot', 'data-state': row.state }),
            row.stateText
          )
        )
      );
      children.push(
        h(
          'div',
          { class: 'section' },
          h(
            'div',
            { class: 'section-title' },
            `${count} ${count === 1 ? 'follower' : 'followers'}`
          ),
          ...rows
        )
      );
    }

    if (this.#hint) children.push(h('div', { class: 'hint' }, this.#hint));

    this.#root.replaceChildren(h('div', { class: 'card', part: 'card' }, ...children));
  }
}

define('slicc-follower-hud', SliccFollowerHud);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-follower-hud': SliccFollowerHud;
  }
}
