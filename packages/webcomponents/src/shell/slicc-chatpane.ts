import { define } from '../internal/define.js';

/**
 * Scoped, document-level stylesheet for `<slicc-chatpane>`. Light-DOM hosts can't
 * carry an inline `<style>` in a shadow root, so the chrome is injected once into
 * the host document (idempotent) and scoped by the host class `.slicc-chatpane`
 * (added on connect) so it can't leak.
 *
 * Lifted from the prototype (`proto/StellarRubySwift.html` `.chatpane`): the
 * flat, full-bleed chat column of the shell. Unlike the framed tool tiles
 * beside it, the chat column stays FLAT (shadcn-style) — it is just a
 * `flex-direction: column` that stacks the nav + chat thread + composer.
 *
 * Width: the column always fills its container. Since the dock-tree became the
 * sole layout host (the chatpane lives inside a `<slicc-surface>` leaf, and the
 * 48px dock rail is a separate `<slicc-shell>` flex sibling of the tree), the
 * column's width is entirely the tree's business — the shell-era
 * `calc(100% - 48px)` / `34%` widths would double-count the rail and fight the
 * zone sizing. `flex: 1 1 0` + `width: 100%` fill the surface either way
 * (flex item or block child); `min-width: 0` / `min-height: 0` let the inner
 * thread scroll and shrink instead of overflowing the column.
 *
 * The `narrow` host attribute mirrors the prototype's `.shell.open`: it no
 * longer changes the column's width (the dock-tree owns that), but is forwarded
 * as `open` onto the slotted `<slicc-chat-thread>` and `<slicc-composer>`
 * (tightening the thread feather + padding and hiding the composer's keyboard
 * hint) — that forwarding happens in script, not CSS, since those children own
 * their own scoped rules. `<slicc-shell>` toggles it whenever the dock-tree
 * shows any non-chat leaf.
 *
 * Everything is var-driven (`--bg` / `--ink` here; children theme themselves via
 * `--ctx` / `--shaderbg` / `--line` / `--ui`) so dark mode flips automatically
 * via the inherited theme scope — `--bg` darkens with no explicit dark override
 * here. The column also establishes `color: var(--ink)` (the prototype's
 * `body { color: var(--ink) }` cascade): the slotted thread/agent prose inherit
 * it rather than setting their own, so in dark mode the agent text resolves to
 * the bright `--ink` for strong contrast against the dark `--bg`.
 */
const STYLE = `
.slicc-chatpane {
  flex: 1 1 0;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  font-family: var(--ui);
  color: var(--ink);
  background: var(--bg);
}
.slicc-chatpane[hidden] {
  display: none;
}
/* The reading column is background-free in every layout (the frosted card was
   dropped — the shader renders low-contrast instead). In the narrow column the
   inner keeps the SAME centered, capped reading width as the wide layout: the
   narrow attribute is set whenever the workbench opens on ANY screen size, so
   full-bleeding here stretched the text on wide screens too. The genuinely
   full-bleed width:100% / max-width:none treatment now lives ONLY in the
   overlay layout — slicc-chat-thread's own @media (max-width: 560px) rule, the
   same breakpoint that turns the workbench into a full-screen overlay — so
   opening the rail on a wide screen no longer changes the reading-column width.
   The min-height is still the FULL viewport (not the parent's 100%) so a
   freezer / scoop with little history still fills to the bottom of the screen
   instead of ending abruptly partway down — messages stay top-aligned and the
   filler space sits below; long histories still scroll. The 100vh declaration
   is the fallback for engines without dynamic-viewport units; the 100dvh
   override tracks mobile browser chrome (URL bar) collapse. */
.slicc-chatpane[narrow] .slicc-thread__inner {
  min-height: 100vh;
  min-height: 100dvh;
  background: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-radius: 0;
  -webkit-mask-image: none;
  mask-image: none;
}
`;

const STYLE_ID = 'slicc-chatpane-style';

/** Inject the scoped chatpane stylesheet into a document once (idempotent). */
function ensureChatpaneStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Child tags whose own narrow variant is driven by an `open` attribute. */
const OPEN_FORWARD_TAGS = ['slicc-chat-thread', 'slicc-composer'] as const;

/**
 * `<slicc-chatpane>` — the flat, full-bleed chat column of the shell from
 * the prototype (`.chatpane`). A `flex-direction: column` host that stacks — in
 * DOM order — an optional top `<slicc-nav>`, the `<slicc-chat-thread>`, and the
 * `<slicc-composer>`, composing each BY TAG (it never imports or reaches into
 * them). It always fills its container (`flex: 1 1 0` / `width: 100%`) — the
 * dock-tree leaf it lives in owns the column's width.
 *
 * Light DOM (no shadow root): the host IS the column, so its children lay out
 * directly inside it (DOM order is layout order) — there is no inner wrapper to
 * relocate into. Children declared before the element upgrades are kept in place;
 * the scoped stylesheet is injected once into the host document and scoped by the
 * `.slicc-chatpane` host class so it can't leak.
 *
 * The `narrow` boolean attribute mirrors `.shell.open`: it is forwarded in
 * script as the `open` attribute onto the slotted `<slicc-chat-thread>` +
 * `<slicc-composer>` so they switch to their own narrow variants (tighter
 * thread feather/padding; the composer hides its keyboard hint). Forwarding
 * re-runs whenever the column's direct children change, so a thread/composer
 * added later still inherits the current state.
 *
 * @attr narrow - boolean; narrow-chat variant (forwards `open` to the
 *   thread/composer + the thread inner fills full width/height with its
 *   frosted background dropped), mirrors `.shell.open .chatpane`
 * @csspart pane - the column (the host element itself carries `part="pane"`)
 * @slot - default; the column's children in DOM order: an optional `<slicc-nav>`,
 *   then `<slicc-chat-thread>`, then `<slicc-composer>`, composed by tag
 * @fires slicc-chatpane-narrow-change - `CustomEvent<{ narrow: boolean }>`,
 *   composed + bubbling, dispatched whenever the `narrow` state changes
 */
export class SliccChatpane extends HTMLElement {
  static readonly observedAttributes = ['narrow'];

  #observer: MutationObserver | null = null;
  #built = false;

  connectedCallback(): void {
    ensureChatpaneStyle(this.ownerDocument);
    this.classList.add('slicc-chatpane');
    this.setAttribute('part', 'pane');
    this.#built = true;
    this.#forwardNarrow();
    this.#observe();
  }

  disconnectedCallback(): void {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== 'narrow' || oldValue === newValue) return;
    if (!this.isConnected) return;
    this.#forwardNarrow();
    this.dispatchEvent(
      new CustomEvent<{ narrow: boolean }>('slicc-chatpane-narrow-change', {
        detail: { narrow: this.narrow },
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * Whether the narrow-chat variant is active: the column shrinks to 34% and the
   * `open` flag is forwarded to the slotted thread + composer. Mirrors the
   * prototype's `.shell.open .chatpane`.
   */
  get narrow(): boolean {
    return this.hasAttribute('narrow');
  }

  set narrow(value: boolean) {
    if (value) this.setAttribute('narrow', '');
    else this.removeAttribute('narrow');
  }

  /** The slotted `<slicc-nav>` header, if one was composed at the top. */
  get nav(): HTMLElement | null {
    return this.querySelector(':scope > slicc-nav');
  }

  /** The slotted `<slicc-chat-thread>`, if present. */
  get thread(): HTMLElement | null {
    return this.querySelector(':scope > slicc-chat-thread');
  }

  /** The slotted `<slicc-composer>`, if present. */
  get composer(): HTMLElement | null {
    return this.querySelector(':scope > slicc-composer');
  }

  /**
   * Forward the column's `narrow` state to the slotted thread + composer as their
   * own `open` attribute (they own the narrow feather/padding + hidden-hint
   * rules). A no-op before the host is connected.
   */
  #forwardNarrow(): void {
    if (!this.#built) return;
    const narrow = this.narrow;
    for (const tag of OPEN_FORWARD_TAGS) {
      for (const child of this.querySelectorAll(`:scope > ${tag}`)) {
        if (narrow) child.setAttribute('open', '');
        else child.removeAttribute('open');
      }
    }
  }

  /**
   * Watch for direct children being added so a thread/composer slotted after the
   * host upgrades still inherits the current `narrow` → `open` state. Scoped to
   * the host's own child list (not the deep subtree) to stay cheap.
   */
  #observe(): void {
    if (this.#observer) return;
    this.#observer = new MutationObserver(() => this.#forwardNarrow());
    this.#observer.observe(this, { childList: true });
  }
}

define('slicc-chatpane', SliccChatpane);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-chatpane': SliccChatpane;
  }
  interface HTMLElementEventMap {
    'slicc-chatpane-narrow-change': CustomEvent<{ narrow: boolean }>;
  }
}
