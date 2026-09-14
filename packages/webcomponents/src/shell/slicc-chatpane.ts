import { define } from '../internal/define.js';

const STYLE = `
.slicc-chatpane {
  flex: 1 1 0;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  /* The anchor for column-pinned chrome — today the keyboard-mode HUD, which
     sits on the column's bottom edge rather than the composer's so it survives
     a read-only unit hiding the whole band (#2312). Nothing else resolves
     here: the composer and the capture surface are positioned themselves, so
     they keep their own anchors. */
  position: relative;
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

function ensureChatpaneStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const OPEN_FORWARD_TAGS = ['slicc-chat-thread', 'slicc-composer'] as const;

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

  get narrow(): boolean {
    return this.hasAttribute('narrow');
  }

  set narrow(value: boolean) {
    if (value) this.setAttribute('narrow', '');
    else this.removeAttribute('narrow');
  }

  get nav(): HTMLElement | null {
    return this.querySelector(':scope > slicc-nav');
  }

  get thread(): HTMLElement | null {
    return this.querySelector(':scope > slicc-chat-thread');
  }

  get composer(): HTMLElement | null {
    return this.querySelector(':scope > slicc-composer');
  }

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
