import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';

/**
 * Scoped, document-level stylesheet for `<slicc-agent-message>`. Lifted verbatim
 * from the prototype (proto/StellarRubySwift.html) bot-message chrome:
 * `.msg.bot .body` prose, the colored-dot `.plan` list, the rounded check-badge
 * `.check` list, the three bouncing `.thinkrow .dots`, and the typewriter
 * `.tw-caret`. Light-DOM components cannot carry an inline `<style>` in a shadow
 * root, so the chrome is injected once into the host document (idempotent) and
 * selected by the `slicc-agent-message` tag. Everything is var-driven
 * (--ink / --ghost / --mono + the fixed accent hues --rose/--cyan/--violet/--amber)
 * so dark mode flips automatically via the inherited theme scope — no explicit
 * dark override is needed.
 */
const STYLE = `
slicc-agent-message { display: block; margin-bottom: 18px; font-size: 15px; line-height: 1.5; }
slicc-agent-message .body { font-size: 14px; }
slicc-agent-message .body p { margin: 0 0 8px; }
slicc-agent-message strong { font-weight: 600; }
slicc-agent-message code { font-family: var(--mono); font-size: 12.5px; background: var(--ghost); border-radius: 6px; padding: 1px 6px; }
slicc-agent-message .plan { list-style: none; margin: 4px 0 0; padding: 0; }
slicc-agent-message .plan li { position: relative; padding-left: 20px; margin: 5px 0; font-size: 14px; }
slicc-agent-message .plan li::before { content: ""; position: absolute; left: 4px; top: 8px; width: 6px; height: 6px; border-radius: 50%; }
slicc-agent-message .plan li:nth-child(1)::before { background: var(--rose); }
slicc-agent-message .plan li:nth-child(2)::before { background: var(--violet); }
slicc-agent-message .plan li:nth-child(3)::before { background: var(--cyan); }
slicc-agent-message .check { list-style: none; margin: 6px 0 0; padding: 0; }
slicc-agent-message .check li { display: flex; align-items: center; gap: 9px; font-size: 13.5px; margin: 6px 0; }
slicc-agent-message .check li .ck { width: 18px; height: 18px; border-radius: 50%; background: #1a7f37; color: #fff; display: grid; place-items: center; font-size: 11px; flex: 0 0 auto; }
slicc-agent-message .check li .ck.r { background: var(--rose); }
slicc-agent-message .check li .ck.cy { background: var(--cyan); }
slicc-agent-message .check li .ck.vi { background: var(--violet); }
slicc-agent-message .check li .ck.am { background: var(--amber); }
slicc-agent-message .thinkrow { margin-bottom: 14px; }
slicc-agent-message .dots { display: inline-flex; gap: 7px; align-items: flex-end; padding: 6px 2px; }
slicc-agent-message .dots i { width: 9px; height: 9px; border-radius: 50%; background: var(--d); animation: slicc-am-bdot 1.05s infinite ease-in-out; }
slicc-agent-message .dots i:nth-child(2) { animation-delay: .16s; }
slicc-agent-message .dots i:nth-child(3) { animation-delay: .32s; }
@keyframes slicc-am-bdot { 0%, 75%, 100% { transform: translateY(0); opacity: .45; } 38% { transform: translateY(-8px); opacity: 1; } }
slicc-agent-message .tw-caret { display: inline-block; width: 2px; height: 1.05em; vertical-align: -2px; margin-left: 1px; background: var(--ink); animation: slicc-am-cblink .9s steps(1) infinite; }
@keyframes slicc-am-cblink { 50% { opacity: 0; } }
`;

const STYLE_ID = 'slicc-agent-message-style';

/** Inject the scoped agent-message stylesheet into a document once (idempotent). */
function ensureMessageStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** The fixed thinking-dot hues, in prototype order (rose, cyan, violet). */
const THINK_DOT_HUES = ['#f43f5e', '#06b6d4', '#8b5cf6'] as const;

/** Check-badge accent variants — `''` is the default green `.ck`. */
export type CheckVariant = '' | 'r' | 'cy' | 'vi' | 'am';

/** A single `.check` row: a check badge (with optional accent) and its text. */
export interface CheckItem {
  /** Row text. */
  text: string;
  /** Badge accent: default green, or rose/cyan/violet/amber. */
  variant?: CheckVariant;
  /** Glyph inside the badge (default a check mark). */
  glyph?: string;
}

const CHECK_VARIANTS: ReadonlySet<string> = new Set(['', 'r', 'cy', 'vi', 'am']);

/** Build the bouncing three-dot thinking row (rose / cyan / violet) as a live node. */
function thinkRowEl(): HTMLElement {
  const dots = h('div', { class: 'dots', part: 'dots', 'aria-hidden': 'true' });
  for (const hue of THINK_DOT_HUES) dots.append(h('i', { style: `--d:${hue}` }));
  return dots;
}

/** Build a `ul.plan` from plain strings; the first three bullets cycle rose/violet/cyan. */
function planEl(items: readonly string[]): HTMLElement {
  const ul = h('ul', { class: 'plan', part: 'plan' });
  for (const text of items) ul.append(h('li', null, text));
  return ul;
}

/** Build a `ul.check` with per-row check badges (`.ck` + optional `.r/.cy/.vi/.am`). */
function checkEl(items: readonly CheckItem[]): HTMLElement {
  const ul = h('ul', { class: 'check', part: 'check' });
  for (const item of items) {
    const variant = item.variant && CHECK_VARIANTS.has(item.variant) ? item.variant : '';
    const cls = variant ? `ck ${variant}` : 'ck';
    const glyph = item.glyph ?? '✓';
    ul.append(
      h('li', null, h('span', { class: cls }, glyph), h('span', { class: 'ctext' }, item.text))
    );
  }
  return ul;
}

/**
 * `<slicc-agent-message>` — the prototype's agent (bot) chat message
 * (`.msg.bot`): a block of rich prose (`.body`) optionally carrying a
 * colored-dot `.plan` list or a rounded check-badge `.check` list, with a
 * pre-message thinking state (`.thinkrow` — three bouncing rose/cyan/violet
 * dots) and a streaming typewriter caret (`.tw-caret`).
 *
 * Light DOM (no shadow root) so the host app can style it and so the `.body`
 * can host already-rendered markdown HTML supplied as slotted children (the
 * marked/DOMPurify pipeline is deferred to wire-in). On connect the host builds
 * its `.body` scaffold and relocates any pre-existing light children into it,
 * preserving slotted prose. While `thinking` the body is hidden and the
 * `.thinkrow` dots show in its place; clearing `thinking` reveals the typed
 * body, faithful to the prototype's think→type handoff.
 *
 * @attr thinking - boolean; show the bouncing-dot thinking row instead of the body
 * @attr streaming - boolean; append a blinking typewriter caret to the body
 * @csspart body - the prose region that hosts slotted markdown HTML
 * @csspart dots - the three bouncing thinking dots
 * @csspart caret - the typewriter streaming caret
 * @csspart plan - the colored-dot plan list (when populated via `setPlan`)
 * @csspart check - the check-badge list (when populated via `setCheck`)
 * @slot - default; rich prose / rendered markdown HTML for the body
 * @fires slicc-agent-message-thinking - composed + bubbling; `detail.thinking` on state change
 * @fires slicc-agent-message-streaming - composed + bubbling; `detail.streaming` on state change
 */
export class SliccAgentMessage extends HTMLElement {
  static readonly observedAttributes = ['thinking', 'streaming'];

  #body!: HTMLElement;
  #dots: HTMLElement | null = null;
  #caret: HTMLElement | null = null;
  #built = false;

  connectedCallback(): void {
    ensureMessageStyle(this.ownerDocument);
    this.#build();
    this.#syncThinking();
    this.#syncStreaming();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || !this.isConnected) return;
    if (name === 'thinking') {
      this.#syncThinking();
      this.dispatchEvent(
        new CustomEvent('slicc-agent-message-thinking', {
          bubbles: true,
          composed: true,
          detail: { thinking: newValue !== null },
        })
      );
    } else if (name === 'streaming') {
      this.#syncStreaming();
      this.dispatchEvent(
        new CustomEvent('slicc-agent-message-streaming', {
          bubbles: true,
          composed: true,
          detail: { streaming: newValue !== null },
        })
      );
    }
  }

  /** Whether the bouncing-dot thinking row is shown in place of the body. */
  get thinking(): boolean {
    return this.hasAttribute('thinking');
  }

  set thinking(value: boolean) {
    if (value) this.setAttribute('thinking', '');
    else this.removeAttribute('thinking');
  }

  /** Whether the blinking typewriter caret trails the body. */
  get streaming(): boolean {
    return this.hasAttribute('streaming');
  }

  set streaming(value: boolean) {
    if (value) this.setAttribute('streaming', '');
    else this.removeAttribute('streaming');
  }

  /** The prose body element (`.body`); hosts slotted/rendered markdown HTML. */
  get body(): HTMLElement {
    this.#build();
    return this.#body;
  }

  /**
   * Replace the body content with already-rendered (trusted) HTML. The
   * marked/DOMPurify sanitization pipeline is deferred to wire-in — callers are
   * responsible for sanitizing untrusted input before passing it here. The
   * trusted string is parsed into nodes via a contextual fragment (no HTML
   * sink) so the body is committed purely by DOM construction.
   */
  setBodyHtml(html: string): void {
    this.#build();
    const range = this.ownerDocument.createRange();
    range.selectNodeContents(this.#body);
    this.#setBody(range.createContextualFragment(html));
  }

  /**
   * Render a colored-dot `.plan` list into the body (the first three bullets
   * cycle rose / violet / cyan, per the prototype). Replaces existing body
   * content.
   */
  setPlan(items: readonly string[]): void {
    this.#setBody(planEl(items));
  }

  /**
   * Render a rounded check-badge `.check` list into the body. Each row's badge
   * defaults to green `.ck`; pass `variant` (`r`/`cy`/`vi`/`am`) to tint it.
   * Replaces existing body content.
   */
  setCheck(items: readonly CheckItem[]): void {
    this.#setBody(checkEl(items));
  }

  /** Replace the body subtree with the given node(s) and re-sync the caret. */
  #setBody(content: Node): void {
    this.#build();
    this.#body.replaceChildren(content);
    this.#syncStreaming();
  }

  /**
   * Build the `.msg.bot` scaffold once and relocate any pre-existing light
   * children into the `.body`. Idempotent — safe across re-connects.
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;

    // Host element IS the .msg.bot block — tag it without clobbering host classes.
    this.classList.add('msg', 'bot');

    // Collect children that existed before we owned the subtree.
    const incoming = Array.from(this.childNodes).filter(
      (n) => !(n instanceof HTMLElement && n.classList.contains('body'))
    );

    this.#body = this.ownerDocument.createElement('div');
    this.#body.className = 'body';
    this.#body.setAttribute('part', 'body');

    for (const node of incoming) this.#body.appendChild(node);

    this.appendChild(this.#body);
  }

  /** Show the thinking dots (and `.thinkrow` host class) or the body. */
  #syncThinking(): void {
    const thinking = this.thinking;
    this.classList.toggle('thinkrow', thinking);
    if (thinking) {
      this.#body.style.display = 'none';
      if (!this.#dots) {
        this.#dots = thinkRowEl();
        this.insertBefore(this.#dots, this.#body);
      }
    } else {
      this.#body.style.removeProperty('display');
      if (this.#dots) {
        this.#dots.remove();
        this.#dots = null;
      }
    }
  }

  /** Add/remove the trailing typewriter caret to match the streaming state. */
  #syncStreaming(): void {
    if (this.streaming) {
      if (!this.#caret?.isConnected) {
        this.#caret = this.ownerDocument.createElement('span');
        this.#caret.className = 'tw-caret';
        this.#caret.setAttribute('part', 'caret');
        this.#caret.setAttribute('aria-hidden', 'true');
        this.#body.appendChild(this.#caret);
      } else {
        // Keep the caret last after a body re-render.
        this.#body.appendChild(this.#caret);
      }
    } else if (this.#caret) {
      this.#caret.remove();
      this.#caret = null;
    }
  }
}

define('slicc-agent-message', SliccAgentMessage);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-agent-message': SliccAgentMessage;
  }
}
