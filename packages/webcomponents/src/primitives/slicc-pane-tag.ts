import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';

/** Recognized pane kinds. Anything else hides the badge. */
const KINDS = ['tool', 'sprinkle'] as const;
type PaneKind = (typeof KINDS)[number];

function isKind(value: string | null): value is PaneKind {
  return value === 'tool' || value === 'sprinkle';
}

/**
 * Styles lifted verbatim from the prototype `.wbhead .ptag` rule (plus its
 * `body.dark` override). The host is hidden until a recognized `kind` is set,
 * mirroring the prototype where `#ptag` starts `display:none` and the workbench
 * JS flips it to `inline-block` once a surface is selected.
 *
 * Dark mode is detected via `:host-context()` against the prototype's
 * `body.dark` convention plus the token-stylesheet `.dark` / `[data-theme]`
 * scopes, so the violet color-mix re-bases off `--canvas` instead of `#fff`.
 */
const STYLE = `
:host { display: none; flex: 0 0 auto; }
:host([kind="tool"]), :host([kind="sprinkle"]) { display: inline-block; }
.ptag {
  font-family: var(--ui);
  font-size: 10px;
  color: var(--violet);
  background: color-mix(in srgb, var(--violet) 12%, #fff);
  border: 1px solid color-mix(in srgb, var(--violet) 30%, var(--line));
  border-radius: 26px;
  padding: 2px 9px;
  flex: 0 0 auto;
}
:host-context(body.dark) .ptag,
:host-context(.dark) .ptag,
:host-context([data-theme="dark"]) .ptag {
  background: color-mix(in srgb, var(--violet) 22%, var(--canvas));
  border-color: color-mix(in srgb, var(--violet) 38%, var(--line));
}
`;

/**
 * `<slicc-pane-tag>` — the violet "kind" badge from the workbench header
 * (`.ptag`). Shows `tool` or `sprinkle` and stays hidden until a recognized
 * `kind` is set. Self-contained shadow DOM; themes via inherited tokens
 * (--violet, --line, --canvas, --ui).
 *
 * @attr kind - `"tool"` | `"sprinkle"`; any other/absent value hides the badge.
 * @csspart tag - the pill element (override padding/radius/color from outside).
 * @slot - optional custom label content; defaults to the `kind` text.
 */
export class SliccPaneTag extends HTMLElement {
  static readonly observedAttributes = ['kind'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** The pane kind (`"tool"` | `"sprinkle"`), or `null` when unset/unrecognized. */
  get kind(): PaneKind | null {
    const value = this.getAttribute('kind');
    return isKind(value) ? value : null;
  }

  set kind(value: PaneKind | string | null) {
    if (value == null) this.removeAttribute('kind');
    else this.setAttribute('kind', value);
  }

  #render(): void {
    const label = this.kind ?? '';
    // A default <slot> lets a host override the label; absent slotted content
    // falls back to the kind text.
    this.#root.innerHTML = `<style>${STYLE}</style><span class="ptag" part="tag"><slot>${escapeHtml(label)}</slot></span>`;
  }
}

define('slicc-pane-tag', SliccPaneTag);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-pane-tag': SliccPaneTag;
  }
}
